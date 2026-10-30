import { readdirSync, statSync, unlinkSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { relative } from 'node:path';
import { resolveInside, dataDirectory } from '../paths.ts';
import { assertInsideDataDir } from '../media/paths.ts';
import { probe } from '../media/probe.ts';
import { createTake } from '../repo/renders.ts';
import { createAsset } from '../repo/assets.ts';
import { MediaToolNotFoundError, MediaToolTimeoutError } from '../media/errors.ts';

/** Startup only: the caller must have stopped all other workers before recovery. */
export async function recoverInterruptedJobs(db: DatabaseSync,
  duration: (file: string) => Promise<number> = async file => (await probe(file)).durationSec) {
  // Inspect files and probe media before taking the write lock. Startup recovery
  // requires exclusive worker ownership, but readers may still inspect progress.
  const inspected = [];
  for (const job of db.prepare("SELECT * FROM render_jobs WHERE status='running' AND payload IS NOT NULL").all()) {
    const payload = JSON.parse(String(job.payload));
    let media: { path: string; kind: string; bytes: number }[] = [];
    let seconds = 0;
    if (payload.outputDir) {
      const directory = assertInsideDataDir(payload.outputDir, dataDirectory());
      let names: string[] = [];
      try { names = readdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for (const name of names) {
        if (!name.startsWith(`${job.id}_${payload.takeIndex ?? 0}.`)) continue;
        const file = resolveInside(directory, name);
        if (name.endsWith('.partial')) { unlinkSync(file); continue; }
        if (!/\.(mp4|webm|mov)$/i.test(name)) continue;
        try {
          const info = statSync(file);
          seconds = info.isFile() && info.size > 0 ? await duration(file) : 0;
          if (!(seconds > 0) || !Number.isFinite(seconds)) throw new Error('Incomplete media');
          media = [{ path: file, kind: 'video', bytes: info.size }];
        } catch (error) {
          // Missing tools or an unavailable subprocess cannot establish corruption.
          if (error instanceof MediaToolNotFoundError || error instanceof MediaToolTimeoutError ||
            ['EPERM', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
          unlinkSync(file);
        }
      }
    }
    inspected.push({ job, media, seconds });
  }
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    for (const { job, media, seconds } of inspected) {
      if (db.prepare('SELECT status FROM render_jobs WHERE id=?').get(job.id)?.status !== 'running') continue;
      if (media.length) {
        if (job.scene_id && !db.prepare('SELECT id FROM takes WHERE render_job_id=?').get(job.id))
          createTake(db, { renderJobId: String(job.id), sceneId: String(job.scene_id), file: media[0].path, durationSec: seconds });
        else if (!job.scene_id && job.project_id) {
          const project = db.prepare('SELECT directory FROM projects WHERE id=?').get(job.project_id);
          if (project) {
            const relPath = relative(String(project.directory), media[0].path).replaceAll('\\', '/');
            if (!db.prepare('SELECT id FROM assets WHERE project_id=? AND rel_path=?').get(job.project_id, relPath))
              createAsset(db, { projectId: String(job.project_id), kind: 'video', relPath, sizeBytes: media[0].bytes });
          }
        }
        db.prepare("UPDATE render_jobs SET status='done',output_media=?,finished_at=?,worker_id=NULL WHERE id=?")
          .run(JSON.stringify(media), new Date().toISOString(), job.id);
      } else db.prepare("UPDATE render_jobs SET status='queued',worker_id=NULL,claimed_at=NULL,payload=json_set(payload,'$.interruptedRecovery',json('true')) WHERE id=?").run(job.id);
    }
    db.prepare("UPDATE render_plan_steps SET status='ready' WHERE status='running'").run();
    db.exec('COMMIT');
    committed = true;
  } finally { if (!committed) db.exec('ROLLBACK'); }
}
