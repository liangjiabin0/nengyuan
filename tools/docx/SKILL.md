---
name: docx
description: "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files) or Word templates (.dotx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', '.dotx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx or .dotx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a 'report', 'memo', 'letter', 'template', or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation."
license: Proprietary. LICENSE.txt has complete terms
---

# DOCX creation, editing, and analysis

A `.docx` is a ZIP archive of XML files, but you should not be writing that XML.
Choose your approach by task — in this project [ai4es.md](ai4es.md) decides:

| Task | Approach |
|---|---|
| **Create** a report or any document with formulas, tables, figures | Write Markdown, run `scripts/build_docx.py` (pandoc + template) — see ai4es.md |
| **Create** a special layout Markdown cannot express (letter, form) | Write a `docx` (npm) script — see gotchas below |
| **Edit** an existing document | python-docx: open, change paragraphs/tables through its API, save |
| **Read** content | `markitdown file.docx` |

Never hand-write `word/document.xml` or build body XML with ElementTree/regex.

> Script paths below are relative to this skill's directory. Every `scripts/office/*.py`
> helper runs the same way on Windows, Linux and macOS — no `unzip`, `zip`, `ls`,
> `find` or `soffice` on PATH required.

## Creating with docx-js — gotchas

`docx` is preinstalled — do not run `npm install` first; write the script and `require('docx')` directly. Only if that require fails: `npm install docx`. The model knows the API; these are the footguns:

- **Page size defaults to A4.** For US Letter set `page: { size: { width: 12240, height: 15840 } }` (DXA; 1440 = 1″).
- **Landscape:** pass portrait dimensions and `orientation: PageOrientation.LANDSCAPE` — docx-js swaps width/height internally.
- **Tables need dual widths:** set `columnWidths` on the table AND `width` on every cell, both in `WidthType.DXA` (PERCENTAGE breaks in Google Docs). Column widths must sum to the table width.
- **Table shading:** use `ShadingType.CLEAR`, never `SOLID` (renders black).
- **Lists:** never insert `•` literally; use a `numbering` config with `LevelFormat.BULLET`.
- **`ImageRun` requires `type:`** (`"png"`, `"jpg"`, …).
- **`PageBreak` must be inside a `Paragraph`.**
- **Never use `\n`** — use separate `Paragraph` elements.
- **TOC:** headings must use built-in `HeadingLevel.*`; custom heading styles need `outlineLevel` set or they won't appear.
- **Don't use a table as a horizontal rule** — use a paragraph bottom border instead.
- **Dot-leader / right-aligned-on-same-line:** use `PositionalTab` (`alignment: PositionalTabAlignment.RIGHT`, `leader: PositionalTabLeader.DOT`) inside a `TextRun`, not literal `.` or space padding.

## Verify the output

Two different questions, in this order. Never skip step 1 and never let step 2 block you.

**1. Will Word open it?** Structure only, one second, works everywhere:

```bash
python scripts/office/preflight.py output.docx          # exit 1 = Word would refuse it
python scripts/office/validate.py output.docx           # XSD; --auto-repair fixes common issues
```

`preflight.py` names the cause: a broken zip entry, an `mc:Ignorable` prefix that is no
longer declared, a media part with no content type, a dangling `r:embed`. Fix what it
reports before you open the file in anything — a corrupt package looks identical to a
renderer problem from the outside, and telling them apart by trial and error costs
half an hour.

**2. Does the layout look right?** Needs a renderer, which not every machine has:

```bash
python scripts/office/render.py --probe                 # which engines exist here
python scripts/office/render.py output.docx --pages --dpi 100 --json
```

`render.py` uses LibreOffice when it is installed and Word/Excel/PowerPoint COM on
Windows when it is not, always under a timeout, and writes `output-page-01.jpg`… Then
Read the images. **Exit code 3 means this machine has no renderer**: say the page
images were not checked and move on — do not hunt for `soffice`, do not drive Word COM
yourself. Exit 4 means the engine hung and was killed; the document is not implicated.

It also reports a `math` section: every `m:oMath` in the source must still be findable
in the PDF. **Exit code 5 means the PDF lost the formulas** — that happens when a PDF
is rebuilt from paragraph text (`python-docx`, `pandoc`, ReportLab) instead of rendered,
because those paths cannot see math runs. Re-render; never ship the text-rebuilt PDF.
To audit a PDF you already have: `render.py source.docx --pdf existing.pdf --verify-only`.

## Editing existing documents

Legacy `.doc` files must be converted first, which needs LibreOffice:
`python scripts/office/soffice.py --headless --convert-to docx file.doc`. Exit code 3
means LibreOffice is absent — ask the user for a `.docx` instead of improvising.

Plain edits — replace text, update table values, add paragraphs in an existing
style — go through python-docx (`Document(path)`, edit runs/cells, `save`). It keeps
element order valid, so the file cannot end up "corrupt". Unpack the package only
for what python-docx cannot reach (tracked changes, comments), and then change the
minimum in place:

```bash
python scripts/office/package.py unpack doc.docx unpacked/   # rejects symlink entries
python scripts/merge_runs.py unpacked/   # coalesce fragmented runs so text is findable
# edit unpacked/word/document.xml in place — do NOT reformat or pretty-print
python scripts/office/package.py pack unpacked/ out.docx
python scripts/office/preflight.py out.docx
python scripts/office/validate.py out.docx --original doc.docx
# redlining? add --author "<the name you redlined under>" to check every edit is tracked
```

Copying a template and swapping one part is a single call — use it instead of
hand-rolling zip surgery:

```bash
python scripts/office/package.py replace template.docx out.docx \
    --part word/document.xml=body.xml --add word/media/fig1.png=fig1.png
```

`replace` registers the content type for each added extension and rebuilds every zip
entry from scratch. Two traps it exists to avoid, both of which produce a file that
Python can still read and Word calls corrupt:

- **Never pass a `ZipInfo` from one archive to another archive's `writestr`.** It
  carries the source header offset and flag bits; Word rejects the result and even
  `zipfile` may later raise "Bad magic number for file header".
- **Never round-trip a part through `ElementTree` without registering prefixes
  first.** `ET` drops every namespace it was not told about, so `w14`/`wp14`/`mc`
  disappear while `mc:Ignorable` still lists them. Call
  `package.register_ooxml_namespaces()` (or edit the XML as bytes).

Word splits text across many `<w:r>` runs (revision ids, spell-check markers), so a phrase you can see in the document often doesn't exist as a contiguous string in the XML. `merge_runs.py` merges adjacent identically-formatted runs in `word/document.xml` without changing content or rendering; it also accepts a `.docx` directly (`python scripts/merge_runs.py doc.docx -o merged.docx`).

**Tracked changes:** when redlining, validate with `--author "<the name you redlined under>"` (needs `--original`) — it reports any text you changed without a `<w:ins>`/`<w:del>` around it, which is easy to do by accident and invisible in the accepted view. Wrap runs in `<w:ins>`/`<w:del>` with `w:id`, `w:author`, `w:date` attributes. Inside `<w:del>`, the text element is `<w:delText>`, not `<w:t>`. A deleted paragraph mark (`<w:pPr><w:rPr><w:del w:id=".." w:author=".." w:date=".."/></w:rPr></w:pPr>`) means "merge this paragraph into the next" — so deleting a paragraph outright is that plus a `<w:del>` around every run. The `<w:del/>` must come before the rPr's other children; their order is schema-enforced.

To produce a clean copy with all tracked changes accepted: `python scripts/accept_changes.py in.docx out.docx`.

Accepting a deleted paragraph mark should join that paragraph to the one below it, so a paragraph whose runs are *all* deleted vanishes. Word does this; `accept_changes.py` and `pandoc --track-changes=accept` don't always. Both fail the same way — they strip the deleted text but leave the emptied paragraph behind, which reads as a stray empty bullet when it was auto-numbered:

- `pandoc --track-changes=accept` never joins the paragraphs.
- `accept_changes.py` (LibreOffice) joins them correctly, except when the deleted paragraph is followed by an empty spacer paragraph.

An empty bullet in either view is an artifact of that view, not a defect in the document. Check paragraph deletions in the XML.

## Comments

Comments require six cross-linked files. Use the helper — directory mode when you'll also be editing `document.xml` (saves an unpack/pack cycle), `.docx`-direct mode otherwise:

```bash
# Against an already-unpacked directory (preferred when also placing markers)
python scripts/comment.py unpacked/ "Fees & expenses cap is too low"
python scripts/comment.py unpacked/ "Agreed" --parent 0

# Against a .docx directly
python scripts/comment.py contract.docx "This cap is too low" -o annotated.docx
```

The script writes `comments.xml`, `commentsExtended.xml`, `commentsIds.xml`, `commentsExtensible.xml`, the relationships, and the content-type overrides. Comment IDs are auto-assigned. It then prints the `<w:commentRangeStart>`/`<w:commentRangeEnd>`/`<w:commentReference>` snippet to add to `word/document.xml` so the comment anchors to specific text — until you place those markers, the comment exists but is not visible.

## Dependencies

Required: `docx` (npm, preinstalled — install only if `require('docx')` fails) · Python
with `lxml` and `defusedxml` (the validators need both).

Optional, preview only: LibreOffice — the portable copy in `tools/libreoffice`, then
`AI4ES_SOFFICE`, `PATH` or the usual install directories; Microsoft Office (Windows COM
fallback); `pdftoppm` (Poppler, or `PDFTOPPM_PATH`; pypdfium2 is used when it is
missing). `render.py --probe` reports what is actually here in one call; ask it once
instead of probing tools one by one.

## 能元约定

完整约束见 [ai4es.md](ai4es.md)，以它为准。报告类文档一律写 Markdown 后用 `scripts/build_docx.py` 生成，示例见 `assets/report-example.md`；禁止手写 `word/document.xml`。禁止在会话目录 npm install、pip install 或创建 venv。Python 用 tools/office-docs-venv，Node 包用仓库 node_modules。成品写入 `deliverables/`。数学公式变量用 Times New Roman 斜体，禁止把 Markdown / LaTeX 源码写进交付文件。读已有附件用 `markitdown`。
