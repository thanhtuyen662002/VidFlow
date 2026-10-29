/** Case-sensitive, NFC names with surrounding whitespace ignored. */
export function normalizeRefName(name: string): string {
  return name.trim().normalize('NFC');
}
