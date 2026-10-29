import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePrompt } from '../src/prompt/parse-refs.ts';

// All parser calls verify original-source coverage as well as their specific behavior.
function parse(input: string) {
  const tokens = parsePrompt(input);
  let end = 0;
  for (const token of tokens) {
    assert.equal(token.start, end);
    assert.ok(token.end > token.start);
    if (token.kind === 'text') assert.ok(token.value.length > 0);
    end = token.end;
  }
  assert.equal(end, input.length);
  assert.equal(tokens.map(token => input.slice(token.start, token.end)).join(''), input);
  return tokens;
}

test('empty input and escaped @ merge into text with original ranges', () => {
  assert.deepEqual(parse(''), []);
  for (const [input, value] of [['@@', '@'], ['@@Lan', '@Lan'], ['a @@ b', 'a @ b'], ['@@@@Lan', '@@Lan']]) {
    assert.deepEqual(parse(input), [{ kind: 'text', value, start: 0, end: input.length }]);
  }
});

test('punctuation ends names, including a dot followed by letters', () => {
  for (const suffix of [',', '.', '!', ')', ':', '.Thao']) {
    assert.deepEqual(parse(`@Lan${suffix}`), [
      { kind: 'ref', name: 'Lan', raw: 'Lan', start: 0, end: 4, line: 1, column: 1 },
      { kind: 'text', value: suffix, start: 4, end: 4 + suffix.length },
    ]);
  }
});

test('NFC names preserve original raw spelling and UTF-16 offsets', () => {
  for (const raw of ['Thảo', 'Thảo'.normalize('NFD')]) {
    assert.deepEqual(parse(`@${raw}!`), [
      { kind: 'ref', name: 'Thảo', raw, start: 0, end: raw.length + 1, line: 1, column: 1 },
      { kind: 'text', value: '!', start: raw.length + 1, end: raw.length + 2 },
    ]);
  }
});

test('stray @, invalid name starts, words and emails stay text', () => {
  for (const input of ['xin chào @', '@', '@ ', '@!', '@1Lan', '@\u0309Lan', 'email a@b.com', 'lan@Thao', '1@Lan', '_@Lan', '\u0309@Lan', '.@Lan', '-@Lan', '+@Lan', '𐐀@Lan']) {
    assert.deepEqual(parse(input), [{ kind: 'text', value: input, start: 0, end: input.length }]);
  }
});

test('line breaks and columns count original UTF-16 units', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const prefix = `hello${newline}😀 `;
    assert.deepEqual(parse(`${prefix}@Lan`)[1], {
      kind: 'ref', name: 'Lan', raw: 'Lan', start: prefix.length, end: prefix.length + 4, line: 2, column: 4,
    });
  }
});

test('multiple references preserve token order and exact positions', () => {
  assert.deepEqual(parse('@Lan nói với @Minh.'), [
    { kind: 'ref', name: 'Lan', raw: 'Lan', start: 0, end: 4, line: 1, column: 1 },
    { kind: 'text', value: ' nói với ', start: 4, end: 13 },
    { kind: 'ref', name: 'Minh', raw: 'Minh', start: 13, end: 18, line: 1, column: 14 },
    { kind: 'text', value: '.', start: 18, end: 19 },
  ]);
});

test('boundaries allow punctuation and whitespace; names support Unicode and underscores', () => {
  for (const prefix of ['', ' ', '\t', '(', ',', '"', '/', '😀']) {
    const tokens = parse(`${prefix}@_𐐀2\u0301`);
    assert.deepEqual(tokens.at(-1), {
      kind: 'ref', name: '_𐐀2\u0301', raw: '_𐐀2\u0301', start: prefix.length,
      end: prefix.length + 6, line: 1, column: prefix.length + 1,
    });
  }
});
