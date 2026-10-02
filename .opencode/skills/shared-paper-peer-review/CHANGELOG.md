# paper-peer-review changelog

## v3 — 2026-09-03

### Four mandatory scientific review dimensions

The skill now makes four dimensions central to scientific review:

1. experimental evidence must support central conclusions;
2. the central workflow/results must be reproducible or auditable;
3. the manuscript must be positioned against the latest genuinely relevant literature and, when claiming superiority, compared against sufficiently strong recent baselines;
4. formal properties must be supported by valid theoretical derivation/proof when such guarantees are claimed.

### New latest-literature audit

- current external verification is enabled by default for standard/deep review;
- separates recent citation coverage from actual experimental baseline comparison;
- checks relevance, recency, credibility, and comparison fairness;
- never guesses state-of-the-art status when external research is disabled.

### New theoretical-analysis audit

- maps each theoretical claim to its derivation/proof and assumptions;
- checks stability, convergence, optimality, feasibility, robustness, complexity, equilibrium, and other formal guarantees when applicable;
- cross-checks theoretical assumptions against experiment/simulation settings;
- avoids demanding theorem-level proof for purely empirical claims.

### Batch Word workflow

- Chinese manuscript -> Chinese review; English manuscript -> English review;
- user-provided DOCX is used as the review style/layout template;
- generated review structure includes all four core audits;
- revision/rebuttal packages are reviewed as a response-closure chain;
- final ZIP contains exactly `原文/` and `审稿意见/`;
- primary manuscripts are renamed to formal paper titles;
- review files are named `论文正式题目审稿意见.docx`;
- supporting rebuttal/previous-review files are used as evidence but are not separate paper deliverables by default;
- all Word outputs require render-and-visual QA.

### Added references and scripts

- `references/latest-literature-comparison.md`
- `references/theoretical-analysis.md`
- `references/batch-word-delivery.md`
- `references/experimental-support-reproducibility.md`
- `scripts/render_word_report.py`
- `scripts/package_batch_reviews.py`
