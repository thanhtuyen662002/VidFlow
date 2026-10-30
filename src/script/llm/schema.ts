export type JsonType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
export interface JsonSchema {
  type?: JsonType | readonly JsonType[]; nullable?: boolean; required?: readonly string[];
  properties?: Record<string, JsonSchema>; additionalProperties?: boolean; items?: JsonSchema;
  enum?: readonly unknown[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
  minItems?: number; maxItems?: number;
}
export interface ValidationError { path: string; message: string }
export function validateSchema(value: unknown, schema: JsonSchema): { valid: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const visit = (v: unknown, s: JsonSchema, path: string) => {
    const fail = (message: string) => errors.push({ path, message });
    if (v === null && s.nullable) return;
    const matches = (type: JsonType) => type === 'null' ? v === null : type === 'array' ? Array.isArray(v)
      : type === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v)
      : type === 'integer' ? typeof v === 'number' && Number.isInteger(v)
      : type === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === type;
    if (s.type && !(Array.isArray(s.type) ? s.type : [s.type]).some(matches)) { fail('Unexpected type'); return; }
    if (s.enum && !s.enum.some(item => JSON.stringify(item) === JSON.stringify(v))) fail('Value is outside enum');
    if (typeof v === 'string') {
      const length = [...v].length;
      if (s.minLength !== undefined && length < s.minLength) fail('Below minLength');
      if (s.maxLength !== undefined && length > s.maxLength) fail('Above maxLength');
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) fail('Expected finite number');
      if (s.minimum !== undefined && v < s.minimum) fail('Below minimum');
      if (s.maximum !== undefined && v > s.maximum) fail('Above maximum');
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) fail('Below minItems');
      if (s.maxItems !== undefined && v.length > s.maxItems) fail('Above maxItems');
      if (s.items) v.forEach((item, i) => visit(item, s.items!, `${path}[${i}]`));
    } else if (v !== null && typeof v === 'object') {
      const object = v as Record<string, unknown>;
      for (const key of s.required ?? []) if (!Object.hasOwn(object, key)) errors.push({ path: `${path}.${key}`, message: 'Required property missing' });
      for (const key of Object.keys(object)) {
        if (s.properties && Object.hasOwn(s.properties, key)) visit(object[key], s.properties[key], `${path}.${key}`);
        else if (s.additionalProperties === false) errors.push({ path: `${path}.${key}`, message: 'Additional property forbidden' });
      }
    }
  };
  visit(value, schema, '$'); return { valid: errors.length === 0, errors };
}

const text: JsonSchema = { type: 'string' };
const nonempty: JsonSchema = { type: 'string', minLength: 1 };
const sceneProperties: Record<string, JsonSchema> = {
  index: { type: 'integer', minimum: 0 }, beat: nonempty, durationUsed: { type: 'number', minimum: 0.001 },
  moment: nonempty, camera: text, action: nonempty, dialogue: text, sfx: text,
  charactersPresent: { type: 'array', items: nonempty }, location: nonempty,
  transition: { type: 'string', enum: ['continue', 'cut'] }, groupId: { type: ['string', 'null'] },
  mode: { type: 'string', enum: ['frames', 'image-to-video', 'text'] },
};
/** Generated content only; repository IDs and review state belong to later workflow steps. */
export const SCRIPT_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['logline', 'audience', 'value', 'beats', 'scenes'],
  properties: {
    logline: nonempty, audience: nonempty, value: nonempty,
    beats: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
      required: ['beat', 'durationUsed'], properties: { beat: nonempty, durationUsed: { type: 'number', minimum: 0.001 } } } },
    scenes: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
      required: Object.keys(sceneProperties), properties: sceneProperties } },
  },
};
