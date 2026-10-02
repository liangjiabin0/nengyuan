# Theoretical Analysis Audit

## Purpose

Determine whether analytical derivations actually establish the theoretical properties claimed by the manuscript, and whether those assumptions match the empirical/simulation setting.

## 1. Applicability

Theory review is mandatory when the paper explicitly or implicitly claims properties such as:

- stability / asymptotic stability / finite-time stability;
- convergence / convergence rate;
- optimality / global optimality / approximation guarantee;
- feasibility / recursive feasibility / constraint satisfaction;
- robustness / error bounds / performance bounds;
- existence / uniqueness / boundedness / monotonicity;
- identifiability / consistency;
- computational complexity or scalability;
- equilibrium or steady-state allocation properties;
- mechanism-design properties such as efficiency, incentive compatibility, budget balance, or equilibrium existence.

For a purely empirical claim with no formal guarantee, mark the dimension `not_required` rather than inventing a theorem requirement.

## 2. Claim-to-proof map

For each theoretical claim, record:

- claim and location;
- theorem/proposition/lemma/equation/derivation intended to support it;
- assumptions;
- proof structure or derivation chain;
- whether the conclusion exactly matches the theorem result;
- whether simulations/experiments operate inside the theorem's assumptions.

## 3. Proof validity checks

Check for:

- missing steps essential to the result;
- circular reasoning;
- hidden or unrealistic assumptions;
- sign/dimension/unit errors;
- invalid linearization or approximation range;
- use of sufficient conditions as if they were necessary;
- proof of a local property presented as global;
- proof of steady-state behavior presented as transient stability;
- feasibility assumed rather than established;
- optimality claimed for a reformulated/relaxed problem but generalized to the original nonconvex problem;
- complexity claims without computational or asymptotic basis;
- empirical curves used as a substitute for a formal guarantee.

## 4. Cross-check theory and experiments

A theory section and an experiment section must not be reviewed independently. Verify:

- parameter ranges satisfy proof assumptions;
- constraints/saturation/limits omitted from theory are not active in experiments when the guarantee relies on their absence;
- discretization, sampling, delays, noise, or solver approximations do not invalidate the claimed guarantee;
- experimental results do not contradict predicted behavior;
- if theory only establishes a narrower property, conclusions are worded at that narrower scope.

## 5. Status

Assign `theoretical_support_status`:

- `supported`
- `partially_supported`
- `unsupported`
- `not_required`
- `not_assessable`

## 6. Decision consequences

- An unsupported theorem or guarantee central to correctness, safety, stability, or optimality is normally **major** and may be **critical**.
- A missing proof for a secondary analytical remark may be moderate/minor if removing or narrowing the statement does not affect the main contribution.
- Strong simulation results do not validate a claimed formal guarantee.
- A mathematically correct proof does not automatically establish practical superiority; empirical claims still require empirical evidence.
