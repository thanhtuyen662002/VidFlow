import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { UnsafePathError } from './errors.ts';

function canonical(file: string): string {
  try { return realpathSync.native(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new UnsafePathError('Cannot resolve path safely');
    const parent = dirname(file);
    if (parent === file) throw new UnsafePathError('Cannot resolve path safely');
    return join(canonical(parent), basename(file));
  }
}
function key(file: string): string { return process.platform === 'win32' ? file.toLowerCase() : file; }
function inside(file: string, base: string): boolean { return key(file).startsWith(key(base).replace(/[\\/]$/, '') + sep); }
export function assertInsideDataDir(file: string, dataDir: string): string {
  if (file.split(/[\\/]/).includes('..') || (!isAbsolute(file) && /^(?:[a-z]:|[\\/])/i.test(file))) {
    throw new UnsafePathError('Traversal or foreign drive path');
  }
  const base = resolve(dataDir);
  const target = resolve(base, file);
  if (!inside(target, base) || !inside(canonical(target), canonical(base))) throw new UnsafePathError('Path escapes data directory');
  return target;
}
export interface OutputPathOptions { dataDir: string; projectDir: string; inputPaths: readonly string[] }
export function assertSafeOutputPath(file: string, options: OutputPathOptions): string {
  const project = assertInsideDataDir(options.projectDir, options.dataDir);
  const target = assertInsideDataDir(file, options.dataDir);
  const actual = canonical(target);
  if (!['exports', 'frames'].some(part => {
    const root = join(project, part);
    return inside(target, root) && inside(actual, canonical(root)) && inside(canonical(root), canonical(project));
  })) throw new UnsafePathError('Output must be inside project exports/ or frames/');
  for (const input of options.inputPaths) {
    const source = assertInsideDataDir(input, options.dataDir);
    if (key(actual) === key(canonical(source))) throw new UnsafePathError('Output equals an input');
  }
  // Refuse all existing outputs, including hard links to original assets.
  if (existsSync(target)) throw new UnsafePathError('Output already exists');
  return target;
}
