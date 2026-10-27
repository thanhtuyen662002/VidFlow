import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

export function resolveInside(directory: string, filename: string): string {
  const destination = resolve(directory, filename);
  const offset = relative(resolve(directory), destination);
  if (!offset || offset === '..' || offset.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(offset)) {
    throw new Error('Path must stay inside the project directory');
  }
  return destination;
}

export function dataDirectory(): string {
  return resolve(process.env.VIDFLOW_HOME || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'VidFlow'));
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
  mkdirSync(directory);
  for (const part of ['refs', 'renders', 'frames', 'audio', 'exports']) mkdirSync(join(directory, part));
  return directory;
}
