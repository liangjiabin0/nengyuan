# Task-specific program and artifact workflow

Use this reference when the user wants the interaction pattern “input file + one sentence → show generated program and solve process → deliver program and documents.” This is an artifact wrapper around the existing solver, not a new mathematical model.

## Required interaction stages

1. **Input recognition**: name the input type, case/scenario mode, network size, configured resources, periods/scales, and blocking validation errors.
2. **Model composition**: state the selected scope, boundary mode, physical/resource modules, time modules, objective, and important assumptions.
3. **Program generation**: run `task_pipeline.py prepare`, then link `generated_dispatch.py`, `normalized_input.json`, and `model_document.md`. Briefly explain the generated program before executing it.
4. **Solve process**: execute the generated program with unbuffered Python. Stream concise stage updates and solver output; do not hide nonzero return codes or infeasibility.
5. **Validation and delivery**: check solver success plus engineering residuals, then link the fixed artifact package.

Do not paste the entire generated program into chat unless the user asks. Show its purpose, command, model route, and relevant excerpt; keep the complete file as the source of truth.

## Commands

Prepare a task package from a snapshot case:

```powershell
& '<python>' '<skill-root>\scripts\task_pipeline.py' prepare '<case-file>' `
  --sidecar '<sidecar.json>' --profiles '<profiles.json>' `
  --request '<original request>' --output '<task-directory>'
```

Prepare one from a schema-v2 modular scenario:

```powershell
& '<python>' '<skill-root>\scripts\task_pipeline.py' prepare '<scenario.json>' `
  --request '<original request>' --output '<task-directory>'
```

Then run the generated program visibly:

```powershell
& '<python>' -u '<task-directory>\generated_dispatch.py'
```

The preparation command refuses to overwrite known task files unless `--force` is explicitly supplied. Prefer a new task directory over force.

## Fixed artifact contract

| Artifact | Purpose |
|---|---|
| `generated_dispatch.py` | Task-specific, repeatable entry program with resolved inputs and backend command |
| `normalized_input.json` | Input hashes, network/model summary, selected route, and exact execution command |
| `model_document.md` | Task, equations, modules, boundaries, limitations, and validation requirements |
| `task_manifest.json` | Prepared/running/complete/failed status and artifact inventory |
| `solve.log` | Combined solver stdout/stderr with command and timestamps |
| `delivery_report.md` | Final status and links to task artifacts/results |
| `results/` | Existing snapshot or portfolio reports, JSON matrices, CSV schedules, exchanges, residuals, and states |

The reusable solver remains in the skill. The generated program is intentionally a thin, auditable task driver; do not duplicate thousands of lines of numerical backend code into every delivery.

## Acceptance checks

- The natural-language request is preserved in all task-level metadata and documentation.
- Every source input has an absolute path, SHA-256 hash, and byte size.
- The generated program uses a list-form subprocess command and never invokes a shell.
- The UI shows preparation before execution and exposes the generated program before solving.
- `solve.log` exists even when solving fails.
- `task_manifest.json` records the real return code and final state.
- A solver return code of zero is necessary but not sufficient; apply the domain validation sequence in [model-and-validation.md](model-and-validation.md).
