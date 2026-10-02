# Evidence-Grounded Review Protocol

Use this protocol for every review lane and lead-reviewer adjudication.

## Core object of review

Evaluate `claim -> evidence/theory/comparator -> inference -> consequence`. A useful finding identifies a material weakness in that chain. General preferences, stylistic reactions, and requests for extra work without a claim-level consequence are not major issues.

## Four mandatory scientific gates

For empirical, computational, method, optimization, control, engineering, benchmark, and simulation papers, inspect these before presentation-level issues.

### Gate 1: Experimental support

The experiment must be capable of testing the exact claim, and the evidence must be sufficient in relevance, fairness, quantity, uncertainty, and scope.

- `unsupported` central claims are normally at least major.
- `partially_supported` claims require additional evidence, narrowed claims, or both.
- Component-level causal attribution normally requires ablation or another controlled comparison.
- Robustness/generalization claims require evidence across the claimed perturbations, populations, datasets, scenarios, or operating conditions.

### Gate 2: Reproducibility and auditability

Assess whether an independent researcher can recreate the central result-generating workflow without consequential guesswork.

- Never say results were reproduced unless execution actually occurred.
- Missing material data-processing, split, hyperparameter, solver/training, metric, or evaluation details can be major.
- Missing convenience scripts are not major when all material details are otherwise specified.

### Gate 3: Latest relevant literature and comparators

Verify current literature externally when enabled.

- Distinguish up-to-date citations from actual experimental comparisons.
- A state-of-the-art/superiority claim needs strong, recent, genuinely relevant comparators unless incompatibility is transparently justified.
- The newest paper by date is not automatically the right comparator; relevance and credibility matter.
- An omitted recent strong comparator is major when it makes novelty or superiority uninterpretable.

### Gate 4: Theoretical support

For formal claims, match every claimed property to its proof/derivation and assumptions.

- Simulation success is not a proof of stability, convergence, feasibility, optimality, or robustness guarantees.
- A proof of a local/relaxed/steady-state property must not be generalized to a global/original/transient property without justification.
- Do not demand theorem-level proof for claims that are genuinely empirical and make no formal guarantee.

## Finding anatomy

For every issue, provide:

1. **Claim:** one testable statement about the weakness.
2. **Location:** page, section, paragraph, figure, table, equation, appendix, or quoted phrase.
3. **Evidence:** a short quotation or concrete observation. For an absence, name the expected element and scope checked.
4. **Problem:** why the evidence indicates a defect or uncertainty.
5. **Consequence:** the result, interpretation, validity dimension, novelty claim, theoretical guarantee, or decision affected.
6. **Root cause:** the underlying methodological/reporting/theoretical/comparison cause when identifiable.
7. **Required action:** the minimum sufficient change, not an unlimited wish list.
8. **Acceptance criteria:** an observable condition under which the issue is addressed.
9. **Confidence:** `high`, `medium`, or `low`.
10. **Verification:** `verified`, `partially_verified`, or `unverified` after lead review.

## Separate epistemic status

- **Manuscript fact:** directly visible in the paper package.
- **Reviewer inference:** reasoned interpretation from manuscript facts.
- **External verification:** confirmed against current outside primary/authoritative sources.

When current literature research is off, never assert state-of-the-art status, current novelty, or missing latest work as verified fact. Mark the dimension not assessable.

## Severity rubric

- **Critical:** invalidates or makes unauditable a central claim; central theoretical guarantee is invalid; serious leakage/integrity/ethics/safety risk; or repair requires a fundamentally new study.
- **Major:** materially threatens a central conclusion, theoretical guarantee, reproducibility, novelty/superiority interpretation, or claimed contribution, but could plausibly be repaired.
- **Moderate:** affects a secondary claim, bounded analysis, literature positioning, reproducibility detail, or interpretive precision without overturning the main contribution.
- **Minor:** wording, presentation, local clarity, or non-decisive reporting.

## Fatal-flaw gates

Check before recommendation:

- the central outcome cannot be traced to described data or analysis;
- the design cannot test the main comparative/causal claim;
- leakage undermines evaluation;
- a missing decisive comparator makes the main superiority claim uninterpretable;
- recent directly relevant work materially contradicts the novelty framing and is not addressed;
- a central stability/convergence/optimality/feasibility/safety guarantee is unsupported or mathematically invalid;
- sample/exclusion/missingness/multiplicity handling makes the main estimate unreliable;
- primary evidence is inaccessible or internally inconsistent enough to prevent audit;
- material result-generating steps are missing enough that central results cannot be reconstructed.

A triggered gate does not automatically mean reject. Explain whether it is repairable within revision.

## Decision calibration

- `accept`: no verified critical or major issue; only optional/minor changes.
- `minor_revision`: no unresolved issue materially threatens a central claim or guarantee; changes are bounded.
- `major_revision`: a material threat to a central claim, comparator adequacy, theory, or reproducibility is plausibly repairable.
- `reject`: the central contribution is invalid, unsupported, theoretically unsound, comparison basis fundamentally inadequate, ethically unacceptable, or not realistically repairable without a substantially new study.
- `unable_to_assess`: access, extraction, current-literature, domain, or evidence limits prevent a responsible recommendation.

## Synthesis rules

- Deduplicate by root cause.
- Retain separate consequences when one cause affects multiple claims.
- Preserve evidence-grounded minority concerns.
- Keep external-literature facts distinct from manuscript facts.
- Put unverified hypotheses in limitations/follow-up checks, not established defects.
- Prioritize revisions by decision impact and dependency order.

## Lead-reviewer self-check

Before retaining a finding, ask:

1. Can another reader locate the manuscript evidence?
2. Is this more than a preference?
3. Is the consequence explicit and proportionate?
4. Would the requested action resolve the problem?
5. Could the authors meet the acceptance criterion without guessing?
6. Does confidence reflect extraction/domain/current-literature limits?
7. For experimental claims, did I inspect the actual experiment rather than the author's interpretation?
8. For latest-work claims, did I verify recent primary sources and relevance?
9. For theoretical claims, did I trace the complete derivation and assumptions?
10. For reproducibility gaps, is the missing detail scientifically material rather than merely convenient?

If any answer is no, revise, downgrade, or remove the finding.
