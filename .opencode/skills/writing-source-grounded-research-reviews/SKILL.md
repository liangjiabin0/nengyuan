---
name: writing-source-grounded-research-reviews
description: Use when drafting or revising a Chinese literature review, research-gap report, project research plan, technical route, or Word report from supplied papers, especially when author-year synthesis, sequential citations, source attribution, formulas, and academic formatting must be consistent.
---

# Writing Source-Grounded Research Reviews

## Overview

Produce a research report whose logic is **literature evidence → comparative deficiency → difficult problem → research content → solution and technical route → validation**. The review must read as a literature review, not as a generic project proposal.

## Required Inputs

Identify before drafting:

- research topic and research directions;
- source files and whether outside research is permitted;
- target artifact: outline, report, Word, PDF, or prompt;
- citation standard and formatting requirements;
- any exemplar whose structure or tone must be preserved.

When source files are supplied, treat them as the evidence boundary. Do not silently replace missing evidence with general knowledge.

## Mandatory Workflow

1. **Inventory sources.** Build a bibliographic list and remove duplicates by DOI, exact title, or author–year–title combination.
2. **Create evidence cards.** For every paper extract author, year, object, scenario, method/model, data, solved problem, result, stated limitation, transferable technique, and exact page/section.
3. **Cluster by research subtopic.** Group papers by the problem they address, not merely by publication year.
4. **Write the review in author–year form.** Use the rules in `references/literature-review-style.md`.
5. **Derive deficiencies comparatively.** A deficiency must follow from two or more reviewed papers, or from an explicit limitation in one paper.
6. **Convert deficiencies into difficult problems.** State why the problem is technically hard, not merely that it is understudied.
7. **Design research contents.** Each item must define object, question, inputs/states/decisions, model, method, output, validation, and innovation increment.
8. **Map technical provenance.** Label each method as direct adoption, adapted migration, multi-source synthesis, or proposed extension. Use `references/evidence-and-citation-rules.md`.
9. **Build the technical route.** Every route step must show input → processing/model → algorithm → output → validation and cite its technical basis.
10. **Apply Word rules and run checks.** Use `references/word-format-spec.md` and the scripts in `scripts/`.

## Output Contract

Use `references/report-structure.md` (and `references/output-skeleton.md` when present). For each research direction, preserve this order:

1. research scope and review objective;
2. thematic literature review;
3. remaining deficiencies;
4. key difficult problems;
5. specific research contents;
6. solution ideas and technical route;
7. technical source map;
8. validation plan and expected outputs.

Do not place research contents before the literature-derived deficiencies that justify them.

## Citation Contract

- Use author and year in the sentence and sequential superscript numbers at the claim endpoint.
- Cite quantitative results immediately after the number.
- Cite limitations where they are reported; mark comparative limitations as synthesis.
- Never invent authors, years, pages, methods, results, DOI, or reference entries.
- Keep reference numbering continuous and one-to-one with the final list.

## Quick Reference

| Element | Required shape |
|---|---|
| Literature statement | subtopic + author/year + object + method + solved problem/result + limitation |
| Remaining deficiency | comparison across reviewed studies + missing capability + consequence |
| Difficult problem | technical conflict/uncertainty/coupling/scale barrier + why existing methods fail |
| Research content | object + problem + model + algorithm + output + validation + source |
| Route step | input → method → output → interface/validation + citation/source type |
| Proposed extension | explicitly labeled “proposed extension based on…” |

## Common Mistakes

- **Theme-only summary:** names fields but not authors, years, methods, or results.
- **Bibliography parade:** lists papers without comparing them.
- **Gap-first writing:** decides the innovation before reading the evidence.
- **Source laundering:** presents a proposed method as if a cited paper already used it.
- **Citation dumping:** places many references at a paragraph end without claim-level mapping.
- **Format substitution:** uses typed Unicode equations or grid tables instead of native equations and three-line tables.

## Supporting Files

- Standalone prompt: `references/universal-prompt.md`
- Report hierarchy: `references/report-structure.md`
- Review prose and examples: `references/literature-review-style.md`
- Evidence and citation rules: `references/evidence-and-citation-rules.md`
- Word specification: `references/word-format-spec.md`
- Intermediate templates: `examples/`
- Mechanical checks: `scripts/`
