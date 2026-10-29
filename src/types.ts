export type Project = { id: string; name: string; aspect: string; budget: number | null; status: string; directory: string; created_at: string };
export type Reference = { id: string; project_id: string; name: string; role: string; images: string[]; description: string; priority: number };
export type Bible = { id: string; project_id: string; style: string; lighting: string; palette: string; lens: string; avoid: string; safe_area: string };

export class DuplicateError extends Error {
  constructor(message: string) {
    super(`DuplicateError: ${message}`);
    this.name = 'DuplicateError';
  }
}
