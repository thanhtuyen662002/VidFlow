import type { DatabaseSync } from 'node:sqlite';

/** Extend M1 tables without changing legacy repository columns or rows. */
export function upgradeFlowQueue(db: DatabaseSync): void {
  db.exec(`CREATE TABLE flow_accounts (
    id TEXT PRIMARY KEY REFERENCES accounts(id), label TEXT NOT NULL, email TEXT,
    status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','out_of_credit','needs_owner','disabled')),
    status_reason TEXT, updated_at TEXT NOT NULL, created_at TEXT NOT NULL
  );`);
  // Rebuild with the same name: dependent foreign keys keep pointing to it.
  // Save cascading children first, and restore them before the transaction commits.
  db.exec(`CREATE TEMP TABLE flow_saved_takes AS SELECT * FROM takes;
    CREATE TEMP TABLE flow_saved_selections AS SELECT * FROM selections;
    CREATE TEMP TABLE flow_saved_ledger AS SELECT * FROM credit_ledger;`);
  const schema = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='render_jobs'").get()!.sql)
    .replace('CREATE TABLE render_jobs', 'CREATE TABLE flow_jobs_upgrade')
    .replace('project_id TEXT NOT NULL', 'project_id TEXT')
    .replace('type TEXT NOT NULL', "type TEXT NOT NULL DEFAULT 'video'")
    .replace('model TEXT NOT NULL', "model TEXT NOT NULL DEFAULT 'fast'")
    .replace('prompt TEXT NOT NULL', "prompt TEXT NOT NULL DEFAULT ''")
    .replace("DEFAULT 'pending'", "DEFAULT 'queued'")
    .replace("'succeeded','failed','cancelled'", "'succeeded','failed','cancelled','done','rejected'");
  db.exec(schema);
  db.exec(`INSERT INTO flow_jobs_upgrade SELECT * FROM render_jobs;
    DROP TABLE render_jobs;
    ALTER TABLE flow_jobs_upgrade RENAME TO render_jobs;
    INSERT INTO takes SELECT * FROM flow_saved_takes;
    INSERT INTO selections SELECT * FROM flow_saved_selections;
    UPDATE credit_ledger SET render_job_id=(SELECT render_job_id FROM flow_saved_ledger WHERE id=credit_ledger.id);
    DROP TABLE flow_saved_takes; DROP TABLE flow_saved_selections; DROP TABLE flow_saved_ledger;
    ALTER TABLE render_jobs ADD COLUMN payload TEXT CHECK(payload IS NULL OR json_valid(payload));
    ALTER TABLE render_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE render_jobs ADD COLUMN worker_id TEXT;
    ALTER TABLE render_jobs ADD COLUMN claimed_at TEXT;
    ALTER TABLE render_jobs ADD COLUMN finished_at TEXT;
    ALTER TABLE render_jobs ADD COLUMN flow_status_check INTEGER CHECK(payload IS NULL OR status IN ('queued','running','done','rejected','failed'));
    CREATE INDEX render_queue ON render_jobs(status, priority, created_at);
    CREATE TRIGGER flow_job_account_insert BEFORE INSERT ON render_jobs
    WHEN NEW.payload IS NOT NULL AND NEW.account_id IS NOT NULL
    BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM flow_accounts WHERE id=NEW.account_id) THEN RAISE(ABORT,'Flow account required') END; END;
    CREATE TRIGGER flow_job_account_update BEFORE UPDATE OF account_id,payload ON render_jobs
    WHEN NEW.payload IS NOT NULL AND NEW.account_id IS NOT NULL
    BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM flow_accounts WHERE id=NEW.account_id) THEN RAISE(ABORT,'Flow account required') END; END;
  `);
  const ledgerSchema = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='credit_ledger'").get()!.sql)
    .replace('CREATE TABLE credit_ledger', 'CREATE TABLE flow_ledger_upgrade')
    .replace('project_id TEXT NOT NULL', 'project_id TEXT')
    .replace('credits REAL NOT NULL', 'credits REAL NOT NULL DEFAULT 0');
  db.exec(ledgerSchema);
  db.exec(`INSERT INTO flow_ledger_upgrade SELECT * FROM credit_ledger;
    DROP TRIGGER account_ledger_delete;
    DROP TABLE credit_ledger;
    ALTER TABLE flow_ledger_upgrade RENAME TO credit_ledger;
    -- NULL amount/payload identifies M1 rows, preserving its existing APIs.
    ALTER TABLE credit_ledger ADD COLUMN amount INTEGER CHECK(amount IS NULL OR (typeof(amount)='integer' AND length(trim(reason))>0 AND account_id IS NOT NULL));
    ALTER TABLE credit_ledger ADD COLUMN job_id TEXT REFERENCES render_jobs(id);
    CREATE INDEX ledger_project ON credit_ledger(project_id);
    CREATE INDEX ledger_account ON credit_ledger(account_id);
    CREATE TRIGGER account_ledger_delete BEFORE DELETE ON accounts
    WHEN EXISTS(SELECT 1 FROM credit_ledger WHERE account_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'Account still has ledger entries'); END;
    CREATE TRIGGER flow_credit_account BEFORE INSERT ON credit_ledger WHEN NEW.amount IS NOT NULL
    BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM flow_accounts WHERE id=NEW.account_id) THEN RAISE(ABORT,'Flow account required') END; END;
    CREATE TRIGGER flow_credit_no_update BEFORE UPDATE ON credit_ledger WHEN OLD.amount IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'Credit ledger is append only'); END;
    CREATE TRIGGER flow_credit_no_delete BEFORE DELETE ON credit_ledger WHEN OLD.amount IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'Credit ledger is append only'); END;
    CREATE TRIGGER flow_account_no_delete BEFORE DELETE ON flow_accounts
    WHEN EXISTS(SELECT 1 FROM credit_ledger WHERE account_id=OLD.id AND amount IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'Account has ledger entries'); END;
  `);
}
