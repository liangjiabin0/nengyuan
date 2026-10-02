# Modelica Standard Library Style

Default decisions when writing or reviewing `.mo` models for this system.

## Interfaces and types

- Prefer `Modelica.Blocks.Interfaces` and `Modelica.Electrical` / `Modelica.Thermal` connectors over ad hoc `input`/`output` Real ports when a standard connector exists.
- Prefer `Modelica.Units.SI` types. Use `Real(unit="...")` only when no standard type exists.
- Keep connector causality and icons consistent with the standard library.

## Equations

- Put physics in `equation`, not in algorithm sections.
- Put state initialization in `initial equation`.
- Put sequential or special-purpose logic in `function`, not in the model body.

## Parameters and documentation

- Group reusable parameters with `Dialog(tab=..., group=...)`.
- Add Chinese comments with units when the surrounding project uses that convention.
- Avoid unexplained magic numbers; name them as parameters.

## Scope

- A new single model should not expand into package design unless requested.
- Do not edit related models outside the requested file without confirmation.
- Keep core semantics tool-neutral (OpenModelica, Dymola, or another MSL-compatible tool).
