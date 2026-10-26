// A small JSON Schema subset, used for MCP tool inputs and HTTP API bodies.
// The schemas are plain JSON Schema, so they can be listed to MCP clients as-is.

export type Schema =
  | { type: 'string'; description?: string; minLength?: number; maxLength?: number; enum?: readonly string[]; pattern?: string }
  | { type: 'integer' | 'number'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items: Schema; maxItems?: number }
  | ObjectSchema;

export interface ObjectSchema {
  type: 'object';
  description?: string;
  properties: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: false;
}

export class ValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join('; '));
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function check(schema: Schema, value: unknown, path = 'input'): string[] {
  const issues: string[] = [];
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return [`${path}: expected a string, got ${typeName(value)}`];
      if (schema.minLength !== undefined && value.trim().length < schema.minLength) {
        issues.push(schema.minLength === 1 ? `${path}: must not be empty` : `${path}: must be at least ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push(`${path}: must be at most ${schema.maxLength} characters`);
      if (schema.enum && !schema.enum.includes(value)) issues.push(`${path}: must be one of ${schema.enum.join(', ')}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) issues.push(`${path}: has an invalid format`);
      return issues;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path}: expected a number, got ${typeName(value)}`];
      if (schema.type === 'integer' && !Number.isInteger(value)) issues.push(`${path}: must be a whole number`);
      if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${path}: must be at least ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${path}: must be at most ${schema.maximum}`);
      return issues;
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path}: expected true or false, got ${typeName(value)}`];
    case 'array': {
      if (!Array.isArray(value)) return [`${path}: expected a list, got ${typeName(value)}`];
      if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(`${path}: must have at most ${schema.maxItems} entries`);
      value.forEach((v, i) => issues.push(...check(schema.items, v, `${path}[${i}]`)));
      return issues;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path}: expected an object, got ${typeName(value)}`];
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined || obj[key] === null) issues.push(`${path}.${key}: required`);
      }
      for (const [key, v] of Object.entries(obj)) {
        const sub = schema.properties[key];
        if (!sub) {
          if (schema.additionalProperties === false) issues.push(`${path}.${key}: unknown field`);
          continue;
        }
        if (v === undefined || v === null) continue;
        issues.push(...check(sub, v, `${path}.${key}`));
      }
      return issues;
    }
  }
}

/** Validates and returns the value typed as T, or throws ValidationError. */
export function validate<T>(schema: ObjectSchema, value: unknown): T {
  const issues = check(schema, value ?? {}, 'input');
  if (issues.length) throw new ValidationError(issues.map((i) => i.replace(/^input\./, '')));
  return (value ?? {}) as T;
}

/**
 * Query strings arrive as text. Turn "30" into 30 and "true" into true where the
 * schema asks for it, so GET routes can share the tool schemas.
 */
export function coerceQuery(schema: ObjectSchema, query: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of query.entries()) {
    const sub = schema.properties[key];
    if (!sub) {
      out[key] = raw;
      continue;
    }
    if ((sub.type === 'integer' || sub.type === 'number') && raw.trim() !== '' && !Number.isNaN(Number(raw))) out[key] = Number(raw);
    else if (sub.type === 'boolean' && (raw === 'true' || raw === 'false')) out[key] = raw === 'true';
    else if (sub.type === 'array') out[key] = raw.split(',').filter(Boolean);
    else out[key] = raw;
  }
  return out;
}
