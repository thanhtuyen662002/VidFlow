import type { DatabaseSync } from 'node:sqlite';

export const AWAITING_BUDGET_APPROVAL = 'cho_duyet_ngan_sach';

/** Called inside the dispatch transaction, before enqueue/claim. Reservations
 * remain after completion: an unmetered driver must not free spent allowance. */
export function projectCommittedCredits(db: DatabaseSync, projectId: string): number {
  return Number(db.prepare(`SELECT COALESCE(SUM(cost),0) AS total FROM (
    SELECT MAX(r.credits, COALESCE((SELECT SUM(MAX(0,-COALESCE(l.amount,l.delta,-l.credits)))
      FROM credit_ledger l WHERE l.job_id=r.job_id OR l.render_job_id=r.job_id),0)) AS cost
    FROM render_credit_reservations r WHERE r.project_id=?
    UNION ALL
    SELECT MAX(0,-COALESCE(l.amount,l.delta,-l.credits)) FROM credit_ledger l
    LEFT JOIN render_jobs j ON j.id=COALESCE(l.job_id,l.render_job_id)
    WHERE COALESCE(l.project_id,j.project_id)=? AND NOT EXISTS (
      SELECT 1 FROM render_credit_reservations r WHERE r.job_id=COALESCE(l.job_id,l.render_job_id))
  )`).get(projectId, projectId)!.total);
}

export function canDispatch(db: DatabaseSync, projectId: string, credits: number): boolean {
  const project = db.prepare('SELECT budget FROM projects WHERE id=?').get(projectId);
  if (!project) throw new Error('Project not found');
  if (project.budget == null || projectCommittedCredits(db, projectId) + credits <= Number(project.budget)) return true;
  db.prepare('UPDATE projects SET status=? WHERE id=?').run(AWAITING_BUDGET_APPROVAL, projectId);
  return false;
}
