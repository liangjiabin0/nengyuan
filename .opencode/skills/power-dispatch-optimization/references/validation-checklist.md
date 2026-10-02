# Validation Checklist

## RunSpec
- [ ] Schema valid
- [ ] case_id exists
- [ ] hierarchy is compatible with case/composite definition
- [ ] time scales are ordered and resolvable
- [ ] P/Q capability matches backend
- [ ] PCC mapping exists for hierarchical task
- [ ] objective weights are explicit
- [ ] required profiles are resolvable

## Model
- [ ] units/baseMVA consistent
- [ ] active/reactive power sign conventions documented
- [ ] storage SOC continuity enforced for intertemporal model
- [ ] generator/DER limits included
- [ ] voltage and branch limits included when network constrained
- [ ] approximations are declared

## Solver
- [ ] solver available
- [ ] termination condition acceptable
- [ ] no unhandled infeasibility
- [ ] objective components recorded

## Post-solution
- [ ] AC PF converged when required
- [ ] voltage limits satisfied
- [ ] line/transformer loading satisfied
- [ ] P/Q device limits satisfied
- [ ] SOC within bounds
- [ ] PCC balance/tracking checked

## Reporting
- [ ] no LLM-fabricated numeric result
- [ ] warnings preserved
- [ ] RunSpec and model/backend version archived
