export type CsvIssue = { line: number; column?: string; message: string };
export class CsvImportError extends Error {
  readonly issues: CsvIssue[];
  constructor(issues: CsvIssue[]) { super(issues.map(i => i.message).join('\n')); this.name = 'CsvImportError'; this.issues = issues; }
}
export function parseTimestamp(value: string): number {
  const parts = value.trim().split(':');
  if (parts.length > 3 || parts.some(p => !/^\d+(?:\.\d+)?$/.test(p)) ||
    (parts.length > 1 && parts.slice(1).some(p => Number(p) >= 60))) return NaN;
  return parts.reduce((sum, p) => sum * 60 + Number(p), 0);
}
export function normalizePercentage(value: string): number {
  const text = value.trim(), percent = text.endsWith('%'), raw = percent ? text.slice(0, -1).trim() : text;
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return NaN;
  const n = Number(raw);
  return n > 100 ? NaN : percent || n > 1 ? n / 100 : n;
}
export type RetentionSample = { line: number; seconds: number; retention: number };
/** RFC-style quoted cells, including physical line tracking for multiline cells. */
export function parseAnalyticsCsv(input: string): RetentionSample[] {
  const issues: CsvIssue[] = [];
  const issue = (line: number, message: string, column?: string) => issues.push({ line, column, message: `Dòng ${line}: ${message}` });
  const rows: { line: number; cells: string[] }[] = [];
  const source = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let cells: string[] = [], cell = '', quoted = false, closed = false, line = 1, start = 1;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else { cell += c; if (c === '\n') line++; }
    } else if (c === ',' || c === '\n') {
      cells.push(cell); cell = ''; closed = false;
      if (c === '\n') { rows.push({ line: start, cells }); cells = []; line++; start = line; }
    } else if (c === '"' && !cell && !closed) quoted = true;
    else { if (closed || c === '"') issue(line, 'dấu nháy không hợp lệ'); cell += c; }
  }
  if (quoted) issue(start, 'ô trích dẫn chưa đóng');
  if (cell || cells.length || closed) rows.push({ line: start, cells: [...cells, cell] });
  if (!rows.length) issue(1, 'file CSV rỗng');
  const header = rows[0]?.cells.map(c => c.trim().toLowerCase()) ?? [];
  const time = header.findIndex(c => ['timestamp', 'seconds', 'time'].includes(c));
  const retention = header.findIndex(c => ['retention', 'viewer_percentage', 'percentage'].includes(c));
  if (time < 0) issue(1, 'thiếu cột timestamp', 'timestamp');
  if (retention < 0) issue(1, 'thiếu cột retention', 'retention');
  const samples: RetentionSample[] = []; let previous = -1;
  for (const row of rows.slice(1)) {
    if (row.cells.length !== header.length) issue(row.line, 'số trường không khớp tiêu đề');
    const seconds = parseTimestamp(row.cells[time] ?? '');
    const value = normalizePercentage(row.cells[retention] ?? '');
    if (time >= 0) {
      if (!Number.isFinite(seconds)) issue(row.line, `giá trị thời điểm không hợp lệ "${row.cells[time] ?? ''}"`, 'timestamp');
      else { if (seconds <= previous) issue(row.line, 'thời điểm phải tăng và không trùng', 'timestamp'); previous = seconds; }
    }
    if (retention >= 0 && !Number.isFinite(value)) issue(row.line, 'tỉ lệ xem không hợp lệ hoặc ngoài khoảng 0–100', 'retention');
    samples.push({ line: row.line, seconds, retention: value });
  }
  if (rows.length === 1) issue(1, 'CSV không có số liệu');
  if (issues.length) throw new CsvImportError(issues);
  return samples;
}
