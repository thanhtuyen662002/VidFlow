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
