# Batch Review Word, PPT, and ZIP Delivery

## Primary manuscript selection

For each paper, identify exactly one current primary manuscript. Revision responses, marked manuscripts, old comments, and supplementary explanations are evidence inputs, not independent papers unless explicitly requested.

Rename the copied primary manuscript to the formal paper title while preserving extension.

## Language deliverables

### Chinese manuscript

One review DOCX:

`<论文题目>审稿意见.docx`

One two-slide PPTX by default:

`Two-Slide PPT/<论文题目>_Two-Slide_Review.pptx`

### English manuscript

Two scientifically matched review DOCX files:

- `<Formal Paper Title>_Review_English.docx`
- `<Formal Paper Title>审稿意见_中文.docx`

Issue IDs, severity, conclusions, evidence, and required actions must correspond exactly.

One two-slide PPTX by default:

- `Two-Slide PPT/<Formal Paper Title>_Two-Slide_Review.pptx`

Generate separate English/Chinese PPTX versions only when explicitly requested or when the project setting requires it.

## Template

When a review DOCX template is supplied, use it as the visual style basis. Preserve professional fonts, heading hierarchy, table style, margins, and footer/header conventions while inserting the required sections.

For two-slide PPTX delivery, use the bundled two-slide codegen integration and any supplied/bundled editable slide templates as visual style references. The PPTX must be editable and must pass the QA gate in [two-slide-review-ppt.md](two-slide-review-ppt.md).

## Final ZIP contract

Exactly two first-level folders:

```text
原文/
审稿意见/
```

Each paper receives one review folder containing its review DOCX file(s), `Latest Relevant Literature/`, and `Two-Slide PPT/`.

Recommended structures:

```text
原文/<论文正式题目>.<original extension>
审稿意见/<论文正式题目>审稿意见/
  <论文正式题目>审稿意见.docx
  Latest Relevant Literature/
    01_<文献标题>.pdf
    无法下载文献清单.csv
  Two-Slide PPT/
    <论文正式题目>_Two-Slide_Review.pptx
```

```text
原文/<Formal Paper Title>.<original extension>
审稿意见/<Formal Paper Title>审稿意见/
  <Formal Paper Title>_Review_English.docx
  <Formal Paper Title>审稿意见_中文.docx
  Latest Relevant Literature/
    01_<literature-title>.pdf
    无法下载文献清单.csv
  Two-Slide PPT/
    <Formal Paper Title>_Two-Slide_Review.pptx
```

No temporary JSON, HTML, scripts, QA images, working manifests, or response files should remain in the final ZIP unless explicitly requested. The final PPTX is a required artifact, not a temporary file.

Before packaging verify:

- primary-paper count equals review-folder count;
- paper titles and folder names match;
- language deliverables match manuscript language;
- every formal latest-literature item has a PDF or unavailable CSV row;
- every paper folder contains a two-slide PPTX under `Two-Slide PPT/`;
- each two-slide PPTX is exactly two slides and has passed visual/editability QA;
- slide 2 result charts use reviewer-side reproduction data or a documented reproduction-barrier table;
- ZIP integrity passes.

## Human-feedback report-only reassessment

Follow the scoped reassessment rule in SKILL.md. Set manifest `ppt_required=false` when the requested reassessment outputs exclude slides. Include requested Markdown paths through `review_md_path` / `review_md_path_zh` / `review_md_path_en`; regenerate paired content and avoid stale presentation data.
