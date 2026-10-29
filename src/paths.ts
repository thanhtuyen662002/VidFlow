import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

// Resolve existing ancestors as well as paths that have not been created yet.
function canonicalPath(filename: string): string {
  try { return realpathSync.native(filename); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = resolve(filename, '..');
    if (parent === filename) throw error;
    return join(canonicalPath(parent), relative(parent, filename));
  }
}

function assertInside(base: string, target: string): void {
  const offset = relative(process.platform === 'win32' ? base.toLowerCase() : base,
    process.platform === 'win32' ? target.toLowerCase() : target);
  if (!offset || offset === '..' || offset.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(offset)) {
    throw new Error('Path must stay inside the project directory');
  }
}

export function resolveInside(directory: string, filename: string): string {
  if (isAbsolute(filename) || /^[\\/]/.test(filename) || /^[a-z]:/i.test(filename) || filename.split(/[\\/]/).includes('..')) {
    throw new Error('Path must stay inside the project directory');
  }
  const base = resolve(directory);
  const destination = resolve(base, filename);
  assertInside(base, destination);
  assertInside(canonicalPath(base), canonicalPath(destination));
  return destination;
}

export function dataDirectory(): string {
  return resolve(process.env.VIDFLOW_HOME || (process.env.APPDATA ? join(process.env.APPDATA, 'VidFlow') : join(homedir(), '.vidflow')));
}

export function initializeDirectories(): string {
  const home = dataDirectory();
  for (const part of ['', 'profiles', 'projects']) mkdirSync(join(home, part), { recursive: true });
  return home;
}

export function projectDirectory(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('ID dự án không hợp lệ');
  return join(dataDirectory(), 'projects', id);
}

export function createProjectDirectories(id: string): string {
  const directory = projectDirectory(id);
  const home = initializeDirectories();
  resolveInside(home, relative(home, directory));
  mkdirSync(directory, { recursive: true });
  for (const part of ['refs', 'assets', 'renders', 'frames', 'audio', 'exports']) mkdirSync(resolveInside(directory, part), { recursive: true });
  return directory;
}
