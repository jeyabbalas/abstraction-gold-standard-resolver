/** Shared types of the adjudication model. */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Canonical (string) form of a record's key value. */
export type RecordKey = string;
export type AbstractionRecord = Record<string, unknown>;

/** A file of the uploaded folder, read as text. Paths are relative to the folder, `/`-separated. */
export interface TextFile {
  path: string;
  text: string;
}

export interface LoadIssue {
  level: 'error' | 'warning' | 'info';
  message: string;
}

// ------------------------------------------------------------------ schema

export type FieldKind = 'categorical' | 'text' | 'number' | 'boolean' | 'json';

/** The rule a data dictionary gives for one label of a field ("• Yes: Assign 'Yes' if…"). */
export interface ValueDoc {
  label: string;
  rule: string;
}

export interface FieldInfo {
  name: string;
  title: string;
  /** The whole property description. */
  description: string;
  /** The description before its "Assignment rules" list. */
  definition: string;
  /** Per-label rules parsed from the description, `oneOf` branches or enum descriptions. */
  valueDocs: ValueDoc[];
  kind: FieldKind;
  /** Allowed values of a categorical field, in schema order. */
  domain: Json[];
  /** Labels a text field documents as whole values (e.g. 'Not identified'). */
  quickValues: string[];
  /** A text value is a list of report snippets joined by the schema's separator. */
  multi: boolean;
  category: string;
  order: number;
  required: boolean;
  /** JSON pointer of the property within the record document (`/properties/<name>`). */
  pointer: string;
}

export interface CategoryInfo {
  key: string;
  title: string;
  description: string;
  fields: string[];
}

/** A cross-field (if/then) rule of the schema. */
export interface RuleInfo {
  /** Index in the record schema's `allOf`. */
  index: number;
  /** Display number: `x-rule` when given, else the position. */
  number: string;
  comment: string;
  ifFields: string[];
  thenFields: string[];
  fields: string[];
  /** `x-fix`: a skip pattern the abstraction enforces. */
  fix: boolean;
}

export interface SchemaModel {
  title: string;
  /** Shared rules: the top-level description. */
  description: string;
  comment: string;
  /** Path of the schema file in the folder. */
  path: string;
  /** The root document. */
  root: Record<string, unknown>;
  /** Path of the document that holds the record (object) schema (usually `path`). */
  recordDoc: string;
  /** JSON pointer of the record schema within `recordDoc`: '' or '/items' or '/$defs/…'. */
  recordPointer: string;
  /** Every schema document of the folder (components a root `$ref`s are resolved against). */
  documents: { path: string; json: Record<string, unknown> }[];
  keyField: string;
  fields: FieldInfo[];
  byName: Map<string, FieldInfo>;
  categories: CategoryInfo[];
  rules: RuleInfo[];
  /** Separator of snippet lists in text values (' || '), or null. */
  separator: string | null;
  /** Labels used as the uninformative default ("Not identified") of text fields. */
  textSentinels: string[];
}

// ------------------------------------------------------------------ project

export interface SourceData {
  id: string;
  path: string;
  fileName: string;
  /** Display name, editable at setup ("Abstractor 1"). */
  label: string;
  hash: string;
  records: Map<RecordKey, AbstractionRecord>;
  /** Key values that appeared more than once (the last record is used). */
  duplicateKeys: RecordKey[];
}

export type ReportFormat = 'text' | 'markdown';

export interface ReportDoc {
  key: RecordKey;
  path: string;
  name: string;
  text: string;
  format: ReportFormat;
}

export type Scenario = 'experts' | 'automated' | 'other';

export interface Settings {
  /** Hide which source proposed each value and shuffle their order. */
  blind: boolean;
  scenario: Scenario;
  /** Text values that differ only in letter case agree. */
  textIgnoreCase: boolean;
  /** Snippet lists that differ only in snippet order agree. */
  textIgnoreOrder: boolean;
  /** Values only one source gave: accepted as-is, or reviewed. */
  singleSource: 'accept' | 'review';
  /** Auto-accept a value this many sources share (0 = off). */
  majority: number;
  /** After a decision, focus the next open conflict. */
  autoAdvance: boolean;
  /** Apply a decision to records whose report text is identical. */
  propagate: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  blind: true,
  scenario: 'automated',
  textIgnoreCase: false,
  textIgnoreOrder: false,
  singleSource: 'accept',
  majority: 0,
  autoAdvance: true,
  propagate: true,
};

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  /** Seed of the per-conflict coin tosses of blind mode. */
  seed: number;
  schema: SchemaModel;
  keyField: string;
  sources: SourceData[];
  reports: Map<RecordKey, ReportDoc>;
  /** Every record some source abstracted, in natural key order. */
  records: RecordKey[];
  /** The original key value of each record (number or string), for the export. */
  keyValues: Map<RecordKey, Json>;
  /** Records with byte-identical report text (each record → its whole group, itself included). */
  twins: Map<RecordKey, RecordKey[]>;
  issues: LoadIssue[];
}

// ------------------------------------------------------------------ comparison

/**
 * - agree: two or more sources gave the value and every one agrees;
 * - single: exactly one source gave a value;
 * - conflict: the sources disagree;
 * - empty: no source gave a value.
 */
export type CellStatus = 'agree' | 'single' | 'conflict' | 'empty';

export interface Candidate {
  /** Comparison key (normalized value). */
  key: string;
  /** The value as a source wrote it (the most common valid variant). */
  value: Json;
  /** Indexes of the sources that gave it. */
  sources: number[];
  /** Allowed by the field's schema. */
  valid: boolean;
}

export interface Comparison {
  record: RecordKey;
  field: string;
  /** Raw value of each source (undefined: the source has no value). */
  values: (Json | undefined)[];
  status: CellStatus;
  /** Distinct values, ordered by their first source. */
  candidates: Candidate[];
  /** The candidates differ only trivially (case, punctuation or snippet order). */
  minor: boolean;
}

// ------------------------------------------------------------------ decisions

export type DecisionKind = 'candidate' | 'custom' | 'propagated';

export interface Decision {
  value: Json;
  /** candidate: one of the sources' values; custom: the adjudicator's own; propagated: from an identical report. */
  kind: DecisionKind;
  /** Made in blind mode. */
  blind: boolean;
  at: number;
  /** Time spent on the cell before deciding (ms, capped). */
  ms?: number;
  /** The record a propagated decision was made on. */
  from?: RecordKey;
  /** Each source's value when the decision was made (absent key: no value). */
  snapshot: Record<string, Json>;
}

/** The adjudicator's state of one cell (stored only once touched). */
export interface CellState {
  record: RecordKey;
  field: string;
  decision?: Decision;
  note?: string;
  flag?: boolean;
  updatedAt: number;
}

export type Resolution =
  | { state: 'decided'; value: Json; decision: Decision }
  | { state: 'auto'; value: Json; reason: 'agree' | 'single' | 'majority' }
  /** No source gave a value and the field is optional: the consensus leaves it out. */
  | { state: 'absent' }
  | { state: 'open' };
