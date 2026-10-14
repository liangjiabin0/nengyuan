---
name: paper-peer-review-v8
original_name: paper-peer-review
description: "Conduct deep evidence-grounded peer review for energy/power-system manuscripts using paper-type-specific principle-level reproduction. Classify papers as data science, optimization planning/operation, or system stability/control; audit experimental support, undefined variables, data/code availability, reproducibility, latest comparators, theory, generalization/engineering validity, revision responses, and human-refined review feedback. Apply reusable human-feedback checks to both first reviews and reassessments. Produce Chinese reviews for Chinese papers and matched English+Chinese reviews for English papers, per-paper latest-literature PDF evidence bundles, and a reproduction-informed editable two-slide PPTX for each reviewed paper in batch ZIP delivery."
metadata:
  version: "8.0"
---

# Evidence-Grounded Reproduction-Oriented Paper Peer Review

Review manuscripts as an independent scientific verifier, not as a prose critic. The central question is not whether the paper looks complete, but whether an independent researcher can understand, reconstruct, stress-test, and reasonably validate the method and whether the resulting evidence actually supports the authors' claims.

## 1. Scientific priority order

Use this priority order unless the paper type clearly requires an adaptation:

1. **Claim support:** do experiments, simulations, cases, and theory actually support the central conclusions?
2. **Method reconstructability:** are variables, parameters, sets, indices, units, algorithms, and workflows sufficiently defined to rebuild the method?
3. **Principle-level independent reproduction:** can the method be reconstructed with public, local, benchmark, or reasonable simulated data so that its logic and qualitative mechanisms can be independently verified?
4. **Data/code availability:** does the paper state whether required data/code/artifacts are publicly obtainable, and are access conditions clear?
5. **Generalization / engineering validity:** do conclusions generalize beyond the exact data, time window, test feeder, operating point, or simulated scenario?
6. **Latest relevant literature and comparator audit:** is the method positioned and, where necessary, experimentally compared against the strongest recent work?
7. **Theoretical support:** do stability, convergence, optimality, equivalence, robustness, complexity, or other theorem-level claims have valid derivations under explicit assumptions?
8. **Review presentation synthesis:** can the reviewed method and reviewer-side principle-reproduction findings be converted into an editable, evidence-backed two-slide PPTX without inventing data?

Writing quality, formatting, visual polish, and presentation appeal are secondary and cannot compensate for unsupported central claims or an unauditable method.

## 2. Classify the paper before reviewing

Every paper must be assigned:

- `primary_category`: one of `data_science`, `optimization_planning_operation`, `system_stability_control`;
- optional `secondary_category`: one of the other categories when materially relevant.

Classify by the **main scientific contribution**, not by keywords alone. Follow [references/paper-classification.md](references/paper-classification.md).

The primary category determines the main reproduction workflow. Apply secondary-category checks only when they materially affect the paper's claims.

### Reusable knowledge in every review

Read the common checks M01–M04 in [references/power-system-review-memory.md](references/power-system-review-memory.md) in every review, then select the remaining rules by the manuscript's actual methods and claims. These checks apply to first reviews as well as human-feedback reassessments.

| Trigger in the current manuscript or materials | Rules to apply |
|---|---|
| Probability forecasts, correlated scenarios, chance constraints, risk metrics | M05–M08 |
| Piecewise responses, discrete logic, heuristic/solver status, reduced reproduction | M09–M11 |
| Reliable capacity, reserve markets, settlement or cost allocation | M12–M14 |
| Engineering applicability, generalization, superiority or attribution | M15–M16 |

Record the applied rules, triggers, manuscript evidence, verification scope and outcomes in `knowledge_application`. An applicable check may find no issue. Separate a verified issue, conditional risk, unavailable evidence and an inapplicable rule; do not convert a memory entry into a preset criticism. Follow [references/review-protocol.md](references/review-protocol.md) before retaining decisive issues.

## 3. Build the paper map

Read the full manuscript before judging it. For PDF/DOCX, inspect figures, tables, equations, appendices, algorithms, supplementary material, data/code statements, and revision-response material when present.

Build an internal map containing:

1. research question and claimed contributions;
2. central conclusions required for the paper to succeed;
3. data, test systems, scenarios, operating points, and engineering context;
4. all key mathematical models, algorithms, controllers, and evaluation metrics;
5. comparator methods and literature positioning;
6. key assumptions and theoretical claims;
7. data/code/artifact availability statements;
8. all parameters/variables whose omission could block implementation;
9. revision history and previous-review closure status when applicable.

Never infer that an item is absent merely because extraction failed. Re-open the relevant page or artifact before issuing an absence-based criticism. Preserve the current manuscript version and distinguish human review feedback, previous reviewer findings and author revision evidence. Recheck carried-over findings against the current source.

## 4. Mandatory common audits

### 4.1 Central claim-to-evidence audit

For every central claim, map:

`Claim -> Evidence -> Method -> Assumption -> Result -> Conclusion`

Assign one status:

- `supported`
- `partially_supported`
- `unsupported`
- `not_assessable`

Judge whether the **design can test the claim**, not merely whether an experiment exists. Check comparator fairness, data leakage, train/test independence, repeated runs, uncertainty, ablations, robustness, sensitivity, scenario coverage, statistical significance when relevant, and scope of generalization.

If narrowing the conclusion is scientifically sufficient, allow claim narrowing instead of mechanically demanding additional experiments. Locate decisive judgments in specific equations, tables, figures or sections; give metric differences when interpreting numerical advantages. Preserve existing validation, distinguish trade-offs from overall superiority, and compare small gains with solver gaps, model approximation and sampling variation. Apply M15–M16 when engineering scope or superiority is claimed.

Use [references/experimental-support-reproducibility.md](references/experimental-support-reproducibility.md).

### 4.2 Variable, symbol, parameter, and unit audit

Check every important equation, table, algorithm, figure, and appendix for implementation-critical undefined or inconsistent quantities. Examine:

- physical meaning;
- unit;
- parameter vs. decision variable vs. state vs. measurement;
- continuous/integer/binary domain;
- dimensions of vectors/matrices;
- index/set definitions;
- upper/lower bounds;
- random vs. deterministic quantities;
- predicted/estimated/measured/actual values;
- reused symbols with different meanings;
- undocumented constants;
- parameters used in code/experiments but not defined in the paper.

The formal **Key Undefined Variables/Symbols** table contains at most three genuine missing meaning definitions; zero to two is valid. Keep already-defined symbols with missing values/configuration in the parameter/reproduction audit. Explain every symbol in each displayed report formula, and identify manuscript vs reviewer-added formulas. Lesser issues may appear in Minor Comments.

Follow [references/variable-symbol-audit.md](references/variable-symbol-audit.md) and M03. In the report, identify each displayed formula as manuscript, reviewer restatement, proposed correction or reviewer model, and explain all its symbols, units and relevant assumptions. Record missing values/configuration separately from genuinely undefined meanings.

### 4.3 Data and code availability audit

Explicitly check whether the manuscript states:

- whether the data are public;
- source URL/DOI/repository;
- data version/time period/region/site;
- license/access restrictions;
- preprocessing and split construction;
- whether source code/model/configuration is available;
- whether supplementary artifacts are provided.

Look for `Data Availability`, `Code Availability`, `Open Data`, `Supplementary Material`, GitHub, repository, DOI, or equivalent statements.

If proprietary/confidential engineering data cannot be released, do **not** mechanically demand raw data. Require enough anonymous statistics, schema, ranges, representative samples, acquisition process, or substitute benchmark data to permit independent method validation.

Follow [references/data-availability-reproduction.md](references/data-availability-reproduction.md).

### 4.4 Principle-level independent reproduction

Distinguish:

- **result replication**: attempting to reproduce the authors' numerical results with the same data/code;
- **principle-level independent reproduction**: reconstructing the method with public/local/benchmark/reasonably simulated data to test whether the method, mechanisms, trends, and constraints behave as claimed.

Unless complete author artifacts are available and actually executed, do not claim exact reproduction.

Principle-level reproduction does **not** require identical numerical values. It should determine whether:

- the method can actually be implemented from the paper;
- the equations/algorithm form a closed executable workflow;
- constraints and control logic behave as intended;
- the qualitative direction of results is scientifically consistent;
- sensitivity trends claimed by the paper can be reproduced;
- missing details force consequential reviewer assumptions.

Always record:

- substitute/local/simulated data used;
- assumptions introduced by the reviewer;
- successfully reconstructed components;
- ambiguous/missing implementation details;
- whether those gaps threaten the central conclusion.

The formal **Reproduction Barriers** table must list only the **three most important** barriers, ranked by impact. Full detail may be preserved in narrative/JSON. Apply M11: inspect reviewer-side indexing, units, discretization, frozen boundaries and metric definitions before attributing a failed test to the manuscript. Record retained/omitted components; a test that removes the original objective or key physics is a local mechanism test, not structurally equivalent reproduction. Distinguish reporting-only analysis, inspected artifacts, partial execution and end-to-end execution.

### 4.5 Latest Relevant Literature and Comparator Audit

For `standard` and `deep` review, external research is normally **on** for this audit unless explicitly prohibited.

Search current literature with emphasis on:

1. directly relevant work from the last year;
2. highly relevant work from the last three years;
3. older foundational work only when necessary.

Prioritize same-task, same-data, same-benchmark, same-mathematical-model, same-control-objective, same-metric, or same-algorithm-family comparators.

Distinguish:

- `cited_in_manuscript`
- `experimentally_compared`

A citation is **not** an experimental comparator.

The formal **Latest Relevant Literature and Comparator Audit** table must contain only the **three most important** works, ranked by relevance/decision impact rather than date alone. Include venue (journal/conference/preprint), year/version, relevance, citation status and experimental-comparison status. If the user requests 3–5 papers/download links, provide a separate expanded list while retaining the formal top-three audit. A direct PDF link must be verified; otherwise give the lawful landing page and the access status.

When judging an omission, distinguish papers publicly available **before manuscript submission** from papers released only afterward. Post-submission papers may inform current context but should not be used unfairly as an omission penalty.

Apply M16 for submission-date fairness; use `available_before_submission=null` when dates cannot be verified, never inferred from filenames. For batch delivery, every work shown in the audit or explicitly requested expanded download list must enter the literature-PDF acquisition workflow described in [references/literature-fulltext-acquisition.md](references/literature-fulltext-acquisition.md).

Follow [references/latest-literature-comparison.md](references/latest-literature-comparison.md).

### 4.6 Theoretical Analysis Audit

Identify theorem-level or derivation-dependent claims, including:

- convergence;
- global/local optimality;
- stability / asymptotic stability / finite-time stability;
- robustness / ISS;
- equivalence or exact reformulation;
- lossless relaxation;
- uniqueness;
- controllability/observability;
- finite termination;
- complexity claims;
- guarantees of feasibility/safety.

Check assumptions, derivation completeness, proof logic, theorem scope, and consistency between theoretical assumptions and the experimental/simulation setting.

Simulation cannot substitute for a theoretical guarantee. Conversely, do not force formal theorems onto purely empirical claims that do not require them.

The formal **Theoretical Basis and Derivation Audit** table must contain only the **three most important** theoretical issues/results, ranked by importance to the core contribution.

Follow [references/theoretical-analysis.md](references/theoretical-analysis.md).

## 5. Category-specific reproduction and review

### 5.1 Data science papers

Follow [references/data-science-review.md](references/data-science-review.md).

Use public/local/benchmark/reasonably simulated data that satisfy the paper's data assumptions. Reconstruct preprocessing, features, target definition, model, training, validation/test split, loss, optimizer, evaluation, and model-selection logic.

The review must emphasize **difficulties encountered during reproduction** and missing information that forced assumptions. Apply M05–M08 when probability prediction or scenario generation is involved; existing distributional losses do not replace calibration evidence, and future observations must not be treated as available forecasts.

Mandatory additional audits:

- **time generalization**: years, seasons, months, rolling windows, chronological shift, concept drift, extreme periods;
- **data-domain generalization**: datasets, regions, sites, devices, users, system scales, noise, missingness, imbalance, renewable penetration, or comparable domain shifts;
- **parameter sensitivity**: if performance is materially sensitive to hyperparameters or thresholds, require the authors to explain the parameter-selection rule, search range, validation protocol, and scientific basis.

Do not accept random train/test splitting of the same time span as sufficient evidence for temporal generalization when temporal transfer is claimed.

### 5.2 Optimization planning and operation papers

Follow [references/optimization-esopt-review.md](references/optimization-esopt-review.md).

Prefer code-level principle reproduction using ESOPT from:

`https://github.com/yuntaoju2022/smart-energy-system`

ESOPT is a C++ modeling/solver platform with unified interfaces to multiple solvers. Choose a compatible solver for the problem class. If license/model-size limitations prevent full reproduction, construct a **smaller structurally equivalent test case** that preserves the paper's objective, variable types, key constraints, uncertainty structure, and algorithmic mechanism.

Rebuild, as applicable:

- sets/indices;
- parameters;
- decision variables/domains/bounds;
- objective;
- equality/inequality constraints;
- temporal coupling;
- network/device constraints;
- integer logic;
- uncertainty sets/scenarios;
- master/subproblems;
- decomposition/cut generation;
- stopping rules.

Do not require the reproduced objective value to equal the manuscript value. Determine whether the optimization can be solved and whether the resulting dispatch/planning logic and parameter trends are scientifically consistent.

Apply M09–M11 to relevant piecewise rules, logical constraints, solver statuses and reproduction scope; apply M05–M08 to stochastic optimization and M12–M14 to capacity/market/allocation methods when present. Do not equate a timeout with infeasibility, an incumbent with certified global optimality, or procurement objective with settlement payments.

**Actual engineering case audit is mandatory.** Apply M15 and classify the validation case as:

- real engineering case;
- real data + benchmark test system;
- modified IEEE/standard test system;
- pure benchmark;
- purely synthetic case.

If the paper claims engineering applicability, industrial value, or real-system readiness but uses only a benchmark/synthetic case, treat this as an evidence-scope problem. A Skill-side simulated reproduction does not replace the authors' obligation to demonstrate engineering relevance.

### 5.3 System stability analysis and control papers

Follow [references/stability-modelica-review.md](references/stability-modelica-review.md).

Prefer principle-level dynamic reconstruction using **Modelica/OpenModelica modeling logic**, even when the paper originally used MATLAB/Simulink, PSCAD, RTDS, or hardware.

Reconstruct the minimum dynamic model needed to test the claimed mechanism using:

- differential/algebraic equations;
- states/inputs/outputs;
- controller states and gains;
- device/network parameters;
- initial conditions;
- filters, saturation, limiters, delays, and sampling when material;
- disturbance events;
- solver/time-step configuration.

Validate the claimed mechanism, such as damping improvement, eigenvalue movement, frequency nadir/recovery, voltage deviation reduction, synchronization, power-sharing behavior, or disturbance recovery.

Do not require point-by-point waveform equality. Report whether the method behaves in accordance with the paper's dynamic logic and identify any missing equations/parameters that prevent an independent model from being built.

Mandatory consistency checks include theory-vs-time-domain behavior, linearization operating point, saturation vs. theoretical assumptions, delay/discretization effects, reduced-model validity, and average-model vs. switching-model scope when applicable. Apply M11 to dynamic reconstruction and M15–M16 to applicability/robustness claims. Apply probability or market rules only when those methods actually occur in this paper.

## 6. Revision/rebuttal mode

If the materials include `Revision`, `Author Response`, `Response to Reviewers`, `Marked Manuscript`, previous comments, or 修改说明, switch to re-review mode.

For every previous substantive comment, build:

`Previous Comment -> Author Response -> Manuscript Change -> Reviewer Verification`

Assign:

- `resolved`
- `partially_resolved`
- `unresolved`
- `not_verifiable`

Do not mechanically repeat issues that are genuinely resolved. If the response is only explanatory, conflicts with the revised data, lacks actual manuscript changes, or creates a new inconsistency, keep it open with specific evidence.

### Human-feedback-guided reassessment

When the user supplies human strengthened review opinions, use M01–M04 and extract comments, tracked insertions/deletions and accepted text with `scripts/extract_review_feedback.py`; feedback may exist only in body revisions or prose. Merge fragmented edits by context and classify the intent as terminology/style, factual correction, scientific verification or deliverable requirement. Build `Human Feedback -> Context/Intent -> Manuscript Evidence -> Verification -> Review Change` and store it in `human_feedback`.

Treat feedback as a verification request, not as automatically correct scientific evidence or an author response. Recheck old criticisms and reviewer reproduction code before retaining them. Distinguish printed-model errors from unverified implementation consequences. A completed feedback action does not mean the underlying author-side issue is resolved; do not claim manuscript revision unless the manuscript actually changed.

For reassessment explicitly requesting reports and skill memories, regenerate those requested artifacts. Preserve the existing PPT integration for full review or requested slides; avoid copying old slide data or expanding a report-only reassessment. When skill updates are explicitly requested, merge verified reusable lessons into the existing memory rules, add trigger/verification/completion criteria, and wire new rules into the relevant review route and quality gate. Avoid duplicate rules and do not promote unverified manuscript allegations to memory. Store only reusable conditional checks, not private manuscript material, author identities or fixed case conclusions. Record review-specific feedback closure in the report; scientific issues remain open until author evidence resolves them. A skill-only update does not start another manuscript review.

## 7. Convert reproduction observations into review comments

Do not write a detached reproduction diary. Every important reproduction finding should become a peer-review issue with:

- `Evidence`
- `Problem`
- `Consequence`
- `Reproduction Observation`
- `Required Action`
- `Acceptance Criteria`

Avoid vague advice such as “add more experiments.” State the exact missing evidence or implementation detail and what would close the issue. Use professional terms grounded in the manuscript and explain the affected physical/economic relationship. Separate manuscript fact, reviewer inference and executed reviewer observation; a conditional implementation risk must retain its uncertainty.

## 8. Severity and decision

Use:

- `critical`: central result cannot be audited; fatal data leakage; central contradiction; fundamental theoretical error; core method cannot be reconstructed;
- `major`: central claim insufficiently supported; important undefined/missing implementation details; decisive comparator omitted; required theoretical proof absent; generalization exceeds evidence; engineering-application claim lacks engineering validation; stability claim rests only on narrow simulation evidence;
- `moderate`: important but does not overturn the central contribution;
- `minor`: wording, symbol consistency, non-central parameter/reporting issues.

Final decisions:

- `accept`
- `minor_revision`
- `major_revision`
- `reject`
- `unable_to_assess`

The verdict must follow verified issues, not reviewer strictness or stylistic preference.

## 9. Language rules

Detect manuscript language.

### Chinese manuscript

Generate **Chinese review comments only**.

### English manuscript

Generate **two matched versions**:

1. formal English reviewer comments;
2. Chinese reviewer comments.

The two versions must have identical issue numbering, severity, scientific conclusions, evidence, and required actions. The English version should read like native professional peer review, not literal translation.

## 10. Formal report structure

Use a professional review structure, adapted to category:

1. Review Metadata
2. Paper Classification (`Primary Category`, optional `Secondary Category`)
3. Overall Assessment
4. Central Claim–Evidence Matrix
5. Key Undefined Variables/Symbols — **top 3 only**
6. Data and Code Availability Audit
7. Principle-Level Independent Reproduction
8. Category-specific audit:
   - Data science: reproduction, time generalization, data generalization, parameter sensitivity
   - Optimization: ESOPT reproduction, engineering-case authenticity, model/solver consistency
   - Stability/control: Modelica reproduction, control/stability validation, theory–time-domain consistency
9. Latest Relevant Literature and Comparator Audit — **top 3 only**
10. Theoretical Basis and Derivation Audit — **top 3 only**
11. Two-Slide PPT generation plan and reproduction-data chart sources
12. Major Comments
13. Minor Comments
14. Final Recommendation
15. Limitations of Review

The central claim-evidence matrix is not mechanically limited to three rows, but include only claims necessary to the paper's contribution.

## 11. Canonical structured output

Create a canonical JSON record using [references/report-schema.md](references/report-schema.md) before rendering reports. Keep machine keys in English. New records use `metadata.review_protocol_version="8.0"`, retain `knowledge_application`, and preserve a feedback trace when human review materials are provided. Run `scripts/validate_review.py <record.json>` before rendering; structural validation does not substitute for scientific verification.

The JSON must preserve full evidence, even when the formal Word tables show only top-three summaries. For matched Markdown/Word, represent all prose, tables and formula sources in `report_blocks` and prefer `scripts/render_paired_review.py <record.json> --output-dir <folder>`. It emits native Word equations plus a structural parity record; render every page before delivery. The equation parser supports a limited LaTeX subset (fractions, scripts, sums and listed Greek commands); inspect mathematical semantics and use a reliable converter for other constructs.

## 12. Batch ZIP review workflow and Word delivery

Follow [references/batch-word-delivery.md](references/batch-word-delivery.md).

When Markdown and Word are requested together, generate both from one canonical record, verify substantive parity and render every Word page. Mathematical objects must preserve the Markdown formula source. Use the user's review DOCX as the style/template when provided. Preserve its professional visual hierarchy while adding the required new sections/tables.

Final ZIP must contain **exactly two first-level folders**:

```text
原文/
审稿意见/
```

### Chinese paper

```text
原文/<论文正式题目>.<original extension>
审稿意见/<论文正式题目>审稿意见/
  <论文正式题目>审稿意见.docx
  Latest Relevant Literature/
    01_<latest-work>.pdf
    02_<latest-work>.pdf
    ...
    无法下载文献清单.csv   # only when needed
  Two-Slide PPT/
    <论文正式题目>_Two-Slide_Review.pptx
```

### English paper

```text
原文/<Formal Paper Title>.<original extension>
审稿意见/<Formal Paper Title>审稿意见/
  <Formal Paper Title>_Review_English.docx
  <Formal Paper Title>审稿意见_中文.docx
  Latest Relevant Literature/
    01_<latest-work>.pdf
    02_<latest-work>.pdf
    ...
    无法下载文献清单.csv   # only when needed
  Two-Slide PPT/
    <Formal Paper Title>_Two-Slide_Review.pptx
```

Revision responses, marked manuscripts, and old comments are evidence inputs, not separate primary papers, unless explicitly requested.

## 13. Latest-literature PDF acquisition

Every work shown in the formal Latest Relevant Literature and Comparator Audit must have exactly one delivery outcome:

- a verified lawful PDF in `Latest Relevant Literature/`; or
- one row in `无法下载文献清单.csv`.

Download only legitimate public full text: publisher OA, official proceedings, arXiv/preprint, institutional repository, or matching accepted manuscript. Never bypass paywalls, logins, CAPTCHAs, access controls, or use unauthorized mirrors.

Use [references/literature-fulltext-acquisition.md](references/literature-fulltext-acquisition.md).

## 14. Two-slide PPT deliverable

For full batch review, retain the two-slide default. Human-feedback report-only reassessment follows the requested artifact scope above; record `presentation.ppt_required=false` with a scope reason when slides are outside that request.

For every review where PPT is required, generate a reproduction-informed two-slide editable PPTX using the bundled two-slide codegen workflow in `integrations/two-slide-paper-ppt-codegen/`. Follow [references/two-slide-review-ppt.md](references/two-slide-review-ppt.md).

The PPTX is an additional required artifact after the review, not a replacement for the Word review. It must contain:

- Slide 1: method/principle/computation/control/optimization flow, grounded in the manuscript and category-specific review map.
- Slide 2: results and experiment analysis built from reviewer-side principle-level reproduction outputs whenever such data were generated.

Do not fabricate result data for the PPT. If the reproduction workflow did not produce reliable numerical data because the manuscript lacked required information, Slide 2 should present a compact reproduction-barrier table/metrics module rather than invented charts. If paper-reported values are shown for context, identify them as paper-reported in the evidence ledger and speaker notes, not as independent reproduction.

Map categories as follows:

- `data_science`: data pipeline/model flow and reproduction-data charts for time/data generalization or parameter sensitivity.
- `optimization_planning_operation`: planning/operation model, ESOPT or reduced-case solver flow, and charts from ESOPT/principle-reproduction outputs.
- `system_stability_control`: dynamic model/control loop, Modelica/OpenModelica principle reconstruction, and charts from time-domain/eigenvalue/stability reproduction outputs.

In batch delivery, place the PPTX in each paper review folder under `Two-Slide PPT/`.

## 15. Final quality gate

Before delivery verify all of the following:

- paper classification is correct;
- central conclusions have explicit evidence status;
- genuine undefined meanings are separated from missing parameter values, and every displayed formula symbol is explained;
- common M01–M04 and triggered domain rules were applied in first reviews as well as reassessments, with traceable `knowledge_application` outcomes;
- human feedback was extracted from comments, revisions and prose, interpreted in context, and traced separately from author-response closure;
- old absence claims, reproduction discretization and metric/payment definitions were verified using applicable memory checks;
- anonymous engineering identity alone was not penalized, terminology matches the physical/economic quantities, and numerical judgments cite concrete manuscript evidence;
- reviewer assumptions, omitted model components and conditional risks were separated from verified author-side errors;
- data/code availability was checked;
- principle-level reproduction appropriate to the category was actually attempted when tools and time permit;
- the review does not falsely claim exact reproduction;
- reproduction assumptions/substitute data are disclosed;
- data-science papers include time/data generalization and parameter sensitivity where relevant;
- optimization papers use ESOPT-style model reconstruction and assess actual engineering-case provenance;
- stability/control papers use Modelica/OpenModelica-style dynamic reconstruction and check theory-time-domain consistency;
- latest literature uses current external sources and top-three formal entries are ranked by importance;
- theoretical top-three entries address the claims that matter most;
- every formal latest-literature item has a PDF or unavailable-table row;
- every paper requiring PPT contains a `Two-Slide PPT/` folder with a verified two-slide editable PPTX; report-only reassessment records the excluded scope;
- slide 2 result charts use reviewer-side reproduction data, or a responsible reproduction-barrier table when no numerical reproduction data can be produced;
- English manuscripts have matched English and Chinese review documents;
- every major issue has concrete evidence and acceptance criteria;
- the verdict follows verified severity;
- the final ZIP has only `原文/` and `审稿意见/` at the first level.

Do not manufacture issues merely to appear strict. Do not weaken verified scientific problems merely to appear friendly.
