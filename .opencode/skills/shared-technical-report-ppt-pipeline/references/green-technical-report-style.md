# Green technical-report visual profile

Read this profile when the user asks for the restrained green research style, when
the supplied visual reference is `38-2分钟汇报PPT.pdf`, or when no newer template or
brand system overrides it. A current user template always has priority.

Machine-readable values for prompt builders and slide generators are stored in
[`green-style-profile.json`](green-style-profile.json).

The inspected visual sample is bundled privately with this personal skill at
`assets/green-style-reference/38-2分钟汇报PPT.pdf`; its nine-page contact sheet is
`assets/green-style-reference/contact-sheet.png`. Use these only as style/template
references. Their visible report content is not reusable evidence for another
deck, and their logo must not be reproduced unless the current user-provided
source authorizes it.

## What was measured

The reference contains nine 16:9 pages at 960 × 540 pt. Its content pages use a
flat white or very pale cyan-green canvas, a compact header, one large narrative
block, and one or two large evidence visuals below it. The visual language is
technical and institutional rather than decorative.

Measured typography in the PDF:

- Chinese: Microsoft YaHei and Microsoft YaHei Bold;
- content-page section title: 28 pt bold;
- narrative copy: 24 pt, with bold/color emphasis inside the same paragraph;
- figure caption: about 14 pt;
- page number: 16 pt;
- cover title: about 44 pt; closing title: 54 pt.

Measured source colors:

| Role | Source sample | Use |
| --- | --- | --- |
| body text | `#333333` | normal narrative copy |
| secondary text | `#555555` | captions and metadata |
| dark teal | `#113B3F` | strong headings and cover metadata |
| title teal | `#21717A` | content-page titles |
| cyan line | `#62C9D4` | thin outlines and separators |
| pale cyan | `#EAF8F9` | quiet background or panel wash |
| emphasis red | `#C00000` | one decisive phrase, never a general accent |

For new previews requested as “green first”, translate the teal samples into a
green-teal family while keeping the measured contrast and hierarchy:

- primary green: `#177565`;
- dark green: `#0E4B43`;
- line/accent green: `#5FC4B2`;
- pale green background: `#EAF7F2`;
- body and secondary neutrals: `#333333`, `#555555`;
- optional emphasis red: `#C00000`, limited to one short source-backed phrase.

## Color budget

- Use one green family plus neutral black/gray/white on ordinary pages.
- A page may use at most three chromatic colors, including colors inside native
  charts. Prefer green tints, line styles, markers, and direct labels over a
  rainbow categorical palette.
- Red is an exception for a source-backed warning or key conclusion and should
  occupy less than roughly 3% of the page. Do not pair red with unrelated orange,
  purple, and blue accents.
- Recolor allowlisted SVG icons to the same primary/dark green. Use one stroke
  width per deck.
- Keep photographs and source figures in their original color, but do not sample
  their colors into new decorative elements.

## Measured content-page frame

Use normalized coordinates so the profile works at any 16:9 resolution:

- page margins: left/right about 3%–5%;
- section-title band: `y=0.04–0.105`, title left at `x≈0.048`;
- header separator: `y≈0.13`;
- narrative band: `x=0.032–0.968`, `y=0.16–0.44`;
- lower visual band: `x=0.045–0.955`, `y=0.47–0.93`;
- figure captions: `y=0.94–0.985`;
- page number: bottom-right, baseline near `y=0.965`.

The reference commonly indents only the first line of the narrative. Preserve
bold or red emphasis inline rather than breaking the sentence into cards.

## Preferred layouts

### A. Upper narrative, lower evidence

This is the default content page.

- Header and separator: top 13%.
- Summary paragraph: 3–5 lines in the upper 25%–31%.
- Evidence region: one large figure, a two-column figure pair, or a figure plus an
  editable table in the lower 46%–50%.
- Captions sit directly below their visuals. Avoid floating labels and extra
  badges.

### B. Compact narrative, larger visual

Use when a diagram or chart carries most of the evidence.

- Summary paragraph ends by `y≈0.35`.
- Main visual begins by `y≈0.39` and may extend to `y≈0.93`.
- Keep one dominant visual composition; do not convert it into a dashboard grid.

### C. Formula-first technical page

The reference PDF does not contain a dedicated display-equation page, so this
layout inherits its palette, margins, and hierarchy but follows the formula
accuracy standard for the mathematical region.

- Header and one short source-grounded statement: top 24%–29%.
- Main native equation group: `x=0.08–0.92`, `y=0.31–0.62`.
- Variable definitions, constraints, or a small explanatory diagram: `y=0.65–0.88`.
- Optional conclusion line: `y=0.90–0.95`.
- Use white or pale green behind the equation and a single thin green rule. Avoid
  decorative formula cards, gradients, and colored variables.

## Preview-generation constraints

Prompts must explicitly say: green is the primary color, the palette is limited,
the style is spacious and concise, and the normal composition is upper text with
lower imagery. Image generation must reserve clean rectangles for editable text,
native charts, and formulas. It must not render authoritative formula glyphs or
invent colorful icons. Composite only the local allowlisted SVG icons afterward.

After generating a preview, run `scripts/audit_preview_palette.py`. Declare only
the normalized boxes occupied by immutable source photographs/figures as
`--ignore-box`; do not mask generated illustrations or icons. The default audit
allows green hues, neutrals, and a small red exception, and fails when unrelated
chromatic pixels exceed 2.5% of the unmasked page or red exceeds 3%.

```bash
python3 "$SKILL_DIR/scripts/audit_preview_palette.py" preview.png \
  --ignore-box 0.045,0.47,0.91,0.46 \
  --output "$TMP_DIR/preview-palette.json"
```
