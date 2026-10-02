# Runtime budget: one-hour method-level reproduction

This page overrides upstream stage 6-7 launch advice. By default, paper reproduction in this product is a **time-bounded method-level verification**, not an attempt to regenerate every reported number.

## Soft overall timebox

Plan the complete reproduction of one paper to finish in roughly **one hour wall clock**, including paper reading, implementation, smoke checks, one representative experiment, and reporting. This is a planning target, not a per-process kill timer.

- Budget file: `experiment/runtime-budget.json` (system-probed at workspace prepare)
- Prefer one representative dataset subset or scenario, one seed, and one main verification run
- Do not default to paper-scale epochs, three-seed averages, ablation grids, every table row, or an exhaustive search for unavailable private data
- If the planned work is unlikely to fit the timebox, reduce scope before launching and record the limitation honestly
- Do not terminate a healthy model response, file write, solver step, or training epoch merely because it is slow or crosses the estimate; intervene only for a real error, clear non-progress for an unusually long period, unsafe resource use, or a user-requested stop

Strict full-data or number-matching reproduction is opt-in. Use it only when the user explicitly asks for strict, complete, or paper-scale reproduction, and explain that it may exceed one hour before launching substantial work.

## Read the probe first

Before writing `experiment/plan.json`, `forecast/request.json`, `esopt/request.json`, or a training script:

1. Read `experiment/runtime-budget.json`.
2. Use its device information and recommendations as starting points, not rigid caps.
3. Write a plan whose default scope is method-level verification within roughly one hour.

If the file is missing, probe once and proceed conservatively. Do not assume access to a large GPU schedule.

```bash
python -c "import json,os,platform,subprocess; gpu=None
try:
  out=subprocess.check_output(['nvidia-smi','--query-gpu=name,memory.total','--format=csv,noheader,nounits'], timeout=4, text=True)
  line=out.strip().splitlines()[0]; name,mem=[p.strip() for p in line.split(',',1)]; gpu={'name':name,'memoryMb':int(mem) if mem.isdigit() else None}
except Exception:
  pass
print(json.dumps({'cpuCount':os.cpu_count(),'platform':platform.platform(),'gpu':gpu}, ensure_ascii=False))"
```

On CPU-only machines, normally choose a small-to-medium representative chronological subset, one seed, and enough epochs or iterations to expose basic convergence or trend behavior. A detected NVIDIA GPU does not by itself justify a full paper-scale run.

## Default scope controls

Use these as soft defaults and adjust when the method needs a slightly different representative setup:

| Lever | Method-level default | Strict mode only |
| --- | --- | --- |
| Seeds | 1 | Multi-seed statistics |
| Epochs / iterations | Enough to confirm execution and a meaningful loss or metric trend | Paper-reported full schedule |
| Data | Small-to-medium representative subset or one scenario | Full corpus and all scenarios |
| Window / horizon | Smallest setting that preserves the method's core temporal logic | Exact paper-wide setting when expensive |
| Ablations | None, or one comparison essential to the paper's claim | Full ablation grid or every table row |
| ESOPT | Small representative case with a reasonable timeout | Large or exhaustive optimization cases |
| Custom training | One smoke run and one main verification run | Long repeated training campaigns |

Do not repeatedly restart a healthy long operation merely to force it under the estimate. If an operation genuinely stalls, diagnose the cause first; preserve useful logs and partial outputs, then fix the root cause or reduce the next run's scope.

## Honest labeling

In `experiment/plan.json` limitations and in the final report, say:

- this run is a **method-level verification** under an approximately one-hour overall timebox
- it checks implementation viability, core logic, representative behavior, trends, and comparison direction rather than exact numerical agreement
- skipped full-scale data, seeds, epochs, scenarios, or table rows are limitations, not reproduced matches
- use **strict reproduction** only when that mode was explicitly requested and actually executed

## Success criteria

- `experiment/runtime-budget.json` was read, or a one-shot device probe was recorded
- the complete default plan is reasonably expected to finish in about one hour
- smoke checking is followed by one representative main verification experiment
- the result assesses core method structure, data flow, losses or constraints, output plausibility, convergence trend, and the direction of improvement against a simple baseline where applicable
- `results.md` or `reproduction-report.md` labels the work as method-level verification and does not claim paper-scale numerical reproduction
