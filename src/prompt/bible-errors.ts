import { DuplicateError } from '../types.ts';

export class BibleDuplicateError extends DuplicateError {
  readonly code = 'BIBLE_DUPLICATE_NAME';
  readonly normalizedName: string;
  constructor(name: string, normalizedName: string) {
    super(`Reference name "${name}" already exists in this project`);
    this.name = name;
    this.normalizedName = normalizedName;
  }
}

export class BibleDeleteConfirmationError extends Error {
  readonly code = 'BIBLE_DELETE_CONFIRMATION_REQUIRED';
  constructor(kind: string, name: string) {
    super(`C\u1ea7n x\u00e1c nh\u1eadn \u0111\u1ec3 x\u00f3a m\u1ee5c Bible ${kind} "${name}"`);
    this.name = name;
  }
}
