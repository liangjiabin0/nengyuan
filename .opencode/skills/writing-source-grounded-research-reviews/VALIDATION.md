# Validation Report

## Scope

This package was validated against the three observed failure classes recorded in `tests/skill-evaluation-cases.md`:

1. thematic summary replacing author–year literature review;
2. proposed research methods lacking technical provenance;
3. inconsistent Word equations, fonts, heading colors, tables, and citations.

The package uses a model-led evidence workflow for interpretation and small scripts for mechanical checks.

## Automated Tests

Command:

```bash
python -m unittest discover -s tests -v
```

Result on 2026-08-03:

```text
Ran 17 tests
OK
```

Coverage includes:

- Chinese journal and online-first reference parsing;
- conservative handling of missing bibliographic fields;
- reference-section detection when the table of contents also contains “参考文献”;
- directory input and source-file tracking;
- citation ranges, comma groups, duplicates, unused and missing references;
- Word heading color, Chinese/Latin font split, grid-table detection, superscript citations, and native OMML equation counting;
- skill frontmatter, required supporting files, prompt output contract, and placeholder scan.

## Real-Document Validation

Validation sample:

```text
复杂场景下微电网韧性研究文献综述_作者年份体例修订版.docx
```

Results:

- References parsed: **21**;
- Reference numbers: **1–21**, continuous;
- Citation occurrences: **97**;
- Missing references: **0**;
- Unused references: **0**;
- Duplicate reference numbers: **0**;
- Font issues: **0**;
- Heading color issues: **0**;
- Table-style issues: **0**;
- Non-superscript citation issues: **0**;
- Native OMML equations detected: **4**.

## Commands Used

```bash
python scripts/extract_reference_list.py SAMPLE.docx --json references.json --csv references.csv
python scripts/check_citation_consistency.py SAMPLE.docx --format json --output citation-audit.json
python scripts/inspect_docx_format.py SAMPLE.docx --json format-audit.json
python -m py_compile scripts/*.py
```

## Known Limitations

1. The reference parser is conservative and does not replace manual verification of title pages, DOI, author order, or GB/T 7714 punctuation.
2. PDF full-text extraction is not implemented in the scripts. Use the host platform's native PDF parser and page renderer; OCR remains a last resort.
3. Citation checking targets sequential bracketed numeric citations. Author–date-only systems require adaptation.
4. The Word inspector detects likely formatting issues but cannot fully resolve all theme inheritance, visually judge line weights, or prove the mathematical correctness of an equation.
5. Mixed Chinese/English text in a single run is checked against the run's East Asian and Latin font attributes; unusual field codes or drawing-layer text may require manual inspection.
6. Skill-behavior testing used observed baseline failures from the actual report revision process plus static contract tests. This environment did not provide independent subagents for repeated pressure-scenario runs.

## Deployment Readiness

The skill is ready for installation as a mixed package. The standalone prompt can also be copied independently. Before institutional deployment, run one domain-specific pilot with a different literature set to confirm local reference style, heading hierarchy, and Word template requirements.
