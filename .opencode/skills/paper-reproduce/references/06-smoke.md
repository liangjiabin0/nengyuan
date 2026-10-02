# Stage 6: Smoke runs

Three gated tiers. Each is cheap; each catches a class of failures the next can't. Do not advance to stage 7 until all three pass.

Smoke plus stage 7 should leave the complete workflow inside the **one-hour default timebox**. Read `experiment/runtime-budget.json` first. Use a short trajectory, not a convergence run.

If any tier fails, debug the current run. Do NOT restart with a larger config, more epochs, or a full dataset.

## Tier 1: Forward pass smoke (~20 seconds)

The cheapest test. One batch through the model in `train` and `eval` mode.

```python
# scripts/smoke_forward.py
model = build_model_from_config("configs/repro-default.yaml")
batch = next(iter(build_dataloader(...)))

# Train mode
model.train()
out_train = model(batch)
loss_train = compute_loss(out_train, batch.label)
print(f"train loss: {loss_train.item()}")
assert torch.isfinite(loss_train), "train loss is NaN/Inf"

loss_train.backward()
total_grad = sum(p.grad.norm() for p in model.parameters() if p.grad is not None)
print(f"total grad norm: {total_grad}")
assert total_grad > 0, "no gradient flowed"

# Eval mode
model.eval()
with torch.no_grad():
    out_eval = model(batch)
print(f"eval output shape: {out_eval.shape}")
```

**Pass criteria:**

- training-mode forward produces finite loss
- gradient norm > 0 (gradients are flowing through the network)
- eval-mode forward produces finite output of the expected shape
- the _value_ of the initial training loss is within 2× of what the paper's initial-loss should be (e.g. for cross-entropy on 1000 classes, initial loss ≈ ln(1000) ≈ 6.9)

If the initial loss is wildly off (e.g. 0.001 or 1000), there's a bug in the loss or in the data labels.

## Tier 2: Single-step optimizer smoke (~30 seconds)

Forward → backward → optimizer step → forward again. Loss should decrease.

```python
optimizer = build_optimizer(model.parameters(), config)
scheduler = build_scheduler(optimizer, config)

batch = next(iter(dataloader))

loss_before = compute_loss(model(batch), batch.label)
optimizer.zero_grad()
loss_before.backward()
optimizer.step()
scheduler.step()

loss_after = compute_loss(model(batch), batch.label)
print(f"loss: {loss_before.item()} -> {loss_after.item()}")
assert loss_after.item() < loss_before.item(), "loss did not decrease after one step"
```

**Pass criteria:**

- loss strictly decreased (allow tiny epsilon for fp16 noise)
- no parameter became NaN / Inf during the step
- optimizer state is populated for all parameters that received gradients

If loss doesn't decrease, common causes:

- learning rate too low (loss decrease is below numerical precision)
- gradient is masked by gradient clipping at 0
- wrong loss reduction (sum vs mean)
- model is in eval mode or BN is frozen when it shouldn't be

## Tier 3: Short trajectory smoke (~60 seconds)

Real training, but tiny. Use `smokeIters` from the probe (5–8), not 20 minutes of iteration.

```python
import time
iters = int(os.environ.get("SMOKE_ITERS", "8"))
deadline = time.time() + 60
losses = []
for step in range(iters):
    if time.time() >= deadline:
        break
    batch = next(iter(dataloader))
    loss = compute_loss(model(batch), batch.label)
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()
    scheduler.step()
    losses.append(loss.item())
    print(f"step {step}: loss = {loss.item():.4f}")

assert losses, "no smoke steps ran"
if len(losses) >= 3:
    rolling = [sum(losses[i:i+3])/3 for i in range(len(losses)-2)]
    trend_down = all(rolling[i+1] <= rolling[i] * 1.08 for i in range(len(rolling)-1))
    assert trend_down, f"loss did not trend down: {rolling}"
```

**Pass criteria:**

- at least a few finite steps completed inside 60 seconds
- no NaN / Inf at any step
- if ≥3 steps ran, a short rolling average did not explode

If tier 3 fails after tiers 1-2 pass, common causes:

- learning rate is too high (early loss spike, then NaN)
- batch size is wrong (loss is jittery due to too-small batches)
- data shuffling is broken (training on the same batches repeatedly)
- BN running stats are broken (eval suddenly diverges from train)

## What to do on failure

Do NOT restart with a different, larger config and "see if it works." That hides the bug and consumes the reproduction timebox.

Write the failing tier, the actual loss/error, and stop or apply one targeted fix.

## Output

A `smoke_logs/` directory with one log file per tier, captured outputs, and a `smoke_status.md`:

```markdown
# Smoke status

- Device budget: read experiment/runtime-budget.json
- Tier 1 (forward): PASS/FAIL + numbers
- Tier 2 (single step): PASS/FAIL + numbers
- Tier 3 (short iters): PASS/FAIL + numbers
```

## Success criteria

All three tiers pass, or a later tier is skipped because the remaining timebox is too small (record that skip). Stage 7 is one representative verification, not a paper-scale launch.
