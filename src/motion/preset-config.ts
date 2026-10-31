import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validateSchema } from '../script/llm/schema.ts';
import type { JsonSchema } from '../script/llm/schema.ts';

export interface MotionPreset {
  key: string; name: string; version: number; faceless: boolean; style: string;
  fragments: string[]; forbidden: string[]; required: string[]; disclosure: string; maxReferenceImages: number;
}
export interface MotionPricing { variants: number; creditsPerSecond: number }
export interface MotionPresetConfig { pricing: MotionPricing; presets: MotionPreset[] }
const text: JsonSchema = { type: 'string', minLength: 1 };
const texts: JsonSchema = { type: 'array', items: text };
export const MOTION_PRESET_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['pricing','presets'], properties: {
    pricing: { type: 'object', additionalProperties: false, required: ['variants','creditsPerSecond'], properties: {
      variants: { type: 'integer', minimum: 1 }, creditsPerSecond: { type: 'integer', minimum: 0 }
    } },
    presets: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
      required: ['key','name','version','faceless','style','fragments','forbidden','required','disclosure','maxReferenceImages'],
      properties: { key: text, name: text, version: { type: 'integer', minimum: 1 }, faceless: { type: 'boolean' },
        style: text, fragments: texts, forbidden: texts, required: texts, disclosure: text,
        maxReferenceImages: { type: 'integer', minimum: 0 } }
    } }
  }
};
/** Canonical object key order; arrays retain their semantic order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const configHash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export const defaultPresetPath = new URL('./style-presets.json', import.meta.url);
export function loadStylePresets(path: string | URL = defaultPresetPath): MotionPresetConfig {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path,'utf8')); }
  catch (error) { throw new Error(`Invalid motion preset file: ${String(error)}`); }
  const result = validateSchema(value,MOTION_PRESET_SCHEMA);
  if (!result.valid) throw new Error(`Invalid motion preset config: ${JSON.stringify(result.errors)}`);
  const config = value as MotionPresetConfig;
  if (new Set(config.presets.map(p => p.key)).size !== config.presets.length) throw new Error('Invalid motion preset config: duplicate key');
  return config;
}
export function syncMotionPresets(db: DatabaseSync, config: MotionPresetConfig): void {
  const now = new Date().toISOString();
  db.exec('SAVEPOINT sync_motion_presets');
  try {
    db.prepare('UPDATE motion_presets SET active=0').run();
    for (const p of config.presets) db.prepare(`INSERT INTO motion_presets
      (id,key,name,version,config_hash,config,active,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)
      ON CONFLICT(key) DO UPDATE SET name=excluded.name,version=excluded.version,config_hash=excluded.config_hash,
      config=excluded.config,active=1,updated_at=excluded.updated_at`).run(p.key,p.key,p.name,p.version,configHash(p),canonical(p),now,now);
    db.exec('RELEASE sync_motion_presets');
  } catch (error) { db.exec('ROLLBACK TO sync_motion_presets'); db.exec('RELEASE sync_motion_presets'); throw error; }
}
