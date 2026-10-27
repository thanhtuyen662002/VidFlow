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
