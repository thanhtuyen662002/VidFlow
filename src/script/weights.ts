import type { DatabaseSync } from 'node:sqlite';
export const defaultWeights = { hook: 1, clarity: 1, emotion: 1, value: 1, retention: 1, feasibility: 1, policy: 1 };
export type Weights = typeof defaultWeights;
export function initializeWeights(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS script_weights (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS analytics_proposals (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL)`);
}
export function getWeights(db: DatabaseSync, projectId: string): Weights {
  initializeWeights(db);
  const row = db.prepare('SELECT data FROM script_weights WHERE project_id=?').get(projectId);
  return row ? JSON.parse(String(row.data)) : { ...defaultWeights };
}
