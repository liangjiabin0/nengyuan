# Batch Word Review Delivery Protocol

Use this protocol whenever a ZIP/package contains multiple manuscripts and the requested deliverable is Word review comments plus a final ZIP.

## 1. Identify manuscript groups

Group files by paper identity rather than treating every file as a separate paper. A group may contain:

- current manuscript;
- previous manuscript version;
- previous reviewer comments;
- author response/rebuttal;
- revision notes;
- supplementary material.

Only the **current primary manuscript** counts as the paper deliverable. Supporting review-chain files are evidence.

## 2. Paper title and language

Extract the formal paper title from the manuscript itself.

- Rename the primary manuscript to the formal title, preserving its extension.
- Detect the dominant manuscript language from the body.
- Chinese body -> Chinese review.
- English body -> English review.

Do not infer language solely from file name.

## 3. Word template

If a review-comment template DOCX is provided:

- use it as the layout/style source;
- preserve section size/orientation/margins;
- preserve header/footer, page-number conventions, paragraph spacing, heading hierarchy, and table visual conventions;
- preserve appropriate Chinese/Western font behavior where possible;
- replace substantive template text with the new paper-specific review;
- do not inherit the template's paper title, findings, recommendation, or evidence.

A generated Word review should normally contain:

1. paper review heading and title;
2. manuscript type/review focus/recommendation summary if present in the template;
3. overall assessment;
4. central conclusion-experiment evidence matrix;
5. reproducibility audit;
6. latest literature/comparator audit;
7. theoretical analysis audit;
8. major comments;
9. minor comments;
10. final recommendation;
11. for revisions, prior-issue closure summary where useful.

## 4. DOCX QA

Every final Word file must follow the document workflow:

1. generate/edit DOCX;
2. render every page to PNG;
3. inspect every page at 100% zoom;
4. fix clipping, broken tables, bad pagination, missing glyphs, spacing drift, header/footer problems;
5. re-render until clean.

Do not ship QA PNGs unless explicitly requested.

## 5. Final ZIP contract

Final ZIP first-level structure must be exactly:

```text
原文/
审稿意见/
```

Naming:

```text
原文/论文正式题目.<original extension>
审稿意见/论文正式题目审稿意见.docx
```

Supporting author responses or previous comments are not copied as separate deliverables by default.

Before packaging, assert:

- number of primary manuscript files == number of review DOCX files;
- every title matches its review;
- no temporary files, JSON, HTML, scripts, QA images, or extra first-level folders remain;
- ZIP integrity test passes.
