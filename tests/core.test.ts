import { describe, expect, it } from 'vitest';
import { detect, reportMatcher } from '../src/core/detect';
import { diffWords } from '../src/core/diff';
import { adjudicationLog, consensusRecords, toCsv } from '../src/core/exporter';
import { reflow, shouldReflow } from '../src/core/markdown';
import { cellPermutation } from '../src/core/random';
import { assignedLabels, buildSchemaModel, parseDescription } from '../src/core/schema';
import { alignSnippets, splitSnippets, TextIndex } from '../src/core/snippets';
import { cohenKappa, fleissKappa } from '../src/core/stats';
import { fieldTerms } from '../src/core/terms';
import { folder, makeSession, SCHEMA } from './helpers';

describe('schema model', () => {
  const model = buildSchemaModel([{ path: 's.json', json: SCHEMA }], { keyField: 'record_id' });

  it('reads fields in category order, kinds and domains', () => {
    expect(model.keyField).toBe('record_id');
    expect(model.fields.map((f) => f.name)).toEqual(['Hysterectomy', 'Procedure_text', 'Cancer', 'Histology', 'Spread', 'Nodes', 'Comment']);
    expect(model.categories.map((c) => c.key)).toEqual(['procedures', 'disease', 'other']);
    expect(model.byName.get('Histology')!.kind).toBe('categorical');
    expect(model.byName.get('Histology')!.domain).toEqual(['Endometrioid', 'Serous', 'Not applicable']);
    expect(model.byName.get('Procedure_text')!.kind).toBe('text');
    expect(model.byName.get('Procedure_text')!.multi).toBe(true);
    expect(model.separator).toBe(' || ');
    expect(model.textSentinels).toEqual(['Not identified']);
  });

  it('parses per-label assignment rules', () => {
    const f = model.byName.get('Cancer')!;
    expect(f.definition).toBe('Any cancer, e.g. “carcinoma”.');
    expect(f.valueDocs.map((d) => d.label)).toEqual(['Yes', 'No', 'Cannot determine']);
    expect(model.byName.get('Histology')!.valueDocs[1]).toEqual({ label: 'Serous', rule: 'Serous carcinoma.' });
    const t = model.byName.get('Procedure_text')!;
    expect(t.valueDocs.map((d) => d.label)).toEqual(['Reported procedure', 'Not identified']);
    expect(t.quickValues).toEqual(['Not identified']);
  });

  it('reads cross-field rules', () => {
    expect(model.rules).toHaveLength(1);
    expect(model.rules[0]!.number).toBe('7');
    expect(model.rules[0]!.ifFields).toEqual(['Nodes']);
    expect(model.rules[0]!.thenFields).toEqual(['Spread']);
  });

  it('parses descriptions without bullets', () => {
    const p = parseDescription('Just a definition.', ['Yes'], false);
    expect(p).toEqual({ definition: 'Just a definition.', docs: [] });
    expect(assignedLabels("Assign 'Not identified' if absent; assign “Unknown primary in unknown site” when…")).toEqual([
      'Not identified',
      'Unknown primary in unknown site',
    ]);
  });

  it('accepts a schema of an array of records', () => {
    const arr = { type: 'array', items: { $ref: '#/$defs/rec' }, $defs: { rec: SCHEMA } };
    const m = buildSchemaModel([{ path: 'a.json', json: arr }]);
    expect(m.recordPointer).toBe('/$defs/rec');
    expect(m.fields).toHaveLength(7);
  });
});

describe('folder detection', () => {
  it('finds the schema, sources, reports and key', () => {
    const det = detect('test', folder());
    expect(det.schemaPath).toBe('schema/test.schema.json');
    expect(det.sources.map((s) => s.path)).toEqual(['gold/a.json', 'gold/b.json']);
    expect(det.keyField).toBe('record_id');
    expect(det.keys[0]!.matched).toBe(4);
    expect(det.reports).toHaveLength(5);
  });

  it('matches report files by stem, name, case and number', () => {
    const files = ['r/007.txt', 'r/Case-A.md', 'r/x.txt'].map((path) => ({
      path,
      name: path.split('/')[1]!,
      stem: path.split('/')[1]!.replace(/\.[^.]+$/, ''),
      dir: 'r',
      format: 'text' as const,
    }));
    const match = reportMatcher(files);
    expect(match('7')?.path).toBe('r/007.txt');
    expect(match('case-a')?.path).toBe('r/Case-A.md');
    expect(match('x.txt')?.path).toBe('r/x.txt');
    expect(match('nope')).toBeUndefined();
  });
});

describe('comparison and session', () => {
  it('classifies cells', async () => {
    const s = await makeSession();
    expect(s.project.records).toEqual(['1', '2', '3', '4', '5']);
    expect(s.comparison('1', 'Procedure_text').status).toBe('agree'); // whitespace only
    expect(s.comparison('2', 'Histology').status).toBe('conflict');
    expect(s.comparison('3', 'Procedure_text').status).toBe('conflict');
    expect(s.comparison('3', 'Procedure_text').minor).toBe(true); // case only
    expect(s.comparison('5', 'Cancer').status).toBe('single');
    expect(s.comparison('5', 'Cancer').candidates[0]!.valid).toBe(false);
    expect(s.comparison('1', 'Comment').status).toBe('empty');
    expect(s.needsReview('1', 'Comment')).toBe(false); // optional
    expect(s.resolution('1', 'Comment').state).toBe('absent');
    expect(s.needsReview('5', 'Cancer')).toBe(true); // invalid single value
    expect(s.needsReview('5', 'Hysterectomy')).toBe(false); // single, accepted
  });

  it('ignores letter case when asked', async () => {
    const s = await makeSession({ textIgnoreCase: true });
    expect(s.comparison('3', 'Procedure_text').status).toBe('agree');
  });

  it('counts progress, decides, propagates to identical reports and undoes', async () => {
    const s = await makeSession();
    const before = s.stats();
    expect(before.review).toBe(before.open);
    // Records 3 and 4 have identical report text: deciding 3 propagates to 4.
    expect(s.project.twins.get('3')).toEqual(['3', '4']);
    s.decide('3', 'Cancer', 'No');
    expect(s.resolution('3', 'Cancer')).toMatchObject({ state: 'decided', value: 'No' });
    expect(s.cell('4', 'Cancer')?.decision).toMatchObject({ kind: 'propagated', from: '3', value: 'No' });
    expect(s.stats().open).toBe(before.open - 2);
    expect(s.cell('3', 'Cancer')!.decision!.snapshot).toEqual({ s1: 'No', s2: 'Cannot determine' });
    // Changing the decision updates the propagated one; undo restores both.
    s.decide('3', 'Cancer', 'Cannot determine');
    expect(s.cell('4', 'Cancer')?.decision?.value).toBe('Cannot determine');
    s.undo();
    expect(s.cell('4', 'Cancer')?.decision?.value).toBe('No');
    s.undo();
    expect(s.cell('3', 'Cancer')).toBeUndefined();
    expect(s.cell('4', 'Cancer')).toBeUndefined();
    expect(s.stats().open).toBe(before.open);
  });

  it('records custom values and blind state', async () => {
    const s = await makeSession({ blind: true });
    s.decide('2', 'Histology', 'Not applicable');
    expect(s.cell('2', 'Histology')!.decision).toMatchObject({ kind: 'custom', blind: true });
    s.decide('2', 'Histology', 'Serous');
    expect(s.cell('2', 'Histology')!.decision!.kind).toBe('candidate');
  });

  it('checks cross-field rules on the consensus', async () => {
    const s = await makeSession();
    // Record 2: Nodes agree (Identified); Spread conflicts → open, so no violation yet.
    expect(s.violations('2')).toEqual([]);
    expect(s.violationsWith('2', 'Spread', 'Not identified').map((v) => v.rule.number)).toEqual(['7']);
    expect(s.violationsWith('2', 'Spread', 'Identified')).toEqual([]);
    s.decide('2', 'Spread', 'Not identified');
    expect(s.violations('2').map((v) => v.fields)).toEqual([['Spread']]);
    expect(s.summary('2').violations).toBe(1);
  });

  it('shuffles candidates per cell, reproducibly', async () => {
    const s = await makeSession({ blind: true });
    const a = s.displayCandidates('2', 'Histology').map((c) => c.index);
    const b = s.displayCandidates('2', 'Histology').map((c) => c.index);
    expect(a).toEqual(b);
    expect(s.displayCandidates('2', 'Histology').map((c) => c.letter)).toEqual(['A', 'B']);
    // Over many cells, both orders occur.
    const firsts = new Set(Array.from({ length: 40 }, (_, i) => cellPermutation(42, String(i), 'F', 2)[0]));
    expect(firsts).toEqual(new Set([0, 1]));
  });

  it('exports consensus records and the log', async () => {
    const s = await makeSession();
    const complete = consensusRecords(s, 'complete');
    expect(complete.map((r) => r.record_id)).toEqual([1]);
    expect(Object.keys(complete[0]!)[0]).toBe('record_id');
    const all = consensusRecords(s, 'all');
    expect(all).toHaveLength(5);
    expect(all[1]!.Histology).toBeNull();
    expect(all[0]).not.toHaveProperty('Comment');
    const log = adjudicationLog(s);
    expect(log.length).toBe(s.stats().review);
    expect(toCsv(log).split('\r\n')[0]).toContain('value: Source 1');
  });
});

describe('snippets, diff, terms, reflow, kappa', () => {
  const spec = { separator: ' || ', sentinels: ['Not identified'] };

  it('splits and locates snippets', () => {
    expect(splitSnippets('A || B || Not identified', spec)).toEqual(['A', 'B']);
    const idx = new TextIndex('A. UTERUS,   TOTAL HYSTERECTOMY:\n - LEIOMYOMA.');
    const loc = idx.locateSnippet('UTERUS, TOTAL HYSTERECTOMY');
    expect(loc.matches[0]).toMatchObject({ start: 3, exact: true });
    expect(idx.locateSnippet('leiomyoma').matches[0]!.caseInsensitive).toBe(true);
  });

  it('aligns snippet lists by report position', () => {
    const idx = new TextIndex('UTERUS. CERVIX. OVARIES. TUBES.');
    const rows = alignSnippets([['UTERUS', 'OVARIES'], ['CERVIX', 'UTERUS', 'ELSEWHERE']], idx);
    expect(rows.map((r) => [r.text, r.members])).toEqual([
      ['UTERUS', [0, 1]],
      ['CERVIX', [1]],
      ['OVARIES', [0]],
      ['ELSEWHERE', [1]],
    ]);
    expect(rows[3]!.located).toBe(false);
  });

  it('diffs words', () => {
    expect(diffWords('BREAST, LEFT 4:00, BIOPSY', 'LEFT 4:00, BIOPSY')).toEqual([
      { type: 'del', text: 'BREAST, ' },
      { type: 'same', text: 'LEFT 4:00, BIOPSY' },
    ]);
  });

  it('suggests search terms', () => {
    const m = buildSchemaModel([{ path: 's.json', json: SCHEMA }]);
    expect(fieldTerms(m.byName.get('Hysterectomy')!).active).toEqual([{ text: 'hysterectomy', needle: 'hysterecto', origin: 'name' }]);
    expect(fieldTerms(m.byName.get('Cancer')!).active.map((t) => t.text)).toEqual(['carcinoma']);
    expect(fieldTerms(m.byName.get('Cancer')!, { off: ['carcinoma'], add: ['malignan'] }).active.map((t) => t.text)).toEqual(['malignan']);
  });

  it('reflows one-line reports', () => {
    const t = 'A. UTERUS, HYSTERECTOMY:  - LEIOMYOMA.  - ADENOMYOSIS.    B. OVARY, OOPHORECTOMY:  - CYST.'.repeat(2);
    expect(shouldReflow(t)).toBe(true);
    expect(reflow('A. UTERUS:  - LEIOMYOMA.    B. OVARY:  - CYST.')).toBe('A. UTERUS:\n- LEIOMYOMA.\n\nB. OVARY:\n- CYST.');
  });

  it('computes kappa', () => {
    expect(cohenKappa([['a', 'a'], ['b', 'b'], ['a', 'b'], ['b', 'a']])).toBeCloseTo(0);
    expect(cohenKappa([['a', 'a'], ['b', 'b']])).toBe(1);
    expect(fleissKappa([['a', 'a', 'a'], ['b', 'b', 'b']])).toBe(1);
  });
});
