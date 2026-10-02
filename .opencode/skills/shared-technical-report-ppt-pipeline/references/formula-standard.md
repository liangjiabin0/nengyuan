# Mathematical formula accuracy and typography standard

Use this standard for every displayed equation. Formula correctness has two
independent requirements: the mathematical structure must match the source, and
the rendered equation must be visually balanced and unclipped. A screenshot can
help comparison but is never the final equation object.

## 1. Establish a single source of truth

Copy each equation from the report and resolve ambiguous symbols against nearby
variable definitions. Create one entry per displayed equation using
`formula-manifest-schema.json`. Keep both:

- `display`: a human-readable transcription for review;
- `canonical`: the same equation with stable symbols and spacing removed for
  machine comparison;
- `requiredTokens`: every identifier, operator, bound, and constant that must be
  present;
- `requiredStructures`: fractions, radicals, scripts, n-ary operators, matrices,
  delimiters, or aligned equation arrays that must exist as Office Math nodes;
- semantic variable roles and the exact equation number;
- normalized reference/candidate crop boxes when a source image is available.

Example:

```json
{
  "id": "eq-4-14",
  "slide": 6,
  "source": "section 4.2.2, equation (4-14)",
  "display": "E_{PV,t} = η_{PV} G_t A",
  "canonical": "E_{PV,t}=η_{PV}G_tA",
  "equationNumber": "（4-14）",
  "mathFont": "Cambria Math",
  "requiredTokens": ["E", "PV", "t", "=", "η", "G", "A"],
  "requiredStructures": ["subscript"],
  "variables": [
    {"symbol": "E", "role": "scalar", "style": "italic"},
    {"symbol": "PV", "role": "descriptive-subscript", "style": "upright"},
    {"symbol": "t", "role": "index", "style": "italic"}
  ]
}
```

Run `scripts/validate_formula_manifest.py` before PPT authoring. Do not generate an
equation from OCR alone when an editable report source or source definition exists.

## 2. Use native Office Math

Use `scripts/native_formula.mjs` with `@oai/artifact-tool`. It creates editable
Office Math stored as OMML (`m:oMath`) inside the PPTX. Build complex equations
from structured nodes. Never place visible LaTeX, caret/underscore approximations,
Unicode superscript characters, or equation screenshots in the final deck.

For a simple expression, `mathFromLatex` may be used as an internal parser only if
the exported object is native Office Math and package/render audits pass. Rebuild
unsupported syntax with the helper DSL instead of accepting a degraded result.

```js
import * as artifact from "@oai/artifact-tool";
import { pathToFileURL } from "node:url";

const helperUrl = pathToFileURL(
  `${process.env.SKILL_DIR}/scripts/native_formula.mjs`,
).href;
const { createFormulaHelpers } = await import(helperUrl);

const { formula, seq, scalar, vector, upright, op, scripts } =
  createFormulaHelpers(artifact);

const eq = formula(seq(
  scripts(scalar("E"), seq(upright("PV"), op(","), scalar("t"))),
  op("="),
  scripts(scalar("η"), upright("PV")),
  scripts(scalar("G"), scalar("t")),
  scalar("A"),
));

formulaBox.text = [[{ math: eq }]];
formulaBox.text.style = {
  typeface: "Cambria Math",
  fontSize: 28,
  color: "#0E4B43",
};
```

## 3. Mathematical typography

- Native equation font: Cambria Math by default. It is designed for Office Math
  and is the Office equation default. A template-specific math font is allowed
  only after a successful render and package audit.
- Chinese labels and explanations: the template's Chinese font.
- Scalar variables and variable indices: italic.
- Vectors and matrices: bold italic.
- Descriptive subscripts such as PV, CHP, EV, Grid, DA, RT, buy, sell, max, and
  min: upright.
- Function names such as min, max, exp, Pr, Quant, diag, sin, and ln: upright.
- Numbers, operators, units, and explanatory words: upright.
- Use true math structures for scripts, fractions, radicals, sums, products,
  integrals, limits, matrices, and growing delimiters.

Do not color individual variables unless the source uses a semantic color key. In
the restrained green style, the entire equation is dark green or near-black.

## 4. Equation layout and visual polish

- Match a supplied template first. Without a measured equation style, use the
  formula-first frame in `green-technical-report-style.md`.
- Main display equations normally use 26–32 pt. Secondary constraints may use
  22–26 pt. Never make a displayed equation smaller than the surrounding body.
- Keep at least 0.35× the equation's cap height of clear space above and below.
- Start multi-line systems with an Office Math equation array. PowerPoint may
  center array columns instead of reproducing LaTeX column alignment exactly, so
  verify the render. If relation-sign alignment remains visibly poor, use one
  native Office Math object per row and align those objects to shared measured
  anchors; never simulate the mathematics with ordinary text.
- Place the equation number in a separate editable text box aligned to the right
  edge of the equation group. Keep the number out of the mathematical expression,
  because Office conversion may discard LaTeX tag/label commands.
- Break a long equation only at an equality, inequality, implication, or major
  addition/subtraction boundary. Never detach a base symbol from its scripts or a
  numerator from its denominator.
- Use white or very pale green behind the formula and no more than one thin green
  outline or separator. Avoid shadows, gradients, multi-color variables, and a
  grid of formula cards.

## 5. Deterministic correctness checks

Run three checks after export:

1. **Manifest validation**: required source, canonical expression, tokens,
   structures, semantic roles, and crop bounds are present.
2. **Package audit**: `audit_formula_pptx.py` extracts `m:oMath`, concatenates
   `m:t` runs, compares the canonical expression, checks required OMML structures
   and equation numbers, and reports font evidence.
3. **Render audit**: render at least 2× the normal review resolution, crop the
   normalized formula region, and compare it with the source crop. Inspect missing
   glyph boxes, clipped ascenders/descenders, inconsistent baselines, relation-sign
   alignment, delimiter growth, and equation-number position. Run the normal
   slide-level visual difference check as well.

Required commands:

```bash
python3 "$SKILL_DIR/scripts/validate_formula_manifest.py" \
  "$TMP_DIR/formula-manifest.json"
python3 "$SKILL_DIR/scripts/audit_formula_pptx.py" \
  "$FINAL_PPTX" "$TMP_DIR/formula-manifest.json" \
  --output "$TMP_DIR/formula-audit.json"
```

Fail the slide if a required token/structure or equation number is missing, the
canonical comparison fails, raw formula markup is visible, the equation is not a
native Office Math object, or the rendered crop clips any mathematical component.
Unsupported LaTeX commands can survive conversion as literal text, so treat any
visible command sequence as a hard failure. Do not hide a failure by replacing the
formula with an image.
