# Variable, Symbol, Parameter, and Unit Audit

Review equations, algorithms, tables, figures, appendices, and nomenclature for implementation-critical definition gaps.

Check:

- first-use definition;
- physical meaning;
- units and per-unit/base quantities;
- scalar/vector/matrix dimensions;
- parameter vs state vs decision variable vs measurement;
- continuous/integer/binary domain;
- sets/indices and index ranges;
- upper/lower bounds;
- deterministic vs random variables;
- actual/forecast/estimated values;
- initial/boundary conditions;
- symbol reuse or collisions;
- constants without source/value;
- parameters used in experiments but not in method description.

Severity depends on reproducibility impact:

- major: prevents unique reconstruction or materially changes results;
- moderate: reconstructable only with nontrivial assumptions;
- minor: local ambiguity not affecting the method.

The formal undefined-symbol table contains at most three genuine missing meaning definitions. Do not fill a quota. Record `missing_definition=true`, exact symbol and location, and the inspected context. Separate missing numeric values/configuration and ambiguous model semantics; they are not automatically undefined symbols. A reviewer example such as lambda is not evidence that lambda is undefined in the current paper. For related power-system checks, read [power-system-review-memory.md](power-system-review-memory.md).

## Report formula provenance

For every displayed formula, record `origin` as `manuscript`, `reviewer_restatement`, `proposed_correction` or `reviewer_model`, the source location, and complete symbol definitions. Use `parameter_configuration_gaps` for missing values/ranges/settings and `model_ambiguities` for non-unique relationships. These do not populate the genuine undefined-meaning table. Follow M03–M04 for terminology and dimensional clarity.
