---
name: modelica-standard-style
description: Constrain Modelica modeling and review work to Modelica Standard Library style. Use when Codex needs to create, modify, refactor, or review `.mo` models and should follow standard-library conventions for interfaces, types, equations, initialization, documentation, annotations, and tests. Also use when the user wants edits limited to an explicitly specified scope and wants confirmation before touching related models outside that scope.
---

# Modelica Standard Style

## Overview

Use this skill to keep Modelica work close to Modelica Standard Library style while honoring the user's editing boundaries.

## Workflow

### 1. Determine task mode

Choose one of these modes before writing code:

- New single model: create only the requested model unless the user explicitly asks for package, tests, or surrounding library structure.
- In-scope modification: edit only the model, file, or range the user identified.
- Out-of-scope dependency change: stop and ask before modifying any related model, base class, interface, package, or test outside the requested scope.
- Review: inspect the existing model against the checklist in `references/review-checklist.md`.

### 2. Follow standard-library style first

Default to Modelica Standard Library conventions:

- Prefer standard library connectors, units, constants, and reusable primitives.
- Prefer clear `equation` sections over imperative logic.
- Keep models modular and physically legible.
- Keep core semantics tool-neutral.

Read `references/standards.md` when writing or reviewing code.

### 3. Respect scope constraints

Apply these rules strictly:

- When creating a single new model, do not expand the task into package design, library restructuring, helper classes, or test scaffolding unless the user asks.
- When modifying an existing model, do not touch any file outside the user-specified scope without asking first.
- If the requested change cannot be completed safely without related edits, explain why and request confirmation before proceeding.

### 4. Generate or revise the model

When writing Modelica:

- Start with correct `within` only if the target file is already part of a package path or the user gave that context.
- Use meaningful names in standard-library style.
- Prefer `Modelica.Units.SI` types.
- Use `Real(unit="...")` only when a standard type is unavailable.
- Add Chinese comments with units when the user's conventions require them.
- Keep parameters grouped with `Dialog(tab=..., group=...)` when the model is intended for reusable library use.
- Put state initialization in `initial equation`.
- Put sequential or special-purpose logic in `function`, not directly in the `model`, unless the user explicitly wants a different pattern.

### 5. Self-check before finalizing

Before returning a model or patch, check:

- Does it stay within the requested edit scope?
- Does it follow standard-library style instead of ad hoc custom patterns?
- Are interfaces, units, initialization, and annotations consistent?
- Did any necessary but out-of-scope change remain unmade because approval is required? If so, say that explicitly.

## Review Guidance

For reviews, prioritize:

- Non-standard interfaces where standard ones exist
- Missing units or weak typing
- Unclear or imperative logic in the model body
- Hidden behavior through deep `extends`
- Hard-coded initialization or unexplained magic numbers
- Unnecessary package or cross-file churn beyond the requested scope

Use `references/review-checklist.md` as the default rubric.

## References

- `references/standards.md`: standard-library-style rules and default decisions
- `references/review-checklist.md`: concise audit checklist for generation and review
