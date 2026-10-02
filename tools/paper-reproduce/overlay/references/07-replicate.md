# Stage 7: Representative verification (not paper-scale by default)

Smoke passed. By default, do **not** launch the paper's full training schedule. Only switch to strict mode when the user explicitly asks for full-data, paper-scale, or table/figure-level numerical matching.

This stage is one representative verification run planned to finish within the remaining one-hour overall timebox. Do not run 3-seed means, ablation grids, or every table row by default.

## Read the device budget

1. Read `experiment/runtime-budget.json` (see `08-runtime-budget.md`) for machine guidance.
2. Estimate remaining time in the one-hour plan after setup and smoke.
3. If little time remains, run the smallest meaningful experiment and document the reduced scope.

## Plan exactly one run

Write `repro/<slug>/run_plan.md` or `experiment/plan.json` with a **single** row:

| Run name | Goal | Config | Expected duration | Expected metric |
| --- | --- | --- | --- | --- |
| `repro-verify-seed0` | check the method and expected trend | representative config | ≤ remaining plan | directional comparison, not a match claim |

Rules:

- `maxSeeds = 1`
- `maxAblations = 0` unless one extra comparison is essential to the paper's main claim and still fits the remaining one-hour overall plan
- use one representative dataset subset/site/case; clamp epochs/window/horizon as needed
- ESOPT: prefer `case6` / a tiny LP; set `timeout` to `esoptTimeoutSec`
- do not call `/phd-skills:launch` for multi-hour jobs

## Launch

Use the same solver contract as the rest of this page:

- source-load: `forecast/request.json` with clamped `epochs` / `window` / `horizon`
- ESOPT: `esopt/request.json` with a short timeout
- custom `src/` scripts: honor a wall-clock deadline

```python
import time
deadline = time.time() + remaining_sec
for epoch in range(max_epochs):
    if time.time() >= deadline:
        print("stopped at device budget")
        break
    train_one_epoch()
```

Stop at the deadline even if loss is still falling.

## Compare honestly

Do **not** require same-epoch comparison at the paper's epoch 25/50/100. Compare what you actually ran:

- method shape (model family, features, split, loss) vs the paper
- finite metrics on the compressed split
- label `[compressed verify]` plus one of the usual verdicts if a number is still meaningful

`results.md` template:

```markdown
# Reproduction results

**Run type**: method-level verification (planned within one hour overall)
**Device**: <cpu/gpu from runtime-budget.json>
**Paper claim**: <metric> (full-scale; not re-trained here)

## Our run

| Run | Setup | Metric | Wall-clock | Notes |
| --- | --- | --- | --- | --- |
| repro-verify-seed0 | <epochs/rows/case> | <value or failed> | <seconds> | compressed |

## Verdict

**[method-level verify]**. This does not claim a paper-scale match.
If the method ran and metrics are finite: record `[gap, hypothesis: budget truncated training]`.
If the method could not run: `[failed]` with the real error.
```

## Honest stop

After **3** genuine fix-and-rerun attempts, or when the one-hour default timebox is reached, stop. Write the last error or the metric you actually got. Do not keep training to chase the paper's number.

## Success criteria

- one representative verification run was attempted within the default timebox
- unfinished or over-budget runs are labeled `failed` or `truncated`
- `results.md` states the actual scope and whether this was not a full-epoch reproduction
- someone else can rerun the same representative config, not a hidden long-running job
