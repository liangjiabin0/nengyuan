# Source-Grounded Chinese Literature Review Skill

This package creates Chinese literature reviews and research reports that preserve the approved style: author–year evidence statements, comparative gap synthesis, research-content design, technical-route attribution, sequential superscript citations, and academic Word formatting.

## Package Contents

```text
literature-review-research-report/
├── SKILL.md
├── README.md
├── references/
│   ├── universal-prompt.md
│   ├── report-structure.md
│   ├── literature-review-style.md
│   ├── evidence-and-citation-rules.md
│   └── word-format-spec.md
├── examples/
│   ├── literature-evidence-matrix-template.md
│   ├── research-section-template.md
│   └── technical-source-map-template.md
├── scripts/
│   ├── extract_reference_list.py
│   ├── check_citation_consistency.py
│   └── inspect_docx_format.py
└── tests/
```

## Installation

This repository already loads the skill from its project-local location:

```text
.opencode/skills/writing-source-grounded-research-reviews/
```

Keep the directory name and the `name` field in `SKILL.md` stable so the skill remains discoverable.

## Typical Invocation

Use this skill when the user supplies papers, a ZIP of literature, a previous report, or a structural exemplar and asks for any of the following:

- a Chinese literature review;
- research gaps and difficult problems;
- project research contents and technical routes;
- a source-attributed research report;
- a Word report with superscript citations, formulas, and three-line tables.

## Standalone Use

`references/universal-prompt.md` is a complete prompt that can be copied into a model without installing the skill. Replace the bracketed input fields and attach the literature files.

## Optional Script Dependencies

```bash
python -m pip install python-docx
```

PDF extraction is intentionally not mandatory. The skill should use the host platform's native PDF parser or visual page reader first; OCR is a last resort.

## Script Examples

Extract a reference list:

```bash
python scripts/extract_reference_list.py report.docx --json references.json --csv references.csv
```

Check citation consistency:

```bash
python scripts/check_citation_consistency.py report.docx --format text
```

Inspect Word formatting:

```bash
python scripts/inspect_docx_format.py report.docx --json format-audit.json
```

Run tests:

```bash
python -m unittest discover -s tests -v
```

## Design Boundary

The scripts perform mechanical extraction and validation only. They do not decide what a paper means, whether a research gap is valid, or whether a proposed method is innovative. Those are evidence-based reasoning tasks governed by `SKILL.md` and the reference modules.
