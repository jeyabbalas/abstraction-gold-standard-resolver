/** A small synthetic project for the core tests (no real data). */

import { detect } from '../src/core/detect';
import { buildProject } from '../src/core/project';
import { Session, type SessionMeta } from '../src/core/session';
import { DEFAULT_SETTINGS, type CellState, type Settings, type TextFile } from '../src/core/types';

export const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Test abstraction',
  description: 'Shared rules.\nFor text fields, use the shortest exact snippets joined with ( || ). Not identified is the entire value.',
  type: 'object',
  additionalProperties: false,
  required: ['record_id', 'Hysterectomy', 'Cancer', 'Histology', 'Procedure_text', 'Spread', 'Nodes'],
  properties: {
    record_id: { type: 'integer', minimum: 1, description: 'Row key. Joins this record to its report.' },
    Hysterectomy: {
      type: 'string',
      enum: ['Yes', 'No'],
      description: 'Whether a hysterectomy was done.\n\nAssignment rules:\n• Yes: Assign Yes if a hysterectomy is identified.\n• No: Assign No otherwise.',
    },
    Cancer: {
      type: 'string',
      enum: ['Yes', 'No', 'Cannot determine'],
      description: 'Any cancer, e.g. “carcinoma”.\n\nAssignment rules:\n• Yes: A malignancy.\n• No: None.\n• Cannot determine: Unclear.',
    },
    Histology: {
      type: 'string',
      oneOf: [
        { const: 'Endometrioid', description: 'Endometrioid carcinoma.' },
        { const: 'Serous', description: 'Serous carcinoma.' },
        { const: 'Not applicable', description: 'No carcinoma.' },
      ],
      description: 'Histologic subtype.',
    },
    Procedure_text: {
      type: 'string',
      description: "Procedures.\n\nAssignment rules:\n• Reported procedure: Extract snippets. Separate with || only when needed.\n• Not identified: Assign 'Not identified' if none.",
    },
    Spread: { type: 'string', enum: ['Identified', 'Not identified'], description: 'Spread.' },
    Nodes: { type: 'string', enum: ['Identified', 'Not identified'], description: 'Lymph node metastasis.' },
    Comment: { type: 'string', description: 'Optional comment.' },
  },
  allOf: [
    {
      $comment: 'Node metastasis is spread.',
      'x-rule': 7,
      if: { required: ['Nodes'], properties: { Nodes: { const: 'Identified' } } },
      then: { properties: { Spread: { const: 'Identified' } } },
    },
  ],
  'x-abstraction': {
    progressive: {
      stages: {
        procedures: { $comment: 'Procedures.', fields: ['Hysterectomy', 'Procedure_text'] },
        disease: { fields: ['Cancer', 'Histology', 'Spread', 'Nodes'] },
      },
    },
  },
};

const rec = (id: number, o: Record<string, unknown>) => ({
  record_id: id,
  Hysterectomy: 'Yes',
  Cancer: 'Yes',
  Histology: 'Endometrioid',
  Procedure_text: 'TOTAL HYSTERECTOMY || BILATERAL SALPINGO-OOPHORECTOMY',
  Spread: 'Not identified',
  Nodes: 'Not identified',
  ...o,
});

export const REPORTS: Record<string, string> = {
  '1': 'A. UTERUS, TOTAL HYSTERECTOMY:  - ENDOMETRIOID CARCINOMA.    B. OVARIES, BILATERAL SALPINGO-OOPHORECTOMY:  - NO TUMOR.',
  '2': 'A. UTERUS, TOTAL HYSTERECTOMY:  - SEROUS CARCINOMA.\nB. LYMPH NODE: METASTATIC CARCINOMA.',
  '3': 'ENDOMETRIUM, BIOPSY: BENIGN.',
  '4': 'ENDOMETRIUM, BIOPSY: BENIGN.',
};

export function folder(): TextFile[] {
  const a = [
    rec(1, {}),
    rec(2, { Histology: 'Serous', Nodes: 'Identified', Spread: 'Identified' }),
    rec(3, { Hysterectomy: 'No', Cancer: 'No', Histology: 'Not applicable', Procedure_text: 'ENDOMETRIUM, BIOPSY' }),
    rec(4, { Hysterectomy: 'No', Cancer: 'No', Histology: 'Not applicable', Procedure_text: 'ENDOMETRIUM, BIOPSY' }),
  ];
  const b = [
    rec(1, { Procedure_text: 'TOTAL  HYSTERECTOMY || BILATERAL SALPINGO-OOPHORECTOMY' }), // whitespace only
    rec(2, { Histology: 'Endometrioid', Nodes: 'Identified', Spread: 'Not identified' }), // two conflicts
    rec(3, { Hysterectomy: 'No', Cancer: 'Cannot determine', Histology: 'Not applicable', Procedure_text: 'endometrium, biopsy' }),
    rec(4, { Hysterectomy: 'No', Cancer: 'Cannot determine', Histology: 'Not applicable', Procedure_text: 'ENDOMETRIUM, BIOPSY' }),
    rec(5, { Cancer: 'yes' }), // only in b; invalid value
  ];
  return [
    { path: 'schema/test.schema.json', text: JSON.stringify(SCHEMA) },
    { path: 'gold/a.json', text: JSON.stringify(a) },
    { path: 'gold/b.json', text: JSON.stringify(b) },
    { path: 'README.md', text: '# Read me' },
    ...Object.entries(REPORTS).map(([k, t]) => ({ path: `reports/${k}.txt`, text: t })),
  ];
}

export function meta(): SessionMeta {
  return { labels: {}, blindLog: [], terms: {}, activeMs: 0 };
}

export async function makeSession(settings: Partial<Settings> = {}, cells: CellState[] = []): Promise<Session> {
  const files = folder();
  const det = detect('test', files);
  const s: Settings = { ...DEFAULT_SETTINGS, ...settings };
  const project = await buildProject(
    files,
    {
      id: 'p1',
      name: 'Test',
      createdAt: 0,
      seed: 42,
      schemaPath: det.schemaPath!,
      keyField: det.keyField!,
      sources: det.sources.map((src, i) => ({ id: `s${i + 1}`, path: src.path, label: `Source ${i + 1}` })),
      settings: s,
    },
    det,
  );
  return new Session(project, s, meta(), cells, null);
}
