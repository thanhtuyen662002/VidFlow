export type TextToken = { kind: 'text'; value: string; start: number; end: number };
export type RefToken = {
  kind: 'ref'; name: string; raw: string; start: number; end: number;
  line: number; column: number;
};
export type PromptToken = TextToken | RefToken;

const NAME_START = /[\p{L}_]/u;
const NAME_CHAR = /[\p{L}\p{M}\p{N}_]/u;

/** Pure scanner. Ranges are UTF-16 offsets into the original, unnormalized input.
 * References include the @ in their range, but not in raw/name. Columns are
 * one-based UTF-16 positions; CRLF counts as a single line break.
 */
export function parsePrompt(input: string): PromptToken[] {
  const tokens: PromptToken[] = [];
  let offset = 0;
  let line = 1;
  let column = 1;
  let previous = '';

  function advance(end: number): void {
    while (offset < end) {
      const char = String.fromCodePoint(input.codePointAt(offset)!);
      if (char === '\r' || (char === '\n' && previous !== '\r')) {
        line++;
        column = 1;
      } else if (char !== '\n') {
        column += char.length;
      }
      previous = char;
      offset += char.length;
    }
  }

  function text(value: string, end: number): void {
    const last = tokens[tokens.length - 1];
    if (last?.kind === 'text') {
      last.value += value;
      last.end = end;
    } else {
      tokens.push({ kind: 'text', value, start: offset, end });
    }
    advance(end);
  }

  while (offset < input.length) {
    const char = String.fromCodePoint(input.codePointAt(offset)!);
    if (char === '@' && input[offset + 1] === '@') {
      text('@', offset + 2);
      continue;
    }
    // Word/email continuations block refs; all other preceding characters allow them.
    const blocked = previous !== '' && (NAME_CHAR.test(previous) || '.-+'.includes(previous));
    const next = input.codePointAt(offset + 1);
    if (char === '@' && !blocked && next !== undefined && NAME_START.test(String.fromCodePoint(next))) {
      let end = offset + 1;
      // Punctuation always ends a name: @Lan.Thao references only Lan.
      while (end < input.length) {
        const part = String.fromCodePoint(input.codePointAt(end)!);
        if (!NAME_CHAR.test(part)) break;
        end += part.length;
      }
      const raw = input.slice(offset + 1, end);
      tokens.push({ kind: 'ref', name: raw.normalize('NFC'), raw, start: offset, end, line, column });
      advance(end);
    } else {
      text(char, offset + char.length);
    }
  }
  return tokens;
}
