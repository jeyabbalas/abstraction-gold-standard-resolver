/**
 * JSON Schema checks with Ajv:
 *  - whether a value is allowed for a field (its property schema);
 *  - which cross-field (if/then) rules a record breaks. Each rule is compiled
 *    on its own, so a violation names its rule; fields the record does not
 *    have yet (unresolved cells) never count as breaking a rule.
 */

import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { Json, RuleInfo, SchemaModel } from './types';
import { stableStringify } from './util';

export interface RuleViolation {
  rule: RuleInfo;
  /** Fields whose values break the rule (from the `then` side). */
  fields: string[];
}

export interface Validators {
  /** Whether `value` is allowed for `field` (true when the schema cannot be compiled). */
  fieldValid(field: string, value: Json): boolean;
  /**
   * Rules `record` breaks. `only` limits the check to rules that involve that field.
   * Fields absent from the record are unresolved: they never break a rule.
   */
  violations(record: Record<string, Json>, only?: string): RuleViolation[];
  /** Why the schema could not be compiled, if it could not. */
  error: string | null;
}

const docId = (doc: { path: string; json: Record<string, unknown> }): string =>
  typeof doc.json.$id === 'string' ? doc.json.$id : `file:///${encodeURI(doc.path)}`;

const encodeSeg = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

function fieldOf(e: ErrorObject): string {
  const first = e.instancePath.split('/')[1];
  if (first) return decodeURIComponent(first).replace(/~1/g, '/').replace(/~0/g, '~');
  if (e.keyword === 'required') return String((e.params as { missingProperty?: string }).missingProperty ?? '');
  return '';
}

export function createValidators(schema: SchemaModel): Validators {
  const draft = typeof schema.root.$schema === 'string' ? schema.root.$schema : '';
  const legacy = /draft-0[4-7]/.test(draft);
  const ajv = legacy
    ? new Ajv({ allErrors: true, strict: false, validateFormats: false })
    : new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  let error: string | null = null;
  for (const doc of schema.documents) {
    // The meta-schema reference is not needed to validate data (and other drafts are not bundled).
    const { $schema: _ignored, ...json } = doc.json;
    try {
      ajv.addSchema({ ...json, $id: docId(doc) });
    } catch (err) {
      if (doc.path === schema.recordDoc) error = (err as Error).message;
    }
  }
  const recordDoc = schema.documents.find((d) => d.path === schema.recordDoc);
  const base = recordDoc ? docId(recordDoc) : '';

  const fieldFns = new Map<string, ValidateFunction | null>();
  const fieldFn = (name: string): ValidateFunction | null => {
    if (fieldFns.has(name)) return fieldFns.get(name)!;
    let fn: ValidateFunction | null = null;
    const info = schema.byName.get(name);
    if (info && base && !error) {
      try {
        fn = ajv.compile({ $ref: `${base}#${info.pointer}` });
      } catch {
        fn = null;
      }
    }
    fieldFns.set(name, fn);
    return fn;
  };

  const ruleFns = new Map<number, ValidateFunction | null>();
  const ruleFn = (rule: RuleInfo): ValidateFunction | null => {
    if (ruleFns.has(rule.index)) return ruleFns.get(rule.index)!;
    let fn: ValidateFunction | null = null;
    if (base && !error) {
      try {
        fn = ajv.compile({ $ref: `${base}#${schema.recordPointer}/allOf/${rule.index}` });
      } catch {
        fn = null;
      }
    }
    ruleFns.set(rule.index, fn);
    return fn;
  };

  const validCache = new Map<string, boolean>();

  return {
    error,
    fieldValid(field, value) {
      const info = schema.byName.get(field);
      if (!info) return true;
      if (info.kind === 'categorical' && info.domain.length) {
        const k = stableStringify(value);
        if (!info.domain.some((d) => stableStringify(d) === k)) return false;
      }
      const key = `${field}\u0000${stableStringify(value)}`;
      const hit = validCache.get(key);
      if (hit !== undefined) return hit;
      const fn = fieldFn(field);
      const ok = fn ? (fn(value) as boolean) : true;
      validCache.set(key, ok);
      return ok;
    },
    violations(record, only) {
      const out: RuleViolation[] = [];
      for (const rule of schema.rules) {
        if (only && !rule.fields.includes(only)) continue;
        // A rule about fields none of which is resolved cannot be judged.
        if (!rule.fields.some((f) => f in record)) continue;
        const fn = ruleFn(rule);
        if (!fn || fn(record)) continue;
        const fields = new Set<string>();
        for (const e of fn.errors ?? []) {
          if (e.keyword === 'if') continue;
          const f = fieldOf(e);
          if (!f || !(f in record)) continue; // unresolved: not a violation yet
          fields.add(f);
        }
        if (fields.size) out.push({ rule, fields: [...fields] });
      }
      return out;
    },
  };
}

/** A record's JSON pointer to one property (for messages). */
export const propertyPointer = (pointer: string, name: string): string => `${pointer}/properties/${encodeSeg(name)}`;
