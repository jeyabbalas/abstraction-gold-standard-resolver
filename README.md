# Gold Standard Resolver

A browser app in which a domain expert, the adjudicator, reconciles competing abstractions of the same reports into a
consensus gold standard for structured extraction from medical reports. The app shows only the disagreements, next to the
report.

**Live app:** https://jeyabbalas.github.io/abstraction-gold-standard-resolver/

Everything runs in your browser. The app reads reports, the schema and the abstractions from your disk and never uploads
them. Sessions are saved in this browser (IndexedDB), so you can close the tab and pick up where you left off.

## Two ways to use it

- **Several experts' gold standards.** Each expert abstracted the same reports. As a third-party adjudicator, you settle
  every value they disagree on.
- **A human gold standard and an automated pipeline.** You compare the human abstraction with the best pipeline's
  output, and the pipeline's value can win. In this case, hiding the source of each value (blind review) keeps the
  verdict fair.

Either way, you can overrule every source and enter your own value.

## The project folder

Choose a folder (or a `.zip` of it), or drop it onto the page:

```
my_project/
├── data_dictionary.json     JSON Schema of one record (or of the array of records)
├── reports/                 one report per record: <key>.txt or <key>.md
└── gold_standards/          two or more abstractions to reconcile
    ├── abstractor_1.json    a JSON array of records
    └── abstractor_2.json
```

Folder and file names don't matter. The app tells the files apart by their content: the schema, the abstractions (JSON
arrays of records), and the reports (`.txt`, `.md`). It also picks the property that links each record to its report
file, such as `record_id` matching `17.txt`. You can change every guess on the setup screen, which also previews how
many cells will need you before you start.

The JSON Schema drives the whole app:

- **Fields.** Every property except the key is a field, in schema order.
- **Categorical vs. free text.** A field is categorical if it has a closed domain (`enum`, `const`, `oneOf`/`anyOf`
  consts, boolean). Any other string is free text. A text field holds a list of report snippets when its values join
  snippets with ` || `.
- **Assignment rules.** Each label's rule comes from the description's bullet list (`• Yes: Assign 'Yes' if…`), from
  `oneOf` branch descriptions or from enum descriptions. Rules are shown next to every candidate value.
- **Groups.** Fields are grouped by `x-abstraction.progressive.stages`, by `x-category`, or into a single group.
- **Cross-field rules.** The record schema's `allOf` `if`/`then` blocks (with optional `x-rule` text) are checked on
  the consensus as you decide.

## Adjudicating

A cell (one record × one field) needs you when:

- the sources disagree;
- a required value is missing;
- the value they agree on breaks the schema; or
- only one source gave a value, if you ask to review those.

Cells where the sources agree are accepted automatically. With three or more sources, you can also auto-accept a value
that a majority shares. Values that differ only in letter case, punctuation or snippet order are marked as a *minor
difference*, and the settings can treat case and snippet order as agreement.

For each record, the report is shown on the left and the open cells on the right:

- **Highlighting.** The report highlights each candidate's snippets in that candidate's color and highlights search
  terms suggested by the field.
- **Text fields.** Snippet lists are aligned in a table by where the snippets occur in the report. Snippets that are not
  in the report are flagged.
- **Your own value.** Choose from the domain, compose it from the candidates' snippets, or select text in the report and
  add it.
- **Notes and flags.** Add a note or a flag to any cell.
- **Navigation.** The minimap in the toolbar shows every record and its progress. Filters (open conflicts, flagged, with
  notes, rule violations, …) and a field scope narrow the queue.
- **Identical reports.** A decision also applies to records whose report text is byte-identical (an option you can turn
  off).
- **Reflow.** One-line plain-text reports are reflowed into their parts and bullets. Only whitespace changes, so
  snippets still match.

### Blind review

Blind review is on by default. Candidates are labeled A, B, C instead of by source, and a seeded coin toss per cell sets
their order. Statistics that name the sources stay locked until you reveal them. Every decision records whether it was
made blind, and every change of mode is logged. For several anonymous expert files, blind review is optional.

### Keyboard

| Keys            | Action                                    |
|-----------------|-------------------------------------------|
| `1`–`9`         | choose a candidate                        |
| `o`             | your own value                            |
| `x`             | clear the decision                        |
| `f` / `m`       | flag / note                               |
| `z` (`⌘Z`)      | undo                                      |
| `j` / `k`       | next / previous field                     |
| `n` / `p`       | next / previous record                    |
| `Enter`         | next record, once this one is complete    |
| `g`             | go to a record                            |
| `/`             | search the report                         |
| `w`             | reflow the report on or off               |
| `+` / `−`       | text size                                 |
| `a`             | show the fields that agree                |
| `?`             | all shortcuts                             |

## Views

- **Adjudicate:** the report and the open cells, one record at a time.
- **Overview:** progress, your pace, where the sources disagree (a map of every cell and a table per field), what needs
  attention (flags, notes, rule violations, stale decisions), and agreement between the sources (locked during blind
  review).
- **Dictionary:** the data dictionary rendered from the JSON Schema
  ([`json-schema-data-dictionary`](https://www.npmjs.com/package/json-schema-data-dictionary)), with the shared and
  cross-field rules.

## Sessions

The start page lists the sessions saved in this browser. Decisions are saved as you make them. The files can be kept in
the browser too, so that resuming doesn't ask for the folder again. Otherwise you choose the folder again, and the app
tells you if an abstraction file changed. A decision whose candidates have since changed is marked *stale* until you
keep it or decide again.

**Back up session…** saves the session as one JSON file: decisions, notes, settings, and the files if they were kept.
Restore it from the start page in any browser.

## Export

**Export** downloads a `.zip` with:

- `<session>_consensus.json`: the consensus gold standard, a JSON array of records in the schema's shape. It holds
  either the complete records only, or all records with open cells set to `null`.
- `<session>_adjudication_log.csv`: one row per reviewed cell, with every source's value, the consensus, how it was
  reached (agreement, majority, your choice, your own value, identical report), whether it was blind, time taken, the
  flag and the note.
- `<session>_summary.json`: counts, settings, the history of blind mode, and agreement statistics (per field, between
  pairs of sources, and of each source with the consensus; κ per field).

## Demo data

The start page offers two demos built from **synthetic** data: invented gynecologic pathology reports, a 24-field schema
with cross-field rules, and abstractions with seeded disagreements. One demo has three experts; the other pairs a human
with an LLM pipeline. No real patient data is involved. `npm run demo` regenerates it into `public/demo/` from
`scripts/generate-demo.mjs`.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest
npm run build      # type-check and build into dist/
```

Built with TypeScript and Vite, without a UI framework. Libraries: [Ajv](https://ajv.js.org/) (validation),
[idb](https://github.com/jakearchibald/idb) (IndexedDB), [fflate](https://github.com/101arrowz/fflate) (zip),
[markdown-it](https://github.com/markdown-it/markdown-it) (Markdown reports, raw HTML shown as text). Report highlighting
uses the CSS Custom Highlight API, available in current Chrome, Edge, Safari and Firefox.

Every push to `main` is tested, built and deployed to GitHub Pages by `.github/workflows/deploy.yml`.

## License

MIT
