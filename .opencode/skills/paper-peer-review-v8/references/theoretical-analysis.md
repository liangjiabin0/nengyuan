# Theoretical Analysis Audit

Identify claims whose validity depends on derivation or proof:

- stability / asymptotic / finite-time / ISS;
- convergence;
- global/local optimality;
- exact equivalence / reformulation;
- lossless relaxation;
- uniqueness;
- finite termination;
- robustness guarantee;
- controllability/observability;
- complexity bound.

For each important claim record:

- exact claim;
- theorem/equation/proposition location;
- assumptions;
- derivation/proof supplied;
- whether the logic closes;
- whether experiment settings satisfy the assumptions;
- any gap between what is proved and what is claimed.

Simulation cannot prove a theorem-level guarantee. Conversely, a purely empirical claim need not be forced into a theorem.

The Word report shows only the three most important theory items.

## Conditional mathematical checks

Use M07 and M10–M14 in [power-system-review-memory.md](power-system-review-memory.md) only when the corresponding probability, optimization, capacity or market claim exists. Directly check a stated identity before demanding a proof (for example, nonzero-sum normalized weights already sum to one). Distinguish empirical indices from risk-equivalent quantities, feasible solutions from optimality certificates, and reported formulation issues from unverified implementation consequences. Request only properties necessary for the contribution.
