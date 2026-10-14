# paper-peer-review changelog

## v8 — Reusable human-feedback checks integrated into every review

- Rechecked the supplied human-review documents, including body edits and tracked changes, against the already distilled generic memory and prior feedback-closure records.
- Organized the preserved lessons as M01–M16 with explicit triggers, verification procedures and completion conditions; stored no private paper content in reusable memory.
- Added common-check and conditional-rule routing to SKILL.md and all three category protocols, so ordinary first reviews also use the relevant knowledge.
- Clarified evidence locations, professional terminology, anonymous engineering cases, symbol-vs-configuration gaps, formula provenance, reviewer-code self-checks, risk units and probability scope, solver status, capacity/settlement/allocation distinctions and small-gain interpretation.
- Added v8 canonical knowledge/feedback traces and structural validation while retaining support for older records; corrected the schema example that had confused missing parameter values with undefined symbol meanings.
- Formal literature auditing remains top-three with venue/version information; user-requested 3–5 download items use a separate expanded list.
- User-requested report/PPT/skill-only scope still determines deliverables; the existing category reproduction and two-slide integration remain available.

## v6 — Two-slide PPT deliverables fused with peer-review workflow

This version extends v5 without removing prior rules. It keeps the four-dimensional, category-specific peer review framework and adds a mandatory per-paper two-slide editable PPTX deliverable.

### Added

- Bundled `integrations/two-slide-paper-ppt-codegen/` from the uploaded `two-slide-paper-ppt-codegen-with-templates.zip` Skill.
- Added `references/two-slide-review-ppt.md` to define how the review Skill invokes the two-slide PPT workflow.
- Each reviewed paper now requires a reproduction-informed two-slide PPTX:
  - slide 1: method/principle/computation/control/optimization flow;
  - slide 2: result analysis using reviewer-side principle-reproduction data when available.
- Slide 2 charts must use reproduction-output data generated during the review. If no responsible numerical reproduction data exist, the slide must use a reproduction-barrier table/metrics module rather than fabricated data.
- Added `presentation` fields to the canonical JSON schema to track PPT generation, data origins, chart data, spec path, and QA status.
- Updated batch ZIP rules: every paper review folder now contains `Two-Slide PPT/` with the final PPTX.
- Upgraded `scripts/package_batch_reviews.py` so manifests must provide a two-slide PPTX path and the script validates that each PPTX contains exactly two slides.

### Preserved

- Paper classification into data science, optimization planning/operation, and system stability/control.
- Claim-evidence audit, variable/symbol audit, data/code availability audit, principle-level reproduction, latest-literature audit, theoretical-analysis audit, and revision/rebuttal mode.
- English papers still generate matched English and Chinese review DOCX files.
- Latest-literature PDF acquisition and unavailable-literature CSV rules remain unchanged.
- Final ZIP still has exactly two first-level folders: `原文/` and `审稿意见/`.


## v5 — category-specific principle reproduction

Major additions:

- mandatory classification into data science, optimization planning/operation, or system stability/control;
- common audit of undefined variables/symbols/units;
- mandatory data/code availability check;
- principle-level independent reproduction that does not require numerical equality with the paper;
- data-science time generalization, data/domain generalization, and parameter-sensitivity audits;
- ESOPT-based optimization-model reconstruction using `https://github.com/yuntaoju2022/smart-energy-system` and mandatory engineering-case provenance audit;
- Modelica/OpenModelica-style principle reproduction for stability/control papers;
- latest literature and theory summary tables restricted to the three most important items;
- English manuscripts require matched English and Chinese review DOCX files;
- per-paper literature PDF evidence bundles remain mandatory in batch delivery;
- updated Word renderer, literature downloader, batch packager, and review validator.
