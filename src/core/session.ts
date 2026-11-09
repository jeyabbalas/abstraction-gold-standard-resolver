/**
 * An adjudication session: a project, the adjudicator's decisions, and
 * everything derived from them — which cells need review, the consensus
 * value of every cell, progress, rule checks, and the blind presentation
 * order of each conflict. Mutations go through the methods here, which
 * persist them (through a {@link SessionStore}) and notify subscribers.
 */

import { agreementKey, agreeingSources, compareCell, isStale, needsReview, resolveCell, type CompareContext } from './compare';
import { cellPermutation } from './random';
import type { SnippetSpec } from './snippets';
import type {
  Candidate,
  CellState,
  Comparison,
  Decision,
  DecisionKind,
  FieldInfo,
  Json,
  Project,
  RecordKey,
  Resolution,
  Settings,
} from './types';
import { createValidators, type RuleViolation, type Validators } from './validate';

export interface SessionMeta {
  /** Display labels of the sources, by source id (editable after setup). */
  labels: Record<string, string>;
  /** When blind mode was switched on or off. */
  blindLog: { at: number; blind: boolean }[];
  /** Where the adjudicator was. */
  cursor?: { record: RecordKey; field?: string };
  /** Report search terms added or switched off, per field. */
  terms: Record<string, { add?: string[]; off?: string[] }>;
  /** Active adjudication time (ms). */
  activeMs: number;
}

export interface SessionStore {
  putCell(cell: CellState): Promise<void>;
  deleteCell(record: RecordKey, field: string): Promise<void>;
  putMeta(settings: Settings, meta: SessionMeta, stats: SessionStats): Promise<void>;
}

export interface SessionStats {
  records: number;
  review: number;
  open: number;
  resolved: number;
  flagged: number;
}

export interface RecordSummary {
  /** Cells that need the adjudicator. */
  review: number;
  /** Review cells without a consensus value yet. */
  open: number;
  /** Cells with a decision. */
  decided: number;
  /** Decisions on a value no source gave. */
  custom: number;
  flagged: number;
  noted: number;
  stale: number;
  /** Cross-field rules the consensus breaks. */
  violations: number;
  conflicts: number;
}

export type SessionEvent =
  | { type: 'cells'; cells: { record: RecordKey; field: string }[] }
  | { type: 'settings'; changed: (keyof Settings)[] }
  | { type: 'meta' }
  | { type: 'saving'; pending: number; error?: string };

export interface DisplayCandidate {
  candidate: Candidate;
  /** A, B, C… by display position. */
  letter: string;
  /** Position in the comparison's candidate list. */
  index: number;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const letterFor = (i: number): string => LETTERS[i] ?? `#${i + 1}`;

/** Longest time one cell may count (an idle tab does not inflate the timing). */
const MAX_CELL_MS = 10 * 60_000;
/** A pause longer than this does not count as active time. */
const IDLE_MS = 3 * 60_000;

interface UndoEntry {
  label: string;
  changes: { record: RecordKey; field: string; before?: CellState; after?: CellState }[];
}

export class Session {
  readonly project: Project;
  readonly spec: SnippetSpec;
  readonly validators: Validators;
  settings: Settings;
  meta: SessionMeta;

  private store: SessionStore | null;
  private readonly cells = new Map<RecordKey, Map<string, CellState>>();
  private comparisons = new Map<RecordKey, Map<string, Comparison>>();
  private readonly summaries = new Map<RecordKey, RecordSummary>();
  private readonly violationCache = new Map<RecordKey, RuleViolation[]>();
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private readonly undoStack: UndoEntry[] = [];
  private pendingSaves = 0;
  private metaTimer: ReturnType<typeof setTimeout> | undefined;
  private focusAt: { record: RecordKey; field: string; at: number } | null = null;
  private lastActive = 0;

  constructor(project: Project, settings: Settings, meta: SessionMeta, cells: CellState[], store: SessionStore | null) {
    this.project = project;
    this.settings = { ...settings };
    this.meta = meta;
    this.store = store;
    this.spec = { separator: project.schema.separator, sentinels: project.schema.textSentinels };
    this.validators = createValidators(project.schema);
    for (const c of cells) {
      let m = this.cells.get(c.record);
      if (!m) this.cells.set(c.record, (m = new Map()));
      m.set(c.field, c);
    }
    this.recompute();
  }

  // ------------------------------------------------------------ events

  subscribe(fn: (e: SessionEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: SessionEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }

  // ------------------------------------------------------------ derived

  get fields(): FieldInfo[] {
    return this.project.schema.fields;
  }

  field(name: string): FieldInfo | undefined {
    return this.project.schema.byName.get(name);
  }

  private context(): CompareContext {
    return {
      sources: this.project.sources,
      settings: this.settings,
      validators: this.validators,
      spec: this.spec,
      field: (n) => this.field(n),
    };
  }

  /** Recompute every comparison and summary (after loading or a settings change). */
  private recompute(): void {
    const ctx = this.context();
    this.comparisons = new Map();
    for (const record of this.project.records) {
      const m = new Map<string, Comparison>();
      for (const f of this.fields) m.set(f.name, compareCell(ctx, record, f.name));
      this.comparisons.set(record, m);
    }
    this.violationCache.clear();
    for (const record of this.project.records) this.summarize(record);
  }

  comparison(record: RecordKey, field: string): Comparison {
    const c = this.comparisons.get(record)?.get(field);
    if (c) return c;
    return compareCell(this.context(), record, field);
  }

  cell(record: RecordKey, field: string): CellState | undefined {
    return this.cells.get(record)?.get(field);
  }

  /** Cells the adjudicator has touched in a record. */
  touched(record: RecordKey): CellState[] {
    return [...(this.cells.get(record)?.values() ?? [])];
  }

  allCells(): CellState[] {
    return [...this.cells.values()].flatMap((m) => [...m.values()]);
  }

  needsReview(record: RecordKey, field: string): boolean {
    return needsReview(this.comparison(record, field), this.field(field), this.settings);
  }

  resolution(record: RecordKey, field: string): Resolution {
    return resolveCell(this.comparison(record, field), this.cell(record, field), this.field(field), this.settings);
  }

  isOpen(record: RecordKey, field: string): boolean {
    return this.needsReview(record, field) && this.resolution(record, field).state === 'open';
  }

  isStale(record: RecordKey, field: string): boolean {
    return isStale(this.comparison(record, field), this.cell(record, field), this.project.sources);
  }

  /** Fields of a record that need review, in field order. */
  reviewFields(record: RecordKey): string[] {
    return this.fields.filter((f) => this.needsReview(record, f.name)).map((f) => f.name);
  }

  summary(record: RecordKey): RecordSummary {
    return this.summaries.get(record) ?? this.summarize(record);
  }

  private summarize(record: RecordKey): RecordSummary {
    const s: RecordSummary = { review: 0, open: 0, decided: 0, custom: 0, flagged: 0, noted: 0, stale: 0, violations: 0, conflicts: 0 };
    for (const f of this.fields) {
      const cmp = this.comparison(record, f.name);
      const cell = this.cell(record, f.name);
      if (cmp.status === 'conflict') s.conflicts += 1;
      if (needsReview(cmp, f, this.settings)) {
        s.review += 1;
        if (resolveCell(cmp, cell, f, this.settings).state === 'open') s.open += 1;
      }
      if (cell?.decision) {
        s.decided += 1;
        if (cell.decision.kind === 'custom') s.custom += 1;
        if (isStale(cmp, cell, this.project.sources)) s.stale += 1;
      }
      if (cell?.flag) s.flagged += 1;
      if (cell?.note) s.noted += 1;
    }
    this.violationCache.delete(record);
    s.violations = this.violations(record).length;
    this.summaries.set(record, s);
    return s;
  }

  stats(): SessionStats {
    let review = 0;
    let open = 0;
    let flagged = 0;
    for (const r of this.project.records) {
      const s = this.summary(r);
      review += s.review;
      open += s.open;
      flagged += s.flagged;
    }
    return { records: this.project.records.length, review, open, resolved: review - open, flagged };
  }

  // ------------------------------------------------------------ consensus

  /** The consensus record: the key, then every resolved field (open fields omitted unless `withOpen`). */
  consensusRecord(record: RecordKey, opts: { withKey?: boolean; withOpen?: boolean } = {}): Record<string, Json> {
    const out: Record<string, Json> = {};
    if (opts.withKey) out[this.project.keyField] = this.project.keyValues.get(record) ?? record;
    for (const f of this.fields) {
      const r = this.resolution(record, f.name);
      if (r.state === 'decided' || r.state === 'auto') out[f.name] = r.value;
      else if (r.state === 'open' && opts.withOpen) out[f.name] = null;
    }
    return out;
  }

  /** Cross-field rules the record's consensus breaks. */
  violations(record: RecordKey): RuleViolation[] {
    let v = this.violationCache.get(record);
    if (!v) {
      v = this.project.schema.rules.length ? this.validators.violations(this.consensusRecord(record)) : [];
      this.violationCache.set(record, v);
    }
    return v;
  }

  /** Rules involving `field` that the consensus would break with `value` there. */
  violationsWith(record: RecordKey, field: string, value: Json): RuleViolation[] {
    if (!this.project.schema.rules.length) return [];
    const rec = this.consensusRecord(record);
    rec[field] = value;
    return this.validators.violations(rec, field);
  }

  /** Records with identical report text whose consensus differs for `field`. */
  twinDisagreements(record: RecordKey, field: string): { record: RecordKey; value: Json | undefined }[] {
    const group = this.project.twins.get(record);
    if (!group) return [];
    const mine = this.resolution(record, field);
    if (mine.state !== 'decided' && mine.state !== 'auto') return [];
    const key = agreementKey(this.field(field), mine.value, this.settings, this.spec);
    const out: { record: RecordKey; value: Json | undefined }[] = [];
    for (const other of group) {
      if (other === record) continue;
      const r = this.resolution(other, field);
      if (r.state !== 'decided' && r.state !== 'auto') continue;
      if (agreementKey(this.field(field), r.value, this.settings, this.spec) !== key) out.push({ record: other, value: r.value });
    }
    return out;
  }

  // ------------------------------------------------------------ presentation

  /** The candidates in display order: shuffled per cell in blind mode, else by their first source. */
  displayCandidates(record: RecordKey, field: string): DisplayCandidate[] {
    const cands = this.comparison(record, field).candidates;
    const order = this.settings.blind ? cellPermutation(this.project.seed, record, field, cands.length) : cands.map((_, i) => i);
    return order.map((index, pos) => ({ candidate: cands[index]!, letter: letterFor(pos), index }));
  }

  sourceLabel(index: number): string {
    const s = this.project.sources[index];
    if (!s) return `Source ${index + 1}`;
    return this.meta.labels[s.id] ?? s.label;
  }

  // ------------------------------------------------------------ mutations

  private putCell(cell: CellState | undefined, record: RecordKey, field: string): void {
    let m = this.cells.get(record);
    if (cell) {
      if (!m) this.cells.set(record, (m = new Map()));
      m.set(field, cell);
    } else m?.delete(field);
    const empty = cell && !cell.decision && !cell.note && !cell.flag;
    if (empty) m?.delete(field);
    this.save(cell && !empty ? this.store?.putCell(cell) : this.store?.deleteCell(record, field));
  }

  private save(p: Promise<void> | undefined): void {
    if (!p) return;
    this.pendingSaves += 1;
    this.emit({ type: 'saving', pending: this.pendingSaves });
    p.then(
      () => {
        this.pendingSaves -= 1;
        this.emit({ type: 'saving', pending: this.pendingSaves });
      },
      (err: Error) => {
        this.pendingSaves -= 1;
        this.emit({ type: 'saving', pending: this.pendingSaves, error: err?.message ?? String(err) });
      },
    );
  }

  get saving(): number {
    return this.pendingSaves;
  }

  private snapshot(record: RecordKey, field: string): Record<string, Json> {
    const cmp = this.comparison(record, field);
    const out: Record<string, Json> = {};
    this.project.sources.forEach((s, i) => {
      const v = cmp.values[i];
      if (v !== undefined) out[s.id] = v;
    });
    return out;
  }

  /** Whether `value` is one of the cell's candidates (else it is the adjudicator's own). */
  kindFor(record: RecordKey, field: string, value: Json): DecisionKind {
    const cmp = this.comparison(record, field);
    const key = agreementKey(this.field(field), value, this.settings, this.spec);
    return cmp.candidates.some((c) => c.key === key) ? 'candidate' : 'custom';
  }

  /** The adjudicator focused a cell (starts its timer). */
  focus(record: RecordKey, field: string | null): void {
    if (field && (this.focusAt?.record !== record || this.focusAt.field !== field)) this.focusAt = { record, field, at: Date.now() };
    if (this.meta.cursor?.record !== record || this.meta.cursor.field !== (field ?? undefined)) {
      this.meta.cursor = { record, field: field ?? undefined };
      this.saveMetaSoon();
    }
  }

  /** Count active time: call on user activity. */
  activity(): void {
    const now = Date.now();
    if (this.lastActive && now - this.lastActive < IDLE_MS) {
      this.meta.activeMs += now - this.lastActive;
      this.saveMetaSoon(4000);
    }
    this.lastActive = now;
  }

  /** Decide a cell's consensus value. Propagates to identical reports when the setting is on. */
  decide(record: RecordKey, field: string, value: Json): void {
    const now = Date.now();
    const before = this.cell(record, field);
    const ms = this.focusAt && this.focusAt.record === record && this.focusAt.field === field ? Math.min(MAX_CELL_MS, now - this.focusAt.at) : undefined;
    const decision: Decision = {
      value,
      kind: this.kindFor(record, field, value),
      blind: this.settings.blind,
      at: now,
      ms: before?.decision?.ms !== undefined && ms !== undefined ? before.decision.ms + ms : ms,
      snapshot: this.snapshot(record, field),
    };
    const after: CellState = { ...(before ?? { record, field }), record, field, decision, updatedAt: now };
    const changes: UndoEntry['changes'] = [{ record, field, before, after }];
    this.putCell(after, record, field);
    if (this.focusAt && this.focusAt.record === record && this.focusAt.field === field) this.focusAt.at = now;
    changes.push(...this.propagate(record, field, value, now));
    this.commit({ label: 'decision', changes });
  }

  /** Apply (or update) a decision on the identical-text twins whose cell is open or was propagated from here. */
  private propagate(record: RecordKey, field: string, value: Json | undefined, now: number): UndoEntry['changes'] {
    const group = this.project.twins.get(record);
    if (!group || !this.settings.propagate) return [];
    const out: UndoEntry['changes'] = [];
    for (const other of group) {
      if (other === record) continue;
      const before = this.cell(other, field);
      const fromHere = before?.decision?.kind === 'propagated' && before.decision.from === record;
      if (before?.decision && !fromHere) continue;
      if (value === undefined) {
        if (!fromHere) continue;
        const { decision: _drop, ...rest } = before!;
        const after: CellState = { ...rest, updatedAt: now };
        this.putCell(after, other, field);
        out.push({ record: other, field, before, after });
        continue;
      }
      if (!fromHere && !this.isOpen(other, field)) continue;
      const after: CellState = {
        ...(before ?? { record: other, field }),
        record: other,
        field,
        decision: { value, kind: 'propagated', blind: this.settings.blind, at: now, from: record, snapshot: this.snapshot(other, field) },
        updatedAt: now,
      };
      this.putCell(after, other, field);
      out.push({ record: other, field, before, after });
    }
    return out;
  }

  /** Remove a cell's decision (it falls back to the automatic resolution, or open). */
  clearDecision(record: RecordKey, field: string): void {
    const before = this.cell(record, field);
    if (!before?.decision) return;
    const now = Date.now();
    const { decision: _drop, ...rest } = before;
    const after: CellState = { ...rest, updatedAt: now };
    this.putCell(after, record, field);
    const changes: UndoEntry['changes'] = [{ record, field, before, after }, ...this.propagate(record, field, undefined, now)];
    this.commit({ label: 'clear', changes });
  }

  setNote(record: RecordKey, field: string, note: string): void {
    const before = this.cell(record, field);
    const text = note.trim();
    if ((before?.note ?? '') === text) return;
    const after: CellState = { ...(before ?? { record, field }), record, field, note: text || undefined, updatedAt: Date.now() };
    this.putCell(after, record, field);
    this.commit({ label: 'note', changes: [{ record, field, before, after }] });
  }

  toggleFlag(record: RecordKey, field: string, on?: boolean): void {
    const before = this.cell(record, field);
    const flag = on ?? !before?.flag;
    if (!!before?.flag === flag) return;
    const after: CellState = { ...(before ?? { record, field }), record, field, flag: flag || undefined, updatedAt: Date.now() };
    this.putCell(after, record, field);
    this.commit({ label: flag ? 'flag' : 'unflag', changes: [{ record, field, before, after }] });
  }

  /** Accept a stale decision as still right for the current source values. */
  reconfirm(record: RecordKey, field: string): void {
    const d = this.cell(record, field)?.decision;
    if (d) this.decide(record, field, d.value);
  }

  private commit(entry: UndoEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.afterChange(entry.changes);
  }

  private afterChange(changes: UndoEntry['changes']): void {
    const records = new Set(changes.map((c) => c.record));
    for (const r of records) this.summarize(r);
    this.saveMetaSoon();
    this.emit({ type: 'cells', cells: changes.map((c) => ({ record: c.record, field: c.field })) });
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Revert the last change; returns the cell it was about (to refocus), or null. */
  undo(): { record: RecordKey; field: string; label: string } | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    for (const c of [...entry.changes].reverse()) this.putCell(c.before, c.record, c.field);
    this.afterChange(entry.changes);
    const first = entry.changes[0]!;
    return { record: first.record, field: first.field, label: entry.label };
  }

  // ------------------------------------------------------------ settings and meta

  updateSettings(patch: Partial<Settings>): void {
    const changed = (Object.keys(patch) as (keyof Settings)[]).filter((k) => patch[k] !== undefined && patch[k] !== this.settings[k]);
    if (!changed.length) return;
    this.settings = { ...this.settings, ...patch };
    if (changed.includes('blind')) this.meta.blindLog.push({ at: Date.now(), blind: this.settings.blind });
    if (changed.some((k) => k === 'textIgnoreCase' || k === 'textIgnoreOrder')) this.recompute();
    else if (changed.some((k) => k === 'singleSource' || k === 'majority')) for (const r of this.project.records) this.summarize(r);
    this.saveMetaSoon(0);
    this.emit({ type: 'settings', changed });
  }

  setLabel(sourceId: string, label: string): void {
    this.meta.labels[sourceId] = label.trim() || (this.project.sources.find((s) => s.id === sourceId)?.label ?? sourceId);
    this.saveMetaSoon(0);
    this.emit({ type: 'meta' });
  }

  setTerms(field: string, terms: { add?: string[]; off?: string[] }): void {
    this.meta.terms[field] = terms;
    this.saveMetaSoon(0);
    this.emit({ type: 'meta' });
  }

  saveMetaSoon(ms = 800): void {
    clearTimeout(this.metaTimer);
    this.metaTimer = setTimeout(() => this.flushMeta(), ms);
  }

  flushMeta(): void {
    clearTimeout(this.metaTimer);
    this.save(this.store?.putMeta(this.settings, this.meta, this.stats()));
  }

  /** Stop persisting (the session was closed or deleted). */
  detach(): void {
    clearTimeout(this.metaTimer);
    this.store = null;
    this.listeners.clear();
  }

  /** Sources whose value equals the consensus of a cell. */
  agreeingSources(record: RecordKey, field: string, value: Json): number[] {
    return agreeingSources(this.comparison(record, field), value, this.field(field), this.settings, this.spec);
  }
}
