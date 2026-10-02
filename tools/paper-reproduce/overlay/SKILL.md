---
name: paper-reproduce
description: Time-bounded, method-level paper reproduction from a local paper/data workspace through logic checks, smoke runs, and one representative experiment. Handles missing code, hyperparameters, and data with honest substitutions. Use when the user asks to reproduce, implement, replicate, or re-run a paper from scratch.
---

# Reproduce: paper reproduction from scratch

Reproducing an ML paper here means establishing that the method is understood, executable, numerically coherent, and directionally consistent with the paper. The default deliverable is a one-hour method-level reproduction, not a paper-scale benchmark campaign.

**Default timebox:** keep the complete reproduction within **one hour wall clock** on the current machine, including setup, implementation, smoke tests, and one representative experiment. This is a soft planning limit: finish the current safe operation if it is already running, then summarize. Do not launch paper-scale schedules by default.

**Strict mode is opt-in:** only search for all original data, reproduce every table/figure, run paper-scale epochs, or continue beyond one hour when the user explicitly asks for strict/full numerical reproduction. Otherwise, use a representative subset and reason about the expected differences.

Each stage has a separate reference file under `references/` so this overview stays scannable.

## When to run

The user just said any of:

- "reproduce / implement / replicate / re-run paper X"
- pasted an arxiv URL with reproduction intent ("can you redo this", "let's try this approach")
- pointed at an OpenReview / proceedings link with the same intent
- said "the paper has no code, can we build it"

## Workflow

| Stage | What | Reference |
| ----- | ---- | --------- |
| 1 | Paper acquisition (local extract; no extra PDF crawl) | [references/01-paper-fetch.md](references/01-paper-fetch.md) |
| 2 | Existing code discovery + inventory | [references/02-code-clone.md](references/02-code-clone.md) |
| 3 | Gap analysis (extract every missing hyperparam from the prose) | [references/03-gap-analysis.md](references/03-gap-analysis.md) |
| 4 | Implementation (fill gaps; config must honor the device budget) | [references/04-implement.md](references/04-implement.md) |
| 5 | Dataset acquisition or a documented subset/substitute | [references/05-dataset.md](references/05-dataset.md) |
| 6 | Smoke runs (forward → 1 step → few iters, all cheap) | [references/06-smoke.md](references/06-smoke.md) |
| 7 | One representative verification run and logical comparison | [references/07-replicate.md](references/07-replicate.md) |

Always also read [references/08-runtime-budget.md](references/08-runtime-budget.md) before writing an experiment plan.

Walk them in order. Each stage has its own success criteria; do not advance to the next until the current one passes.

## Timebox and scope (default)

Before any `python` / bash training or solver request:

1. Read `experiment/runtime-budget.json` if present. It is a performance hint, not permission to launch a long job.
2. If it is missing, probe CPU/GPU/memory once as in `08-runtime-budget.md`.
3. Choose a representative configuration that fits the one-hour overall timebox; normally use one seed and a small or moderate chronological subset.
4. Keep **one** verification seed. Do not schedule 3-seed means or ablation grids.
5. If the planned run threatens the overall timebox, shrink data/epochs or stop after the current safe checkpoint and report the limitation.

The default target is not exact agreement with the paper's metric. Compare model family, features, split, objective, finite outputs, loss trend, baseline direction, and calibration or ranking behavior. Exact table/figure matching belongs to strict mode.

This page is a verification workbench, not a training cluster.

## When `task` is available (智能对话)

You are the **parent** agent. Do not walk stages 1–7 inside this session.

1. Write `repro/<slug>/PLAN.md` and `repro/<slug>/progress.json` (`version: 1`, `stages: [{ id, title, status, artifacts }]`).
2. **One experiment = one child agent.** Stage 7 is a single compressed verification node, not one node per table row.
3. For each pending node, call `task` with `subagent_type=general` and a child prompt that: reads the progress file and `experiment/runtime-budget.json`, does **only that node**, writes artifacts, sets `status` to `done` or `failed`, then outputs a concise public Chinese summary (files written, numbers/errors). Do not treat an empty `<task_result>` as success — retry once with a shorter prompt that says “write files first, then summarize”.
4. After a child exits, read `progress.json` and dispatch the next pending node. The parent then writes the final Chinese synthesis from those results.
5. The parent must not launch unbounded training jobs. Children must respect the one-hour overall default and the node timebox recorded in `PLAN.md`.

**Honest stop (child and parent):** A child may fix-and-retry a broken experiment at most **3** times (change code/config, then rerun). If it still fails, overruns its planned timebox, or the metric is still different, record the actual logs/numbers/error and continue with a reasoned limitation when possible. Do not invent a match, do not keep looping, and do not expand into full-data or paper-scale work unless strict mode was explicitly requested.

If `task` is denied, walk the seven stages yourself as below, still one experiment at a time, and apply the same honest-stop and one-hour soft-timebox rules.

## Working directory layout

For each paper reproduction, set up a dedicated workspace:

```
repro/<paper-arxiv-id>/
├── paper.md              # structured extract from stage 1
├── inventory.md          # what exists / missing from stage 2
├── gaps_filled.md        # hyperparam table with provenance from stage 3
├── code/                 # implementation from stage 4 (or cloned + extended)
├── data/                 # dataset symlinks or actual data from stage 5
├── dataset_substitution.md  # if a public dataset stood in for a private one
├── smoke_logs/           # outputs from stage 6
└── results.md            # budgeted verification from stage 7
```

On this product the live workspace is the conversation root (`files/`, `experiment/`, `forecast/`, `esopt/`). Prefer those paths when they exist.

## Cross-references

- After stage 3, hand the gap analysis off to the `paper-verification` skill only if that skill is actually loaded.
- Stage 4 implementation should stay small: each filled value cites the paper section.
- Stage 6 smoke failures: debug the current run; do not restart with a larger config.
- Stage 7 is a representative verification by default. It does not require a multi-hour launch checklist.
- Stage 7 comparisons use the actual setup. Never claim a paper-scale match you did not run.

## Output

For each reproduction, the final artifact is `results.md` with absolute deltas (not just %) and a run-type label:

- `[method-level verify]`: default one-hour-bounded representative run; do not call this a paper-scale match
- `[compressed verify]`: use when the run is deliberately much smaller than the paper or constrained by the machine
- `[strict reproduction]`: only after the user explicitly requests paper-scale/full-data matching
- `[matched within 0.X pp]`: only if the paper itself used a similarly small setup and the number is within variance
- `[gap, hypothesis: ...]`: measurable underperformance or truncated training, with a stated hypothesis
- `[fundamental disagreement, see X]`: the result and the paper's claim are inconsistent in a way that needs investigation

If the workspace is on a public repo, link the workspace README from the project's main reproduction-tracking doc.
