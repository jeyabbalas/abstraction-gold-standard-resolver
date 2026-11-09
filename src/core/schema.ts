/**
 * Builds the field model from the JSON Schema that describes one record of
 * the tabular dataset (or the array of records):
 *  - every property except the key is a field, in schema order;
 *  - categorical fields have a closed domain (enum, const, oneOf/anyOf consts, boolean);
 *    other strings are free text (snippet lists when the dictionary joins snippets with ' || ');
 *  - each label's assignment rule is read from the description's bullet list
 *    ("• Yes: Assign 'Yes' if…"), from oneOf branch descriptions or from enum descriptions;
 *  - categories come from x-abstraction.progressive.stages, x-category on properties,
 *    or a single group;
 *  - cross-field rules are the record schema's allOf if/then blocks.
 */

import type { CategoryInfo, FieldInfo, FieldKind, Json, RuleInfo, SchemaModel, ValueDoc } from './types';
import { basename, isObj } from './util';

type Obj = Record<string, unknown>;

export class SchemaError extends Error {}

export interface SchemaDocumentInput {
  path: string;
  json: unknown;
}

// ----------------------------------------------------------------- refs

interface Located {
  node: unknown;
  /** Path of the document the node lives in. */
  doc: string;
  /** JSON pointer of the node within that document. */
  pointer: string;
}

const decodePointer = (p: string): string[] =>
  p
    .replace(/^#/, '')
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s).replace(/~1/g, '/').replace(/~0/g, '~'));

const encodeSeg = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

function walkPointer(root: unknown, pointer: string): unknown {
  let cur: unknown = root;
  for (const part of decodePointer(pointer)) {
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else if (isObj(cur)) cur = cur[part];
    else return undefined;
  }
  return cur;
}

class Resolver {
  private readonly byPath = new Map<string, Obj>();
  private readonly byBase = new Map<string, Obj>();
  private readonly byId = new Map<string, { path: string; json: Obj }>();

  constructor(docs: { path: string; json: Obj }[]) {
    for (const d of docs) {
      this.byPath.set(d.path, d.json);
      if (!this.byBase.has(basename(d.path))) this.byBase.set(basename(d.path), d.json);
      if (typeof d.json.$id === 'string') this.byId.set(d.json.$id, d);
    }
  }

  private docPathOf(json: Obj): string {
    for (const [p, j] of this.byPath) if (j === json) return p;
    return '';
  }

  /** Follow `$ref`s (local pointers, sibling files by name, `$id`s) from a node. */
  resolve(start: Located, depth = 0): Located {
    const node = start.node;
    if (!isObj(node) || typeof node.$ref !== 'string' || depth > 24) return start;
    const ref = node.$ref;
    const hash = ref.indexOf('#');
    const target = hash < 0 ? ref : ref.slice(0, hash);
    const pointer = hash < 0 ? '' : ref.slice(hash + 1);
    let docJson: Obj | undefined;
    let docPath = start.doc;
    if (!target) docJson = this.byPath.get(start.doc);
    else {
      const byId = this.byId.get(target);
      if (byId) {
        docJson = byId.json;
        docPath = byId.path;
      } else {
        docJson = this.byBase.get(basename(target));
        if (docJson) docPath = this.docPathOf(docJson);
      }
    }
    if (!docJson) return start;
    const resolved = walkPointer(docJson, pointer);
    if (resolved === undefined) return start;
    // Sibling keywords of a $ref (title, description) override the target's.
    const siblings = Object.fromEntries(Object.entries(node).filter(([k]) => k !== '$ref'));
    const ptr = pointer ? (pointer.startsWith('/') ? pointer : `/${pointer}`) : '';
    const next = this.resolve({ node: resolved, doc: docPath, pointer: ptr }, depth + 1);
    if (Object.keys(siblings).length && isObj(next.node)) return { ...next, node: { ...next.node, ...siblings } };
    return next;
  }
}

// ----------------------------------------------------------------- roots

/** How strongly a document reads like the schema of the dataset (0: not a schema). */
export function schemaScore(json: unknown): number {
  if (!isObj(json)) return 0;
  let score = 0;
  if (typeof json.$schema === 'string') score += 3;
  const props = isObj(json.properties) ? Object.keys(json.properties).length : 0;
  const items = isObj(json.items) ? json.items : null;
  const itemProps = items && isObj(items.properties) ? Object.keys(items.properties).length : 0;
  if (props) score += 2 + Math.min(props, 200) / 10;
  if (items && (itemProps || typeof items.$ref === 'string')) score += 4 + Math.min(itemProps, 200) / 10;
  if (json.type === 'object' || json.type === 'array') score += 1;
  if (!props && !items && !isObj(json.$defs) && !isObj(json.definitions)) return 0;
  return score;
}

// ----------------------------------------------------------------- value docs

const BULLET = /^\s*(?:[•·▪◦*-]|\d{1,2}[.)])\s+(.*)$/;
const RULES_HEADING = /^\s*(?:assignment|coding|value|labelling|labeling)?\s*rules?\s*:?\s*$/i;
const RULES_HEADING_INLINE = /\n\s*(?:assignment|coding)\s+rules\s*:\s*/i;

export interface ParsedDescription {
  definition: string;
  docs: ValueDoc[];
}

/**
 * Split a field description into its definition and the per-label rules of
 * its bullet list. A bullet "Label: text" counts when its label is one of
 * `labels` (case-insensitive) or, with `anyLabel`, when it is short.
 */
export function parseDescription(description: string, labels: readonly string[], anyLabel: boolean): ParsedDescription {
  const lines = description.split('\n');
  const docs: ValueDoc[] = [];
  const lower = new Map(labels.map((l) => [l.toLowerCase(), l]));
  let firstBullet = -1;
  let current: ValueDoc | null = null;
  lines.forEach((line, i) => {
    const m = BULLET.exec(line);
    if (m) {
      const body = m[1]!;
      const colon = body.indexOf(':');
      const label = colon > 0 ? body.slice(0, colon).trim() : '';
      const known = label ? lower.get(label.toLowerCase()) : undefined;
      if (label && (known || (anyLabel && label.length <= 64 && !/[.;]/.test(label)))) {
        current = { label: known ?? label, rule: body.slice(colon + 1).trim() };
        docs.push(current);
        if (firstBullet < 0) firstBullet = i;
        return;
      }
      current = null;
      return;
    }
    if (current && line.trim() && firstBullet >= 0) current.rule += `\n${line.trim()}`;
    else if (!line.trim()) current = null;
  });
  let definition = firstBullet >= 0 ? lines.slice(0, firstBullet).join('\n') : description;
  if (firstBullet >= 0) {
    const defLines = definition.split('\n');
    while (defLines.length && (RULES_HEADING.test(defLines[defLines.length - 1]!) || !defLines[defLines.length - 1]!.trim())) defLines.pop();
    definition = defLines.join('\n');
  } else {
    const m = RULES_HEADING_INLINE.exec(description);
    if (m) definition = description.slice(0, m.index);
  }
  return { definition: definition.trim(), docs };
}

/** Whole-value labels a description names: "Assign 'Not identified' if…". */
export function assignedLabels(description: string): string[] {
  const out: string[] = [];
  const re = /\bassign(?:s|ed)?\s+(?:the\s+(?:value|label)\s+)?['‘’“"]([^'‘’“”"\n]{1,60})['’”"]/gi;
  for (let m = re.exec(description); m; m = re.exec(description)) {
    const label = m[1]!.trim();
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

// ----------------------------------------------------------------- domains

interface Domain {
  values: Json[];
  /** Labels from oneOf/anyOf branches and enum descriptions. */
  docs: ValueDoc[];
  /** Constants allowed beside an open (free-text) branch. */
  sentinels: string[];
  open: boolean;
}

function typesOf(p: Obj): string[] {
  if (typeof p.type === 'string') return [p.type];
  if (Array.isArray(p.type)) return p.type.filter((t): t is string => typeof t === 'string');
  return [];
}

function domainOf(p: Obj, resolve: (n: unknown) => unknown): Domain {
  const docs: ValueDoc[] = [];
  const enumDocs = p['x-enumDescriptions'] ?? p.enumDescriptions ?? p['x-enum-descriptions'];
  if (Array.isArray(p.enum)) {
    const values = p.enum as Json[];
    if (Array.isArray(enumDocs)) {
      values.forEach((v, i) => {
        const d = enumDocs[i];
        if (typeof d === 'string' && d) docs.push({ label: String(v), rule: d });
      });
    } else if (isObj(enumDocs)) {
      for (const v of values) {
        const d = enumDocs[String(v)];
        if (typeof d === 'string' && d) docs.push({ label: String(v), rule: d });
      }
    }
    return { values, docs, sentinels: [], open: false };
  }
  if ('const' in p) return { values: [p.const as Json], docs, sentinels: [], open: false };
  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = p[key];
    if (!Array.isArray(branches) || !branches.length) continue;
    const resolved = branches.map((b) => resolve(b)).filter(isObj);
    const consts: Json[] = [];
    let open = false;
    for (const b of resolved) {
      if ('const' in b) {
        consts.push(b.const as Json);
        const text = typeof b.description === 'string' ? b.description : typeof b.title === 'string' ? b.title : '';
        if (text) docs.push({ label: String(b.const), rule: text });
      } else if (Array.isArray(b.enum)) consts.push(...(b.enum as Json[]));
      else if (typesOf(b).includes('null') && typesOf(b).length === 1) consts.push(null);
      else open = true;
    }
    if (!open) return { values: consts, docs, sentinels: [], open: false };
    return { values: [], docs, sentinels: consts.filter((c): c is string => typeof c === 'string'), open: true };
  }
  const types = typesOf(p);
  if (types.length && types.every((t) => t === 'boolean' || t === 'null')) {
    return { values: [...(types.includes('boolean') ? [true, false] : []), ...(types.includes('null') ? [null] : [])], docs, sentinels: [], open: false };
  }
  return { values: [], docs, sentinels: [], open: true };
}

function kindOf(p: Obj, domain: Domain, name: string): FieldKind {
  if (domain.values.length && !name.endsWith('_text')) return 'categorical';
  const types = typesOf(p).filter((t) => t !== 'null');
  if (!types.length || types.includes('string')) return 'text';
  if (types.every((t) => t === 'number' || t === 'integer')) return 'number';
  if (types.every((t) => t === 'boolean')) return 'boolean';
  return 'json';
}

// ----------------------------------------------------------------- categories

export function titleCase(key: string): string {
  const s = key.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const commentText = (v: unknown): string =>
  typeof v === 'string' ? v : Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(' ') : '';

function categoriesFor(root: Obj, record: Obj, props: Obj, names: string[]): CategoryInfo[] {
  const known = new Set(names);
  const taken = new Set<string>();
  const out: CategoryInfo[] = [];
  const push = (key: string, title: string, description: string, fields: string[]) => {
    const own = fields.filter((n) => known.has(n) && !taken.has(n));
    for (const n of own) taken.add(n);
    if (own.length) out.push({ key, title, description, fields: own });
  };

  // 1. Stages of a progressive abstraction pipeline.
  const xa = root['x-abstraction'] ?? record['x-abstraction'];
  const stages = isObj(xa) && isObj(xa.progressive) ? xa.progressive.stages : null;
  if (isObj(stages)) {
    for (const [key, stage] of Object.entries(stages)) {
      if (isObj(stage) && Array.isArray(stage.fields)) {
        push(key, titleCase(key), commentText(stage.$comment), stage.fields.filter((f): f is string => typeof f === 'string'));
      }
    }
  }
  // 2. Declared groups: x-categories / x-groups as [{key|title, fields}] or {key: [fields]}.
  if (!out.length) {
    const groups = root['x-categories'] ?? root['x-groups'] ?? record['x-categories'] ?? record['x-groups'];
    if (Array.isArray(groups)) {
      groups.forEach((g, i) => {
        if (!isObj(g) || !Array.isArray(g.fields)) return;
        const key = typeof g.key === 'string' ? g.key : typeof g.title === 'string' ? g.title : `group-${i + 1}`;
        push(key, typeof g.title === 'string' ? g.title : titleCase(key), typeof g.description === 'string' ? g.description : '', g.fields.filter((f): f is string => typeof f === 'string'));
      });
    } else if (isObj(groups)) {
      for (const [key, fields] of Object.entries(groups)) {
        if (Array.isArray(fields)) push(key, titleCase(key), '', fields.filter((f): f is string => typeof f === 'string'));
      }
    }
  }
  // 3. Per-property x-category / x-group.
  if (!out.length) {
    const byCat = new Map<string, string[]>();
    for (const n of names) {
      const p = props[n];
      const cat = isObj(p) ? (p['x-category'] ?? p['x-group'] ?? p['x-section']) : undefined;
      if (typeof cat === 'string' && cat.trim()) {
        if (!byCat.has(cat)) byCat.set(cat, []);
        byCat.get(cat)!.push(n);
      }
    }
    for (const [cat, fields] of byCat) push(cat, titleCase(cat), '', fields);
  }
  const leftovers = names.filter((n) => !taken.has(n));
  if (leftovers.length) push(out.length ? 'other' : 'all', out.length ? 'Other fields' : 'Fields', '', leftovers);
  return out;
}

// ----------------------------------------------------------------- rules

/** Property names a subschema refers to (properties keys, required items, dependent keys). */
function referencedFields(node: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 32) return out;
  if (Array.isArray(node)) {
    for (const n of node) referencedFields(n, out, depth + 1);
    return out;
  }
  if (!isObj(node)) return out;
  if (isObj(node.properties)) for (const k of Object.keys(node.properties)) out.add(k);
  if (Array.isArray(node.required)) for (const k of node.required) if (typeof k === 'string') out.add(k);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'properties' && isObj(v)) for (const sub of Object.values(v)) referencedFields(sub, out, depth + 1);
    else if (k !== 'properties' && k !== 'required' && typeof v === 'object') referencedFields(v, out, depth + 1);
  }
  return out;
}

function rulesOf(record: Obj, names: ReadonlySet<string>): RuleInfo[] {
  const blocks = Array.isArray(record.allOf) ? record.allOf : [];
  const out: RuleInfo[] = [];
  blocks.forEach((b, index) => {
    if (!isObj(b) || !('if' in b)) return;
    const keep = (s: Set<string>) => [...s].filter((n) => names.has(n));
    const ifFields = keep(referencedFields(b.if));
    const thenFields = keep(referencedFields([b.then, b.else]));
    const xr = b['x-rule'];
    out.push({
      index,
      number: typeof xr === 'number' || typeof xr === 'string' ? String(xr) : String(index + 1),
      comment: commentText(b.$comment) || (typeof b.description === 'string' ? b.description : ''),
      ifFields,
      thenFields,
      fields: [...new Set([...ifFields, ...thenFields])],
      fix: b['x-fix'] !== undefined,
    });
  });
  return out;
}

// ----------------------------------------------------------------- key

const KEY_NAMES = ['record_id', 'report_id', 'document_id', 'doc_id', 'id', 'filename', 'file_name', 'file', 'report', 'document'];

/** Properties that could be the record key, best first (by name, type and description). */
export function keyFieldCandidates(record: Obj): string[] {
  const props = isObj(record.properties) ? record.properties : {};
  const required = new Set(Array.isArray(record.required) ? record.required.filter((r): r is string => typeof r === 'string') : []);
  const scored = Object.entries(props).map(([name, p], i) => {
    const lower = name.toLowerCase();
    let score = 0;
    const idx = KEY_NAMES.indexOf(lower);
    if (idx >= 0) score += 20 - idx;
    else if (/(^|_)(id|key)$/.test(lower) || /(file|report|document)/.test(lower)) score += 6;
    if (isObj(p)) {
      const t = typesOf(p);
      if (t.includes('integer') || t.includes('string')) score += 1;
      if (Array.isArray(p.enum)) score -= 10;
      const d = typeof p.description === 'string' ? p.description.toLowerCase() : '';
      if (/\b(joins?|links?|key|identifier|filename|file name)\b/.test(d)) score += 4;
    }
    if (required.has(name)) score += 1;
    return { name, score: score - i / 1000 };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => s.name);
}

// ----------------------------------------------------------------- model

export interface SchemaBuildOptions {
  /** Path of the schema to use (default: the best-scoring document). */
  path?: string;
  /** The record key property (default: the best key candidate). */
  keyField?: string;
}

export function rankSchemas(docs: SchemaDocumentInput[]): { path: string; score: number; title: string }[] {
  return docs
    .map((d) => ({ path: d.path, score: schemaScore(d.json), title: isObj(d.json) && typeof d.json.title === 'string' ? d.json.title : '' }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

export function buildSchemaModel(inputs: SchemaDocumentInput[], opts: SchemaBuildOptions = {}): SchemaModel {
  const docs = inputs.filter((d): d is { path: string; json: Obj } => isObj(d.json));
  if (!docs.length) throw new SchemaError('No JSON Schema found.');
  const ranked = rankSchemas(docs);
  const rootPath = opts.path ?? ranked[0]?.path;
  const rootDoc = docs.find((d) => d.path === rootPath);
  if (!rootDoc || !schemaScore(rootDoc.json)) throw new SchemaError(`${rootPath ?? 'The file'} does not read like a JSON Schema of records.`);
  const root = rootDoc.json;
  const resolver = new Resolver(docs);

  // The record schema: the root object, or the items of a root array.
  let recordLoc: Located = { node: root, doc: rootDoc.path, pointer: '' };
  if (!isObj(root.properties) && root.items !== undefined) {
    recordLoc = resolver.resolve({ node: root.items, doc: rootDoc.path, pointer: '/items' });
  }
  const record = recordLoc.node;
  if (!isObj(record) || !isObj(record.properties)) throw new SchemaError(`${rootDoc.path} does not describe records with properties.`);
  const props = record.properties as Obj;
  const names = Object.keys(props);
  const keyField = opts.keyField && names.includes(opts.keyField) ? opts.keyField : (keyFieldCandidates(record)[0] ?? names[0]!);
  const fieldNames = names.filter((n) => n !== keyField);
  if (!fieldNames.length) throw new SchemaError(`${rootDoc.path} declares no fields besides the key.`);
  const required = new Set(Array.isArray(record.required) ? record.required.filter((r): r is string => typeof r === 'string') : []);

  const description = typeof root.description === 'string' ? root.description : typeof record.description === 'string' ? record.description : '';
  const allText = [description, ...fieldNames.map((n) => (isObj(props[n]) ? String((props[n] as Obj).description ?? '') : ''))].join('\n');
  const separator = /\|\|/.test(allText) ? ' || ' : null;

  const categories = categoriesFor(root, record, props, fieldNames);
  const catOf = new Map<string, string>();
  for (const c of categories) for (const f of c.fields) catOf.set(f, c.key);
  // Fields follow the category order (which follows schema order when there are no categories).
  const ordered = categories.flatMap((c) => c.fields);

  const fields: FieldInfo[] = ordered.map((name, order) => {
    const loc = resolver.resolve({ node: props[name], doc: recordLoc.doc, pointer: `${recordLoc.pointer}/properties/${encodeSeg(name)}` });
    const p = isObj(loc.node) ? loc.node : {};
    const domain = domainOf(p, (n) => resolver.resolve({ node: n, doc: loc.doc, pointer: '' }).node);
    const kind = kindOf(p, domain, name);
    const desc = typeof p.description === 'string' ? p.description : '';
    const labels = kind === 'categorical' ? domain.values.map((v) => String(v)) : [];
    const parsed = parseDescription(desc, labels, kind !== 'categorical');
    const docs = [...parsed.docs];
    for (const d of domain.docs) if (!docs.some((x) => x.label.toLowerCase() === d.label.toLowerCase())) docs.push(d);
    const quick = kind === 'text' ? [...new Set([...domain.sentinels, ...assignedLabels(desc)])] : [];
    return {
      name,
      title: typeof p.title === 'string' && p.title.trim() ? p.title : name,
      description: desc,
      definition: parsed.definition,
      valueDocs: docs,
      kind: kind === 'boolean' ? 'categorical' : kind,
      domain: kind === 'categorical' || kind === 'boolean' ? (domain.values.length ? domain.values : [true, false]) : [],
      quickValues: quick,
      multi: kind === 'text' && separator !== null,
      category: catOf.get(name) ?? 'all',
      order,
      required: required.has(name),
      pointer: `${recordLoc.pointer}/properties/${encodeSeg(name)}`,
    };
  });

  // Labels most text fields document as a whole value are the text sentinels.
  const textFields = fields.filter((f) => f.kind === 'text');
  const counts = new Map<string, number>();
  for (const f of textFields) for (const q of f.quickValues) counts.set(q, (counts.get(q) ?? 0) + 1);
  const textSentinels = [...counts].filter(([, c]) => c >= Math.max(1, textFields.length / 2)).map(([q]) => q);

  return {
    title: typeof root.title === 'string' ? root.title : typeof record.title === 'string' ? record.title : rootDoc.path,
    description,
    comment: commentText(root.$comment),
    path: rootDoc.path,
    root,
    recordDoc: recordLoc.doc,
    recordPointer: recordLoc.pointer,
    documents: docs,
    keyField,
    fields,
    byName: new Map(fields.map((f) => [f.name, f])),
    categories,
    rules: rulesOf(record, new Set(fieldNames)),
    separator,
    textSentinels,
  };
}
