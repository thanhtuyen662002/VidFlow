import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, unlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { dataDirectory, resolveInside } from '../paths.ts';
import { assertInsideDataDir } from '../media/paths.ts';
import { backup, restore, readBackupManifest, BACKUP_EXCLUSIONS, isBackupExcluded } from './archive.ts';

export { backup, restore, readBackupManifest, BACKUP_EXCLUSIONS, isBackupExcluded };
export interface CleanupTake { takeId: string; sceneId: string; path: string; size: number; sha256: string }
export interface CleanupPlan { projectId: string; dataDir: string; takes: CleanupTake[]; totalSize: number; confirmation: string }
const signingKey = randomBytes(32);
function signature(value: Omit<CleanupPlan, 'confirmation'>): string {
  return createHmac('sha256', signingKey).update(JSON.stringify(value)).digest('hex');
}
function table(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function fileHash(file: string): string {
  const fd = openSync(file, 'r'), buffer = Buffer.alloc(64 * 1024), hash = createHash('sha256');
  try { let count; while ((count = readSync(fd, buffer))) hash.update(buffer.subarray(0, count)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
function noLinks(root: string, file: string): void {
  let current = root;
  for (const part of relative(root, file).split(/[\\/]/)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Không dọn take qua liên kết tượng trưng');
  }
}

/** Read-only plan. All historical edit references are deliberately retained. */
export function listUnselectedTakes(db: DatabaseSync, projectId: string, dataDir = dataDirectory()): CleanupPlan {
  const root = resolve(dataDir);
  const project = db.prepare('SELECT directory FROM projects WHERE id=?').get(projectId);
  if (!project) throw new Error('Không tìm thấy dự án');
  const projectDir = assertInsideDataDir(String(project.directory), root);
  const rows = db.prepare(`SELECT t.id,t.scene_id,t.file,t.selected,t.asset_id FROM takes t
    JOIN scenes s ON s.id=t.scene_id WHERE s.project_id=? ORDER BY t.id`).all(projectId);
  const protectedIds = new Set<string>(), protectedPaths = new Set<string>(), protectedAssets = new Set<string>();
  const protect = (value: unknown) => { if (value != null) protectedIds.add(String(value)); };
  for (const row of db.prepare('SELECT take_id FROM selections').all()) protect(row.take_id);
  if (table(db, 'timeline_clip')) for (const row of db.prepare('SELECT take_id,source_path,source_asset_id FROM timeline_clip').all()) {
    protect(row.take_id);
    if (row.source_path) protectedPaths.add(resolve(projectDir, String(row.source_path)).toLowerCase());
    if (row.source_asset_id) protectedAssets.add(String(row.source_asset_id));
  }
  if (table(db, 'scene_start_frames')) for (const row of db.prepare('SELECT source_take_id FROM scene_start_frames').all()) protect(row.source_take_id);
  if (table(db, 'render_reviews')) for (const row of db.prepare('SELECT scene_id,suggestion,owner_override FROM render_reviews').all()) {
    const suggestion = row.suggestion ? JSON.parse(String(row.suggestion)) : undefined;
    const override = row.owner_override ? JSON.parse(String(row.owner_override)) : undefined;
    protect(suggestion?.takeId); protect(override?.takeId);
    // M6 supports partial overrides and falls back to the first take.
    if (override && !override.takeId && !suggestion?.takeId)
      rows.filter(t => t.scene_id === row.scene_id).forEach(t => protect(t.id));
  }
  // CapCut/publish JSON contains material paths. Protect matching paths/IDs at any depth.
  const exportedStrings = new Set<string>();
  function scan(dir: string): void {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name), info = lstatSync(file);
      if (info.isSymbolicLink()) throw new Error('Không thể xác minh tham chiếu xuất qua liên kết');
      if (info.isDirectory()) scan(file);
      else if (name.toLowerCase().endsWith('.json')) {
        if (info.size > 16 * 1024 * 1024) throw new Error('File tham chiếu xuất quá lớn để kiểm tra an toàn');
        function collect(value: unknown): void {
          if (typeof value === 'string') { exportedStrings.add(value); exportedStrings.add(resolve(projectDir, value).toLowerCase()); }
          else if (value && typeof value === 'object') Object.values(value).forEach(collect);
        }
        collect(JSON.parse(readFileSync(file, 'utf8')));
      }
    }
  }
  scan(resolveInside(projectDir, 'exports'));
  // Protect aliases to selected files, even if the alias has another take ID.
  const fileFor = (row: typeof rows[number]) => assertInsideDataDir(String(row.file), projectDir);
  for (const row of rows) if (row.selected || protectedIds.has(String(row.id)) || protectedAssets.has(String(row.asset_id)))
    protectedPaths.add(fileFor(row).toLowerCase());
  const takes: CleanupTake[] = [];
  for (const row of rows) {
    const file = fileFor(row);
    if (protectedIds.has(String(row.id)) || row.selected || protectedAssets.has(String(row.asset_id)) ||
      protectedPaths.has(file.toLowerCase()) || exportedStrings.has(String(row.id)) || exportedStrings.has(file.toLowerCase())) continue;
    if (!existsSync(file)) continue;
    noLinks(root, file);
    const info = lstatSync(file);
    // Hard links and non-media paths are never cleanup candidates.
    const local = relative(projectDir, file).replaceAll('\\', '/');
    if (!info.isFile() || info.nlink !== 1 || !local.startsWith('renders/')) continue;
    takes.push({ takeId: String(row.id), sceneId: String(row.scene_id), path: file, size: info.size, sha256: fileHash(file) });
  }
  const value = { projectId, dataDir: root, takes, totalSize: takes.reduce((sum, take) => sum + take.size, 0) };
  return { ...value, confirmation: signature(value) };
}

/** Owner passes the exact confirmation from the reviewed plan. Invalid/stale plans delete nothing. */
export function deleteTakes(db: DatabaseSync, plan: CleanupPlan, confirmation?: string, dataDir = dataDirectory()): { deleted: number; bytes: number } {
  if (!plan || typeof confirmation !== 'string' || confirmation !== plan.confirmation)
    throw new Error('Cần xác nhận rõ ràng của chủ sở hữu trước khi xóa take');
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = listUnselectedTakes(db, plan.projectId, dataDir);
    if (JSON.stringify(current) !== JSON.stringify(plan) || confirmation !== current.confirmation)
      throw new Error('Danh sách dọn take đã thay đổi; cần xem và xác nhận lại');
    // Synchronous preflight and deletion keep selection writers blocked by the SQLite transaction.
    // Keep metadata rows for provenance; missing media is omitted from subsequent plans.
    const paths = new Set(current.takes.map(t => t.path));
    for (const file of paths) unlinkSync(file);
    db.exec('COMMIT');
    return { deleted: paths.size, bytes: [...paths].reduce((sum, file) => sum + current.takes.find(t => t.path === file)!.size, 0) };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Minimal trusted local service API; adapters must show the plan before passing confirmation. */
export function createMaintenanceService(db: DatabaseSync, dataDir = dataDirectory()) {
  const reviewedProjects = new Map<string, string>();
  const planTakeCleanup = (projectId: string) => {
    const plan = listUnselectedTakes(db, projectId, dataDir);
    // Stable across CLI processes; confirmation still requires an explicit owner action.
    const { confirmation, ...snapshot } = plan;
    const planId = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    if (reviewedProjects.size >= 100) reviewedProjects.delete(reviewedProjects.keys().next().value!);
    reviewedProjects.set(planId, projectId);
    return { ...plan, planId };
  };
  const executeTakeCleanup = (input: { planId?: string; projectId?: string; confirm?: boolean }) => {
    if (input.confirm !== true || !input.planId)
      throw Object.assign(new Error('CONFIRMATION_REQUIRED: Cần xác nhận và planId trước khi xóa take'), { code: 'CONFIRMATION_REQUIRED' });
    const projectId = input.projectId ?? reviewedProjects.get(input.planId);
    if (!projectId) throw new Error('CONFIRMATION_REQUIRED: Cần xem trước danh sách take');
    const current = planTakeCleanup(projectId);
    if (current.planId !== input.planId) throw new Error('Danh sách dọn take đã thay đổi; cần xem và xác nhận lại');
    const { planId, ...plan } = current;
    const result = deleteTakes(db, plan, plan.confirmation, dataDir);
    reviewedProjects.delete(planId);
    return result;
  };
  return {
    planTakeCleanup,
    executeTakeCleanup,
    backup: (file: string) => backup(dataDir, resolveInside(dataDir, file)),
    restore: (file: string, targetDir: string, options?: { allowNonEmpty?: boolean }) => restore(resolveInside(dataDir, file), targetDir, options),
    listUnselectedTakes: (projectId: string) => listUnselectedTakes(db, projectId, dataDir),
    deleteTakes: (plan: CleanupPlan, confirmation?: string) => deleteTakes(db, plan, confirmation, dataDir),
  };
}
