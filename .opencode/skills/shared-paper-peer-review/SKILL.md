---
name: paper-peer-review
description: "Conduct evidence-grounded academic peer review with four mandatory scientific audits: experimental support for conclusions, reproducibility, comparison against the latest relevant literature, and theoretical support. Supports single manuscripts and batch ZIP review workflows, revision/rebuttal re-review, multilingual review, canonical JSON/HTML, and Word review reports based on a user-provided template."
---

# Evidence-Grounded Paper Peer Review

Review a manuscript as an evidence verifier, not a prose critic. For empirical, computational, method, optimization, control, simulation, and engineering papers, the review is organized around four core questions:

1. **Experimental support:** Do the experiments, simulations, benchmarks, or analyses actually support the paper's central conclusions?
2. **Reproducibility:** Could an independent researcher reproduce or meaningfully audit the main results without consequential guesswork?
3. **Latest-work comparison:** Has the manuscript compared itself with sufficiently recent, strong, and genuinely relevant work, rather than only citing it?
4. **Theoretical support:** Where the paper claims theoretical properties, do derivations, proofs, assumptions, or analytical arguments actually establish those properties?

Novelty, writing quality, presentation, and formatting remain important, but they must not compensate for unsupported central conclusions, missing decisive baselines, unauditable results, or invalid theoretical claims.

## 1. Review setup

Accept a PDF, DOCX, LaTeX, Markdown, text manuscript, pasted manuscript, publisher/arXiv link, or a ZIP containing multiple manuscripts and supporting review/rebuttal files.

Infer safe defaults rather than asking unnecessary questions. Default configuration:

```text
审稿设置 / Review setup
- 目标场景: 通用学术审稿
- 输出语言: 跟随论文主体语言
- 审稿深度: 标准
- 最新文献核查: 开启
- 复现核验: 基于论文与已提供工件
- 理论分析: 按论文声明的理论性质进行
- 单篇默认输出: Word + JSON
- 批量默认输出: Word + 最终ZIP
```

Supported settings:

| Setting | Values | Default |
|---|---|---|
| `target_venue` | venue name or `general` | `general` |
| `review_language` | `auto`, `zh-CN`, `en`, `bilingual` | `auto` |
| `review_depth` | `quick`, `standard`, `deep` | `standard` |
| `latest_literature_check` | `off`, `on` | `on` for standard/deep |
| `reproduction_verification` | `reporting_only`, `inspect_artifacts`, `execute_if_available` | `reporting_only` |
| `theory_audit` | `auto`, `on`, `off` | `auto` |
| `output_formats` | `docx`, `json`, `html`, `markdown`, `csv`, `zip` | single: `docx,json`; batch: `docx,zip` |
| `include_individual_reviews` | `true`, `false` | `false` |

If the user explicitly forbids web research, respect that instruction and mark the latest-work audit `not_assessable` rather than pretending currency was verified.

For confidential or unpublished manuscripts, do not paste manuscript passages into external search. Search using non-sensitive bibliographic information, topic keywords, method names, benchmark names, and claimed contribution terms.

## 2. Establish the review basis

Read the full manuscript before judging it. For PDF/DOCX under `deep`, inspect rendered pages, figures, tables, captions, equations, appendices, and supplements.

Create an internal paper map:

1. research question and claimed contribution;
2. design, data, sampling, comparators, controls, baselines, and analysis;
3. **central conclusion inventory**;
4. **claim-to-experiment map**;
5. **reproducibility inventory**;
6. **latest-work comparison inventory**: what recent methods are cited, which are actually implemented/compared, and whether comparisons are fair;
7. **theory inventory**: theorems, propositions, lemmas, derivations, stability/convergence/optimality/feasibility/complexity claims, assumptions, and proof dependencies;
8. limitations, ethics, conflicts, data provenance, and venue criteria when available.

State access limitations. Never convert extraction failure, inaccessible supplementary files, or unavailable code into an author omission unless that omission is verifiable from the manuscript package.

## 3. Run the four mandatory core audits

For empirical/computational/method/optimization/control/simulation papers, run all applicable audits before final decision synthesis.

### 3.1 Experimental Support Audit

Use [references/experimental-support-reproducibility.md](references/experimental-support-reproducibility.md).

For every central conclusion:

1. identify the exact claim and scope;
2. identify the experiment/analysis intended to support it;
3. test whether that design can actually evaluate the claim;
4. examine comparator fairness, controls, baselines, data splits, leakage, sample/run count, metric suitability, statistical uncertainty, ablation, robustness/sensitivity, and generalization scope as applicable;
5. assign `supported`, `partially_supported`, `unsupported`, or `not_assessable`;
6. create a review issue whenever the support gap materially affects the contribution.

An experiment being present is not enough. Evidence must be relevant, sufficiently broad, statistically/analytically reliable, and matched to the scope of the conclusion.

### 3.2 Reproducibility Audit

Assess whether an independent researcher can recreate the central result-generating workflow without consequential guessing. Check data, preprocessing, split construction, algorithm/model specification, parameters, hyperparameters, random seeds, training/solver procedure, environment, evaluation definitions, baseline settings, code, configs, and artifacts.

Assign `reproduction_readiness` as `ready`, `minor_gaps`, `major_gaps`, `not_assessable`, or `not_applicable`, and record actual `verification_scope`.

**Never claim successful reproduction unless execution actually occurred.** Detailed methods or a repository link indicate reproduction readiness, not successful reproduction.

### 3.3 Latest Relevant Literature Comparison Audit

Use [references/latest-literature-comparison.md](references/latest-literature-comparison.md).

This audit requires current external verification unless the user explicitly disables web research.

Check two separate questions:

1. **Literature currency:** Does the related-work section cover recent representative work that is genuinely close to the manuscript's problem, method, data/benchmark, and claimed contribution?
2. **Experimental comparability:** If the paper claims superiority or state-of-the-art performance, are sufficiently strong recent methods actually compared under reasonably fair conditions?

Do not treat “cited in Related Work” as equivalent to “used as an experimental baseline.” A paper can have an up-to-date bibliography and still have a weak comparison section.

Prioritize:

- recent peer-reviewed primary research and authoritative preprints when appropriate;
- recent methods solving the same or nearest problem under comparable data/test systems and metrics;
- the strongest prior method that the new contribution most directly claims to improve upon;
- seminal older baselines only where they remain necessary anchors.

Do not mechanically demand the newest paper by date. Require the **latest relevant and credible comparators** that materially affect interpretation of novelty or superiority.

Assign `comparison_status` as `adequate`, `partially_adequate`, `inadequate`, or `not_assessable`.

A missing strong recent comparator is normally **major** when it makes the claimed superiority, novelty, or practical advantage uninterpretable. If implementation is genuinely unavailable or incomparable, the minimum sufficient fix may be a bounded claim plus transparent discussion rather than forced reproduction of an inaccessible method.

### 3.4 Theoretical Analysis Audit

Use [references/theoretical-analysis.md](references/theoretical-analysis.md).

First determine whether the paper makes claims that require theoretical support. Examples include:

- stability or closed-loop stability;
- convergence or finite-time convergence;
- optimality or global optimality;
- feasibility, recursive feasibility, or constraint satisfaction;
- robustness guarantees or error bounds;
- identifiability or consistency;
- complexity/scalability claims;
- monotonicity, boundedness, existence/uniqueness;
- equilibrium, steady-state allocation, or control-performance properties;
- market/mechanism properties such as incentive compatibility, efficiency, budget balance, or equilibrium existence.

For each applicable theoretical claim:

1. locate the theorem, proposition, derivation, proof, or analytical argument;
2. list the assumptions needed;
3. verify that the derivation logically proves the exact stated claim rather than a weaker surrogate;
4. check hidden conditions, circular reasoning, missing cases, dimension/sign errors, and unjustified approximations;
5. verify that experimental settings satisfy the assumptions used in the theory;
6. check whether theoretical and empirical conclusions agree.

Assign `theoretical_support_status` as `supported`, `partially_supported`, `unsupported`, `not_required`, or `not_assessable`.

Do **not** demand theorem-level proof for purely empirical claims that do not assert a theoretical guarantee. Conversely, simulation success does not replace proof when the paper explicitly claims guaranteed stability, convergence, optimality, or another formal property.

## 4. Independent review lanes

For `standard` and `deep`, keep findings independent until lead-reviewer verification. Use four lanes when practical:

- **Experimental evidence & methods:** design, baselines, statistics, robustness, leakage, ablation, conclusion support.
- **Latest literature & claims:** recent work, strongest comparators, novelty, interpretation, citation currency, state-of-the-art claims.
- **Theory & mathematical validity:** assumptions, derivations, proofs, stability/convergence/optimality/feasibility/complexity.
- **Reproducibility & adversarial:** data/code/environment completeness, hidden assumptions, engineering settings, failure cases, ethics, auditability.

Adapt to paper type. For power-system, optimization, control, and simulation work, explicitly inspect scenario coverage, constraint feasibility, solver tolerances, computational fairness, dynamic limits, and consistency between theoretical assumptions and simulation/hardware settings.

## 5. Revision and rebuttal re-review

When a manuscript package contains a previous review, author response/rebuttal, revision notes, and a revised manuscript, treat them as one review chain rather than independent papers.

Before generating new comments:

1. build a previous-issue checklist;
2. compare each author response with the actual revised manuscript;
3. classify each prior issue as `resolved`, `partially_resolved`, `unresolved`, or `not_verifiable`;
4. do not repeat fully resolved issues;
5. retain unresolved issues with precise explanation of why the response or revision is insufficient;
6. add genuinely new issues discovered in the revised version;
7. reassess all four core audits because a revision can fix one dimension while introducing contradictions elsewhere.

An author saying “已修改 / addressed” is not evidence of closure. Closure requires manuscript-level verification.

## 6. Verify and adjudicate every issue

Act as lead reviewer after the independent passes:

1. re-open the cited manuscript location for every proposed issue;
2. mark `verified`, `partially_verified`, or `unverified`;
3. exclude unverified issues from the decision basis;
4. re-check every unsupported/partially-supported central claim against the actual figure/table/equation/analysis;
5. re-check every latest-work concern against current primary sources;
6. re-check every theoretical concern against the full derivation and assumptions;
7. re-check reproducibility gaps to ensure missing details are scientifically material rather than merely convenient;
8. merge findings by root cause while preserving distinct consequences;
9. assign severity by impact on central claims, novelty interpretation, theoretical validity, or auditability;
10. apply fatal-flaw gates before balancing strengths.

Follow [references/review-protocol.md](references/review-protocol.md).

## 7. Decision calibration

Before recommendation, apply these gates:

- A central conclusion marked `unsupported` is normally at least **major**.
- If the main contribution is unsupported and repair requires a substantially new study, **reject** is appropriate.
- `major_gaps` in reproducibility are normally **major** when they prevent recreation/audit of central results.
- An `inadequate` latest-work comparison is normally **major** when superiority/novelty depends on comparison with methods that were omitted.
- An `unsupported` theoretical guarantee is **major** or **critical** when the paper's claimed correctness/safety/stability/optimality depends on it.
- A mathematical proof of a surrogate property does not automatically support a broader engineering or empirical conclusion.
- Strong theory does not compensate for missing empirical validation when the contribution includes empirical performance claims; strong experiments do not compensate for missing proof when formal guarantees are explicitly claimed.

The verdict rationale must explicitly answer all applicable core questions: experimental support, reproducibility, latest-work comparison, and theoretical support.

## 8. Canonical structured output

Create `<paper-stem>_review.json` using [references/report-schema.md](references/report-schema.md). Keep keys in English; write reader-facing values in the review language.

For standard/deep scientific reviews, canonical JSON should include:

- `conclusion_support`;
- `reproducibility`;
- `latest_literature_comparison`;
- `theoretical_analysis`.

Single-manuscript default deliverables:

- `<paper-title>审稿意见.docx` for Chinese papers or `<paper-title> Review Comments.docx` only if the user explicitly requests English naming; otherwise follow the user's naming convention;
- canonical JSON for auditability;
- optional HTML/Markdown when requested.

For Word generation, use [references/batch-word-delivery.md](references/batch-word-delivery.md) and `scripts/render_word_report.py` when suitable. A user-provided Word review template takes precedence over default formatting.

## 9. Mandatory batch ZIP workflow

When the user asks to review a ZIP containing multiple papers, this is the default delivery contract unless they explicitly specify otherwise.

Use [references/batch-word-delivery.md](references/batch-word-delivery.md).

### 9.1 Language

- Chinese manuscript -> Chinese review comments.
- English manuscript -> English review comments.
- Determine language from manuscript body, not only file name.

### 9.2 Word style

- Use the user's supplied review-comment DOCX as the style/layout template when present.
- Preserve its page setup, fonts, heading hierarchy, tables, spacing, header/footer, and general visual language as closely as practical.
- Replace template content with paper-specific review content; do not copy substantive review conclusions from the template.
- Every generated DOCX must pass render -> page-image visual QA before delivery.

### 9.3 Required review structure

Unless the template dictates equivalent headings, every review should contain:

1. overall assessment;
2. core conclusion-experiment evidence matrix;
3. reproducibility assessment;
4. latest relevant literature/comparator assessment;
5. theoretical analysis assessment;
6. major review comments;
7. minor comments;
8. final recommendation.

For revision/rebuttal manuscripts, add a prior-comment closure section when useful.

### 9.4 Final ZIP structure and naming

The final ZIP must contain **exactly two first-level folders**:

```text
原文/
审稿意见/
```

Rules:

- `原文/`: one current primary manuscript per paper, renamed to the paper's formal title while preserving its original extension.
- `审稿意见/`: one Word review per paper, named by concatenating the formal title and the suffix `审稿意见`, i.e. `论文正式题目审稿意见.docx` (the `+` in the naming rule means concatenation, not a literal plus sign).
- Supporting files such as author responses, previous review comments, or revision notes are used as review evidence but are **not** treated as separate papers and are not copied as separate deliverables unless the user explicitly asks.
- Do not leave JSON, HTML, QA images, temporary files, manifests, scripts, or nested work directories inside the final ZIP unless explicitly requested.
- Before delivery, verify that the number of primary manuscripts equals the number of Word review files.

Use `scripts/package_batch_reviews.py` when convenient.

## 10. Final quality gate

Before shipping, verify:

- every central conclusion has an experimental support status;
- every material reproducibility gap is concrete;
- the latest-literature audit used current sources when enabled and distinguishes citation coverage from actual experimental comparison;
- every theoretical guarantee is matched to an actual derivation/proof or explicitly marked unsupported/not required;
- theory assumptions are consistent with experiments/simulations where relevant;
- every decisive issue has a manuscript location and observable evidence;
- external literature claims are separately sourced and not confused with manuscript facts;
- severity matches consequence;
- revision actions are minimally sufficient and testable;
- revised manuscripts were checked against author responses rather than merely trusting them;
- every DOCX has passed visual render QA;
- final ZIP has only `原文/` and `审稿意见/` at the first level and follows title-based naming.

For the user's own draft, call the recommendation a pre-submission diagnostic rather than a real journal decision.
