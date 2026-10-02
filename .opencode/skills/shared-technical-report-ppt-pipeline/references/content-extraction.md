# Source extraction and evidence control

## Output set

Create four task-local files before slide writing:

1. `source-index.json` — headings, paragraph ranges, figures, tables, equations.
2. `evidence-ledger.json` — approved claims and numbers with exact source locations.
3. `asset-ledger.json` — figure/table assets, captions, crop instructions, quality.
4. `formula-manifest.json` — source equation, number, variables, semantic styling.

## Complete-reading protocol

1. Extract the full report, including text boxes, captions, tables, footnotes,
   equations, appendices, and embedded media.
2. Confirm the section hierarchy and locate every user-requested topic.
3. Search the extracted text for each outline term and its technical synonyms.
4. Inspect every candidate image at full size; do not select from thumbnails alone.
5. Read the paragraph before and after each figure/table/formula to recover meaning.
6. Reconcile duplicated or conflicting values; record the chosen definition.
7. Mark missing information as `not_provided`; never infer a numeric replacement.

## Keyword extraction

Extract keywords in five layers:

- system objects: sources, networks, loads, storage, devices, markets;
- decisions: commitment, output, purchase/sale, demand response, task scheduling;
- constraints: balance, capacity, ramping, mutual exclusion, state transition;
- uncertainty/risk: forecast error, scenario, CVaR, robustness;
- outcomes: cost, carbon, renewable consumption, peak demand, reliability.

Rank keywords by: explicit user outline > section title > repeated technical noun >
formula variable/caption > contextual term. Merge synonyms only when their technical
meaning is equivalent. Preserve distinctions such as power vs energy, cost vs
payment, carbon constraint vs carbon cost, and heat vs cold.

## Evidence ledger record

```json
{
  "id": "ev-001",
  "type": "claim|number|formula|figure|table",
  "statement": "exact normalized statement",
  "sourceFile": "report.docx",
  "section": "4.4.1",
  "pageOrParagraph": "page 87 / paragraph 4",
  "asset": "media/image42.png",
  "allowedUse": "slide summary|chart|caption|formula",
  "confidence": "high|medium|low",
  "notes": "definition or caveat"
}
```

Every visible quantitative claim and formula must resolve to one ledger record.

## Figure selection order

1. Original report figure with readable resolution.
2. Original report data rebuilt as an editable chart.
3. Individual cropped source asset with image text recreated as editable text.
4. A clearly labeled schematic generated for explanation, never presented as data.
5. A minimal native PowerPoint diagram.

Do not use an AI-generated figure to replace report evidence when the report already
contains the relevant figure.

## Content compression

- Use one primary claim per slide.
- Keep 3–5 supporting statements unless the source layout supports more.
- Convert inventories into causal chains, comparisons, or evidence-to-meaning pairs.
- Preserve technical qualifiers that change meaning.
- Put derivations and variable definitions beside the relevant formula, not in an
  unrelated appendix unless the user requests otherwise.

