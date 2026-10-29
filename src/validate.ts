export function projectName(input: string): string {
  const name = input.trim();
  if (!name || name.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || name === '.' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) {
    throw new Error('Tên dự án không hợp lệ (1–120 ký tự, không chứa ký tự cấm)');
  }
  return name;
}

export function projectAspect(input: string | undefined): string {
  if (!input || !/^\d+:\d+$/.test(input) || !input.split(':').every(value => Number.isFinite(Number(value)) && Number(value) > 0)) {
    throw new Error('Tỉ lệ --aspect phải có dạng W:H với hai số lớn hơn 0');
  }
  return input;
}

export function projectBudget(input: string | undefined): number | null {
  if (input === undefined) return null;
  const budget = Number(input);
  if (!input.trim() || !Number.isFinite(budget) || budget < 0) throw new Error('Budget phải là số không âm hữu hạn');
  return budget;
}
export function referenceInput(values: Record<string, unknown>): { name: string; role: string; description: string; priority: number } {
  for (const flag of ['name', 'role', 'description', 'priority']) {
    if (typeof values[flag] !== 'string') throw new Error(`Missing required --${flag}`);
  }
  const name = (values.name as string).trim();
  if (!/^[\p{L}\p{N}_]+$/u.test(name)) throw new Error('Invalid reference name');
  const role = values.role as string;
  if (!['character', 'location', 'prop', 'style'].includes(role)) throw new Error('Invalid --role: character, location, prop, style');
  const raw = values.priority as string;
  const priority = Number(raw);
  if (!/^[+-]?\d+$/.test(raw) || !Number.isSafeInteger(priority)) throw new Error('--priority must be a safe integer');
  return { name, role, description: values.description as string, priority };
}

export function referenceFilename(filename: string): string {
  if (!filename || filename.includes('..') || /[/\\]/.test(filename)) throw new Error('Unsafe image filename');
  const safe = filename.replace(/[^\p{L}\p{N}_.-]/gu, '_');
  if (!safe || /[. ]$/.test(safe) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) throw new Error('Unsafe image filename');
  return safe;
}
import { statSync } from 'node:fs';
import { extname, resolve, isAbsolute, relative } from 'node:path';
import { resolveInside } from './paths.ts';

export function referenceImages(value: unknown, directory?: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new ValidationError('images must be a non-empty array');
  return value.map(image => {
    if (typeof image !== 'string' || !image) throw new ValidationError('Invalid image path');
    const path = directory && isAbsolute(image) ? relative(directory, image) : image;
    if (directory) {
      resolveInside(directory, path);
      if (path.split(/[\\/]/)[0] !== 'refs') throw new ValidationError('Images must be inside refs/');
    } else if (isAbsolute(path) || /^[a-z]:/i.test(path) || path.split(/[\\/]/).includes('..')) throw new ValidationError('Unsafe image path');
    return path;
  });
}

export function bibleText(value: unknown): string {
  if (typeof value !== 'string' || /\x00/.test(value)) throw new ValidationError('Bible fields must be strings without NUL');
  return value;
}

export const MAX_NAME_LENGTH = 100;
export const MAX_ROLE_LENGTH = 100;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
const ROLES = ['character', 'location', 'prop', 'style'];

export class ValidationError extends Error {
  field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

function validateText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`, field);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new ValidationError(`${field} must not contain control characters`, field);
  }
  const text = value.trim();
  if (!text) throw new ValidationError(`${field} must not be empty`, field);
  if (text.length > maxLength) {
    throw new ValidationError(`${field} must be at most ${maxLength} characters`, field);
  }
  return text;
}

function validateName(value: unknown, field: string): string {
  const name = validateText(value, field, MAX_NAME_LENGTH);
  if (/[<>:"/\\|?*]/.test(name)) {
    throw new ValidationError(`${field} contains a forbidden folder-name character`, field);
  }
  if (name.endsWith('.')) {
    throw new ValidationError(`${field} must not end with a dot`, field);
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new ValidationError(`${field} must not be a reserved Windows name`, field);
  }
  return name;
}

export function validateProjectName(name: unknown): string {
  return validateName(name, 'projectName');
}

export function validateReferenceName(name: unknown): string {
  return validateName(name, 'referenceName');
}

export function validateAspectRatio(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(value)
    || !value.split(':').every(part => Number.isFinite(Number(part)) && Number(part) > 0)) {
    throw new ValidationError('aspectRatio must have the form W:H with two finite positive numbers', 'aspectRatio');
  }
  return value;
}

export function validateRole(role: unknown): string {
  const text = validateText(role, 'role', MAX_ROLE_LENGTH);
  if (!ROLES.includes(text)) {
    throw new ValidationError(`role must be one of: ${ROLES.join(', ')}`, 'role');
  }
  return text;
}

export function validatePriority(value: unknown): number {
  const priority = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  if (typeof priority !== 'number' || !Number.isFinite(priority) || !Number.isInteger(priority)) {
    throw new ValidationError('priority must be a finite integer or an integer string', 'priority');
  }
  return priority;
}

export function validateImagePath(p: unknown): string {
  if (typeof p !== 'string' || !p.trim()) {
    throw new ValidationError('imagePath must be a non-empty string', 'imagePath');
  }
  const filename = resolve(p);
  let stats;
  try {
    stats = statSync(filename);
  } catch {
    throw new ValidationError('imagePath must exist and be accessible', 'imagePath');
  }
  if (!stats.isFile()) throw new ValidationError('imagePath must be a file', 'imagePath');
  if (!IMAGE_EXTENSIONS.includes(extname(filename).toLowerCase())) {
    throw new ValidationError(`imagePath must have an image extension: ${IMAGE_EXTENSIONS.join(', ')}`, 'imagePath');
  }
  return filename;
}
