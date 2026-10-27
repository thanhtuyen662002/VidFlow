import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  MAX_NAME_LENGTH, MAX_ROLE_LENGTH, ValidationError, validateProjectName,
  validateReferenceName, validateAspectRatio, validateRole, validatePriority,
  validateImagePath,
} from '../src/validate.ts';

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.VIDFLOW_HOME;
  home = mkdtempSync(join(tmpdir(), 'vidflow-validate-'));
  process.env.VIDFLOW_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.VIDFLOW_HOME;
  else process.env.VIDFLOW_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function rejects(action: () => unknown, field: string): void {
  assert.throws(action, error => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.name, 'ValidationError');
    assert.equal(error.field, field);
    assert.ok(error.message.includes(field));
    assert.ok(error.message.length > field.length + 5);
    return true;
  });
}

test('ValidationError supports an optional field', () => {
  const error = new ValidationError('input must be a string');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'ValidationError');
  assert.equal(error.field, undefined);
});

for (const [field, validate] of [
  ['projectName', validateProjectName],
  ['referenceName', validateReferenceName],
] as const) {
  test(`${field} accepts and trims valid names`, () => {
    for (const name of ['VidFlow', 'My Project', 'Dự án Việt Nam', 'Nhân_vật_1', 'COM10']) {
      assert.equal(validate(`  ${name}  `), name);
    }
    assert.equal(validate('a'.repeat(MAX_NAME_LENGTH)), 'a'.repeat(MAX_NAME_LENGTH));
  });

  test(`${field} rejects invalid types, empty, forbidden and reserved names`, () => {
    for (const value of [undefined, null, 1, {}, '', '   ', 'a'.repeat(MAX_NAME_LENGTH + 1),
      '.', '..', 'name.', 'name. ', 'CON', 'prn', 'Aux', 'NUL', 'con.txt',
      ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
      ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
      ...Array.from('<>:"/\\|?*', char => `a${char}b`),
      ...Array.from({ length: 32 }, (_, i) => `a${String.fromCharCode(i)}b`),
      'a\x7fb', '\nname', 'name\t']) {
      rejects(() => validate(value), field);
    }
  });
}

test('aspectRatio accepts positive integer and decimal ratios', () => {
  for (const ratio of ['16:9', '9:16', '1:1', '1.5:2.25', '0.5:1', '001:2']) {
    assert.equal(validateAspectRatio(ratio), ratio);
  }
});

test('aspectRatio rejects malformed, zero and non-finite dimensions', () => {
  for (const value of ['abc', '0:5', '16-9', '16:0', '', ':', '16:9:1', '-1:5',
    ' 16:9', '16:9 ', '.5:1', '1.:2', '1e2:1', '0.0:1', `${'9'.repeat(400)}:1`,
    undefined, null, 169, {}]) {
    rejects(() => validateAspectRatio(value), 'aspectRatio');
  }
});

test('role accepts the four documented roles and trims spaces', () => {
  for (const role of ['character', 'location', 'prop', 'style']) {
    assert.equal(validateRole(` ${role} `), role);
  }
});

test('role rejects missing, unknown, long and control-containing values', () => {
  for (const value of [undefined, null, 1, '', '   ', 'unknown', 'Character',
    'a'.repeat(MAX_ROLE_LENGTH + 1), 'char\x00acter', 'style\n', 'style\x7f']) {
    rejects(() => validateRole(value), 'role');
  }
});

test('priority accepts finite integers and CLI integer strings', () => {
  for (const value of [-20, 0, 20, '-20', '0', '20', '001']) {
    assert.equal(validatePriority(value), Number(value));
  }
});

test('priority rejects fractions, malformed strings and non-finite values', () => {
  for (const value of [1.5, '1.5', 'abc', NaN, Infinity, -Infinity, '', ' ',
    '+1', ' 1', '1 ', '1e2', '0x10', '--1', '9'.repeat(400), undefined, null, true, {}]) {
    rejects(() => validatePriority(value), 'priority');
  }
});

test('imagePath accepts a real PNG and resolves relative paths', () => {
  const filename = join(home, 'source.PNG');
  writeFileSync(filename, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ));
  assert.equal(validateImagePath(filename), resolve(filename));
  assert.equal(validateImagePath(relative(process.cwd(), filename)), resolve(filename));
});

test('imagePath checks extensions case-insensitively without reading contents', () => {
  for (const extension of ['png', 'JPG', 'jpeg', 'WEBP', 'gif', 'BMP']) {
    const filename = join(home, `source.${extension}`);
    writeFileSync(filename, 'extension-only fixture');
    assert.equal(validateImagePath(filename), resolve(filename));
  }
});

test('imagePath rejects absent paths, directories, non-images and invalid inputs', () => {
  const text = join(home, 'source.txt');
  writeFileSync(text, 'not an image');
  for (const value of [join(home, 'missing.png'), home, text, '', '   ',
    undefined, null, 1, {}, 'bad\x00path.png']) {
    rejects(() => validateImagePath(value), 'imagePath');
  }
});
