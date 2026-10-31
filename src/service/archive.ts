import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { dataDirectory, resolveInside } from '../paths.ts';

export const BACKUP_MAGIC = 'VIDFLOWBAK1\n';
/** Case insensitive path components, at every depth. SQLite secrets are removed separately. */
export const BACKUP_EXCLUSIONS = [
  'profiles', 'evidence', 'screenshots', 'secrets', 'credentials', 'tokens',
  'account-pool', 'account_pool', '.env', '.env.*', '*.pem', '*.key',
  '*secret*', '*credential*', '*token*', '*cookie*', '*password*',
  '*-wal', '*-shm', '.vidflow-backup-*',
] as const;
export function isBackupExcluded(path: string): boolean {
  return path.split(/[\\/]/).some(part => BACKUP_EXCLUSIONS.some(pattern =>
    new RegExp('^' + pattern.replaceAll('.', '\\.').replaceAll('*', '.*') + '$', 'i').test(part)));
}
export interface BackupEntry { path: string; size: number; sha256: string; mode: number }
export interface BackupManifest { version: 1; createdAt: string; sourceDir: string; files: BackupEntry[] }
const MAX_MANIFEST = 16 * 1024 * 1024;
async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(name));
}

/** Single gzip stream: magic, uint32BE JSON length, UTF-8 manifest, ordered raw file bytes. */
export async function backup(sourceDir: string, backupFile: string,
  options: { onSkip?: (message: string) => void } = {}): Promise<BackupManifest> {
  const onSkip = options.onSkip ?? ((message: string) => console.warn(message));
  if ((await lstat(sourceDir)).isSymbolicLink()) throw new Error('Không sao lưu qua liên kết tượng trưng');
  const source = await realpath(sourceDir);
  const output = resolve(backupFile);
  if (output === source) throw new Error('Đường dẫn sao lưu không hợp lệ');
  await mkdir(dirname(output), { recursive: true });
  const work = await mkdtemp(join(source, '.vidflow-backup-'));
  const files: BackupEntry[] = [];
  const inputs: string[] = [];
  const secretPaths = new Set<string>();
  try {
    const database = join(source, 'vidflow.db');
    let snapshot: string | undefined;
    try {
      const info = await lstat(database);
      if (info.isSymbolicLink()) onSkip('Bỏ qua liên kết tượng trưng');
      else if (info.isFile()) {
        snapshot = join(work, 'database');
        const db = new DatabaseSync(database, { readOnly: true });
        try {
          if (hasTable(db, 'accounts')) {
            for (const row of db.prepare('SELECT secret_ref FROM accounts WHERE secret_ref IS NOT NULL').all()) {
              // secretRef can be an opaque vault key or a local relative/absolute filename.
              secretPaths.add(resolve(source, String(row.secret_ref)).toLowerCase());
            }
          }
          await sqliteBackup(db, snapshot);
        } finally { db.close(); }
        const clean = new DatabaseSync(snapshot);
        try {
          clean.exec('PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE');
          if (hasTable(clean, 'app_mcp_settings')) clean.exec('DELETE FROM app_mcp_settings');
          if (hasTable(clean, 'accounts')) clean.exec('UPDATE accounts SET secret_ref=NULL');
          clean.exec('VACUUM');
        } finally { clean.close(); }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    async function walk(dir: string): Promise<void> {
      for (const name of (await readdir(dir)).sort()) {
        const file = join(dir, name), path = relative(source, file).replaceAll('\\', '/');
        if (isBackupExcluded(path) || resolve(file) === output || secretPaths.has(resolve(file).toLowerCase())) continue;
        const stat = await lstat(file);
        if (stat.isSymbolicLink()) { onSkip('Bỏ qua liên kết tượng trưng'); continue; }
        if (stat.isDirectory()) await walk(file);
        else if (stat.isFile()) {
          const input = path === 'vidflow.db' && snapshot ? snapshot : file;
          const info = await lstat(input);
          files.push({ path, size: info.size, mode: stat.mode & 0o777, sha256: await digest(input) });
          inputs.push(input);
        }
      }
    }
    await walk(source);
    const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), sourceDir: source, files };
    const json = Buffer.from(JSON.stringify(manifest));
    if (json.length > MAX_MANIFEST) throw new Error('Danh mục sao lưu quá lớn');
    const length = Buffer.alloc(4); length.writeUInt32BE(json.length);
    async function* contents() {
      yield Buffer.from(BACKUP_MAGIC); yield length; yield json;
      for (const [index, file] of inputs.entries()) {
        const hash = createHash('sha256'); let size = 0;
        for await (const chunk of createReadStream(file)) { size += chunk.length; hash.update(chunk); yield chunk; }
        if (size !== files[index].size || hash.digest('hex') !== files[index].sha256)
          throw new Error('Dữ liệu thay đổi trong khi sao lưu; hãy tạm dừng tác vụ và thử lại');
      }
    }
    const pending = join(work, 'archive');
    await pipeline(Readable.from(contents()), createGzip(), createWriteStream(pending, { flags: 'wx' }));
    // Never overwrite an existing archive or an original input.
    const destination = await open(output, 'wx');
    try { await pipeline(createReadStream(pending), destination.createWriteStream()); }
    catch (error) { await rm(output, { force: true }); throw error; }
    finally { await destination.close(); }
    return manifest;
  } finally { await rm(work, { recursive: true, force: true }); }
}

class BackupReader {
  iterator: AsyncIterator<Buffer>;
  buffer = Buffer.alloc(0);
  constructor(stream: AsyncIterable<Buffer>) { this.iterator = stream[Symbol.asyncIterator](); }
  async read(size: number): Promise<Buffer> {
    const chunks: Buffer[] = []; let remaining = size;
    while (remaining) {
      if (!this.buffer.length) {
        const item = await this.iterator.next();
        if (item.done) throw new Error('File sao lưu bị thiếu dữ liệu');
        this.buffer = item.value;
      }
      const count = Math.min(remaining, this.buffer.length);
      chunks.push(this.buffer.subarray(0, count)); this.buffer = this.buffer.subarray(count); remaining -= count;
    }
    return Buffer.concat(chunks, size);
  }
}
async function header(reader: BackupReader): Promise<BackupManifest> {
  if ((await reader.read(Buffer.byteLength(BACKUP_MAGIC))).toString() !== BACKUP_MAGIC) throw new Error('Sai định dạng sao lưu');
  const size = (await reader.read(4)).readUInt32BE();
  if (size > MAX_MANIFEST) throw new Error('Danh mục sao lưu quá lớn');
  const manifest = JSON.parse((await reader.read(size)).toString()) as BackupManifest;
  if (manifest.version !== 1 || typeof manifest.sourceDir !== 'string' || !Array.isArray(manifest.files)) throw new Error('Phiên bản sao lưu không hợp lệ');
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    // Portable paths: also reject Windows ADS, device names, trailing dots and aliases.
    if (typeof entry.path !== 'string' || !entry.path || entry.path.includes('\\') ||
      entry.path.split('/').some(p => !p || p === '.' || p === '..' || /[\x00-\x1f:<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p)) ||
      isBackupExcluded(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || !/^[a-f0-9]{64}$/.test(entry.sha256) || seen.has(entry.path.toLowerCase()))
      throw new Error('Mục sao lưu không hợp lệ');
    resolveInside(resolve('.'), entry.path);
    seen.add(entry.path.toLowerCase());
  }
  return manifest;
}
export async function readBackupManifest(file: string): Promise<BackupManifest> {
  const input = createReadStream(file), unzip = createGunzip();
  input.on('error', error => unzip.destroy(error)); input.pipe(unzip);
  try { return await header(new BackupReader(unzip)); } finally { unzip.destroy(); input.destroy(); }
}

export async function restore(backupFile: string, targetDir: string,
  options: { allowNonEmpty?: boolean } = {}): Promise<BackupManifest> {
  const input = createReadStream(backupFile), unzip = createGunzip();
  input.on('error', error => unzip.destroy(error)); input.pipe(unzip);
  let stage: string | undefined;
  try {
    const reader = new BackupReader(unzip), manifest = await header(reader);
    await mkdir(targetDir, { recursive: true });
    const target = await realpath(targetDir);
    let active = resolve(dataDirectory());
    try { active = await realpath(active); } catch { /* Not initialized yet. */ }
    if (target.toLowerCase() === active.toLowerCase()) throw new Error('Phải khôi phục sang thư mục khác với dữ liệu đang dùng');
    // Refuse the source and its descendants, even when allowNonEmpty is requested.
    let source = resolve(manifest.sourceDir);
    try { source = await realpath(source); } catch { /* The source may be on another computer. */ }
    const offset = relative(source.toLowerCase(), target.toLowerCase());
    if (!offset || (!offset.startsWith('..') && !/^[a-z]:/i.test(offset) && !offset.startsWith('/')))
      throw new Error('Phải khôi phục sang thư mục khác với dữ liệu nguồn');
    if (!options.allowNonEmpty && (await readdir(target)).length) throw new Error('Thư mục khôi phục phải trống');
    // Existing files are never overwritten, including with allowNonEmpty.
    for (const entry of manifest.files) {
      const file = resolveInside(target, entry.path);
      try { await lstat(file); throw new Error('File đích đã tồn tại'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    stage = await mkdtemp(join(target, '.vidflow-backup-'));
    for (const entry of manifest.files) {
      const file = resolveInside(stage, entry.path); await mkdir(dirname(file), { recursive: true });
      const handle = await open(file, 'wx', entry.mode), hash = createHash('sha256');
      try {
        let remaining = entry.size;
        while (remaining) {
          const chunk = await reader.read(Math.min(64 * 1024, remaining)); hash.update(chunk);
          let written = 0;
          while (written < chunk.length) written += (await handle.write(chunk, written)).bytesWritten;
          remaining -= chunk.length;
        }
      } finally { await handle.close(); }
      if (hash.digest('hex') !== entry.sha256) throw new Error('Hash file khôi phục không khớp');
    }
    if (reader.buffer.length || !(await reader.iterator.next()).done) throw new Error('File sao lưu chứa dữ liệu thừa');
    for (const entry of manifest.files) {
      const destination = resolveInside(target, entry.path);
      await mkdir(dirname(destination), { recursive: true });
      // Exclusive copy avoids replacing any file created during restore.
      const handle = await open(destination, 'wx', entry.mode);
      try { await pipeline(createReadStream(resolveInside(stage, entry.path)), handle.createWriteStream()); }
      finally { await handle.close(); }
    }
    return manifest;
  } finally { unzip.destroy(); input.destroy(); if (stage) await rm(stage, { recursive: true, force: true }); }
}

// Descriptive service names; preserve the original API for existing callers.
export const backupProject = backup;
export const restoreProject = restore;
