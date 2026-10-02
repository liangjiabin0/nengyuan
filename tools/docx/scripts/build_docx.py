"""
Build a Word report from Markdown: pandoc does the conversion, this script only
applies Chinese report conventions on top through python-docx.

    python build_docx.py report.md -o deliverables/报告.docx
    python build_docx.py report.md -o out.docx --template 用户模板.docx
    python build_docx.py report.md -o out.docx --no-render

You write content, not XML. pandoc (https://pandoc.org) turns Markdown into a
valid .docx with native OMML equations, real Word tables, figures and captions,
using the template's styles, page setup, header and footer. On top of that this
script sets three-line tables, equation numbers, math fonts, the cover page
breaks and a table of contents that already shows its entries and page numbers.

Markdown conventions
    # 1 引言 / ## 1.1 小节          headings; write the numbers yourself
    $x_i$ / $$ ... $$               LaTeX math -> native Word equations
    : 表1 算例参数                   table caption line directly above a pipe table
    ![图1 系统结构](fig.png){width=80%}   figure; the alt text is the caption

Front matter (all optional)
    title, subtitle, author, date   cover page
    abstract                        摘要 page
    toc: true, toc-depth: 2         目录 with cached page numbers
    header: 页眉文字                 page-numbers: true
    equation-numbers: true          (1) (2) … at the right margin
    papersize: a4 | letter | template
    template: path/to/template.docx

The result is checked with preflight.py, validate.py and deliverable_check.py
and, when a renderer exists, rendered to page images for review. Exit code 0
means every check passed; the JSON report on stdout says what was done.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Emu, Mm, Pt, Twips

SCRIPTS_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPTS_DIR.parent
sys.path.insert(0, str(SCRIPTS_DIR))

DEFAULT_TEMPLATE = SKILL_DIR / "assets" / "cn-tech-report.docx"
LATIN_FONT = "Times New Roman"
BODY_EAST = "宋体"
HEAD_EAST = "黑体"

FRONT_STYLES = {"Title", "Subtitle", "Author", "Date"}
ABSTRACT_STYLES = {"Abstract Title", "Abstract"}


# --------------------------------------------------------------------------
# pandoc
# --------------------------------------------------------------------------

def pandoc_path() -> str:
    override = (os.environ.get("AI4ES_PANDOC") or "").strip().strip('"')
    if override and Path(override).is_file():
        return override
    try:
        import pypandoc

        return pypandoc.get_pandoc_path()
    except (ImportError, OSError):
        pass
    found = shutil.which("pandoc")
    if found:
        return found
    raise SystemExit(
        "pandoc not found: install pypandoc_binary into tools/office-docs-venv "
        "(it is listed in tools/office-docs/requirements.txt) or set AI4ES_PANDOC."
    )


def _run(cmd: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    return subprocess.run(
        cmd, cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )


# smart punctuation turns the ASCII quotes in "送"变"受" into closing quotes on both
# sides, because CJK text has no spaces for pandoc to tell opening from closing.
PANDOC_FROM = "markdown+east_asian_line_breaks-smart"


def read_metadata(md: Path) -> dict:
    """Front matter exactly as pandoc parses it, flattened to strings."""
    with tempfile.TemporaryDirectory(prefix="meta_") as tmp:
        tpl = Path(tmp) / "meta.tpl"
        tpl.write_text("$meta-json$\n", encoding="utf-8")
        done = _run([pandoc_path(), str(md), "-f", PANDOC_FROM, "-t", "plain", "--template", str(tpl)])
    if done.returncode != 0:
        raise SystemExit(f"pandoc could not read {md}:\n{done.stderr}")
    try:
        return json.loads(done.stdout or "{}")
    except json.JSONDecodeError:
        return {}


def _truthy(value, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in ("false", "no", "0", "off", "")


def run_pandoc(md: Path, reference: Path, out: Path, abstract_title: str = "摘要") -> list[str]:
    done = _run(
        [
            pandoc_path(),
            str(md.resolve()),
            "-f",
            PANDOC_FROM,
            "-t",
            "docx",
            "--reference-doc",
            str(reference),
            "--resource-path",
            str(md.resolve().parent),
            # pandoc would add its own empty "Table of Contents" for toc: true;
            # the cached 目录 comes from arrange_front_matter instead.
            "-M",
            "toc=false",
            "-M",
            f"abstract-title={abstract_title}",
            "-o",
            str(out),
        ],
        cwd=md.resolve().parent,
    )
    if done.returncode != 0:
        raise SystemExit(f"pandoc failed:\n{done.stderr}")
    return [line for line in (done.stderr or "").splitlines() if line.strip()]


# --------------------------------------------------------------------------
# small OOXML helpers (formatting python-docx has no API for)
# --------------------------------------------------------------------------

def _set_east_asian_font(rpr_owner, east: str, latin: str = LATIN_FONT) -> None:
    rpr = rpr_owner.get_or_add_rPr()
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rpr.insert(0, fonts)
    for key in ("w:ascii", "w:hAnsi", "w:cs"):
        fonts.set(qn(key), latin)
    fonts.set(qn("w:eastAsia"), east)


def _insert_ordered(parent, child, order: list[str]) -> None:
    """Insert child into parent at the position the schema sequence requires."""
    tag = child.tag
    existing = parent.find(tag)
    if existing is not None:
        parent.replace(existing, child)
        return
    rank = order.index(tag)
    for index, node in enumerate(list(parent)):
        if node.tag in order and order.index(node.tag) > rank:
            parent.insert(index, child)
            return
    parent.append(child)


TBLPR_ORDER = [
    qn(t)
    for t in (
        "w:tblStyle", "w:tblpPr", "w:tblOverlap", "w:bidiVisual", "w:tblStyleRowBandSize",
        "w:tblStyleColBandSize", "w:tblW", "w:jc", "w:tblCellSpacing", "w:tblInd",
        "w:tblBorders", "w:shd", "w:tblLayout", "w:tblCellMar", "w:tblLook",
        "w:tblCaption", "w:tblDescription",
    )
]
TCPR_ORDER = [
    qn(t)
    for t in (
        "w:cnfStyle", "w:tcW", "w:gridSpan", "w:hMerge", "w:vMerge", "w:tcBorders", "w:shd",
        "w:noWrap", "w:tcMar", "w:textDirection", "w:tcFitText", "w:vAlign", "w:hideMark",
    )
]


def _border(tag: str, val: str, size: int = 0) -> OxmlElement:
    el = OxmlElement(tag)
    el.set(qn("w:val"), val)
    if val != "nil":
        el.set(qn("w:sz"), str(size))
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), "000000")
    return el


def _set_first_line_chars(paragraph_format_owner, chars: int = 2, size_pt: float = 12) -> None:
    """First-line indent in characters (Word) with a point fallback (LibreOffice)."""
    ppr = paragraph_format_owner.get_or_add_pPr()
    ind = ppr.find(qn("w:ind"))
    if ind is None:
        ind = OxmlElement("w:ind")
        order = [
            qn(t)
            for t in (
                "w:pStyle", "w:keepNext", "w:keepLines", "w:pageBreakBefore", "w:framePr",
                "w:widowControl", "w:numPr", "w:suppressLineNumbers", "w:pBdr", "w:shd",
                "w:tabs", "w:suppressAutoHyphens", "w:kinsoku", "w:wordWrap",
                "w:overflowPunct", "w:topLinePunct", "w:autoSpaceDE", "w:autoSpaceDN",
                "w:bidi", "w:adjustRightInd", "w:snapToGrid", "w:spacing", "w:ind",
                "w:contextualSpacing", "w:mirrorIndents", "w:suppressOverlap", "w:jc",
                "w:textDirection", "w:textAlignment", "w:textboxTightWrap", "w:outlineLvl",
                "w:divId", "w:cnfStyle", "w:rPr", "w:sectPr", "w:pPrChange",
            )
        ]
        _insert_ordered(ppr, ind, order)
    for key in ("w:hanging", "w:hangingChars"):
        if ind.get(qn(key)) is not None:
            del ind.attrib[qn(key)]
    ind.set(qn("w:firstLineChars"), str(chars * 100))
    ind.set(qn("w:firstLine"), str(int(chars * size_pt * 20)))


def display_width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in text)


# --------------------------------------------------------------------------
# reference document: the template plus the styles pandoc and we rely on
# --------------------------------------------------------------------------

def _style(doc, name: str, base: str | None = "Normal", kind=WD_STYLE_TYPE.PARAGRAPH):
    styles = doc.styles
    try:
        style = styles[name]
    except KeyError:
        style = styles.add_style(name, kind)
    if base and kind == WD_STYLE_TYPE.PARAGRAPH:
        try:
            style.base_style = styles[base]
        except KeyError:
            pass
    return style


def _para_style(
    doc,
    name: str,
    *,
    base: str | None = "Normal",
    east: str | None = None,
    size: float | None = None,
    bold: bool | None = None,
    align=None,
    before: float | None = None,
    after: float | None = None,
    single: bool = False,
    keep_next: bool | None = None,
    indent_chars: int | None = None,
    left_indent: float | None = None,
):
    style = _style(doc, name, base)
    fmt = style.paragraph_format
    if east:
        _set_east_asian_font(style.element, east)
    if size is not None:
        style.font.size = Pt(size)
    if bold is not None:
        style.font.bold = bold
    if align is not None:
        fmt.alignment = align
    if before is not None:
        fmt.space_before = Pt(before)
    if after is not None:
        fmt.space_after = Pt(after)
    if single:
        fmt.line_spacing_rule = WD_LINE_SPACING.SINGLE
    if keep_next is not None:
        fmt.keep_with_next = keep_next
    if indent_chars is not None:
        _set_first_line_chars(style.element, indent_chars, size or 12)
    elif base != "Body Text":
        # Templates often indent Normal by two characters; captions, cover
        # lines and table cells must not inherit that.
        _set_first_line_chars(style.element, 0)
    if left_indent is not None:
        fmt.left_indent = Pt(left_indent)
    return style


def _text_width(section) -> int:
    return int(section.page_width - section.left_margin - section.right_margin)


def _add_page_field(paragraph) -> None:
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), " PAGE ")
    run = OxmlElement("w:r")
    text = OxmlElement("w:t")
    text.text = "1"
    run.append(text)
    field.append(run)
    paragraph._p.append(field)


def prepare_reference(template: Path, meta: dict, dest: Path) -> dict:
    doc = Document(str(template))
    section = doc.sections[0]

    papersize = str(meta.get("papersize") or "a4").lower()
    if papersize == "a4":
        section.page_width, section.page_height = Mm(210), Mm(297)
    elif papersize == "letter":
        section.page_width, section.page_height = Twips(12240), Twips(15840)

    for level in range(1, 10):
        try:
            heading = doc.styles[f"Heading {level}"]
        except KeyError:
            continue
        ppr = heading.element.get_or_add_pPr()
        numpr = ppr.find(qn("w:numPr"))
        if numpr is not None:
            ppr.remove(numpr)
        heading.paragraph_format.keep_with_next = True
        heading.paragraph_format.first_line_indent = Pt(0)

    normal_size = doc.styles["Normal"].font.size
    body_pt = normal_size.pt if normal_size else 12
    center = WD_ALIGN_PARAGRAPH.CENTER
    width = _text_width(section)

    _para_style(doc, "Body Text", before=0, after=0, align=WD_ALIGN_PARAGRAPH.JUSTIFY)
    _set_first_line_chars(doc.styles["Body Text"].element, 2, body_pt)
    for level in range(1, 10):
        try:
            _set_first_line_chars(doc.styles[f"Heading {level}"].element, 0)
        except KeyError:
            pass
    _para_style(doc, "First Paragraph", base="Body Text")
    _para_style(doc, "Compact", before=0, after=0)
    _para_style(doc, "Block Text", base="Body Text", left_indent=body_pt * 2)
    _para_style(doc, "Title", east=HEAD_EAST, size=22, bold=True, align=center, before=150, after=24)
    _para_style(doc, "Subtitle", east=HEAD_EAST, size=16, align=center, after=60)
    _para_style(doc, "Author", size=14, align=center, after=6)
    _para_style(doc, "Date", size=14, align=center, after=6)
    _para_style(doc, "Abstract Title", east=HEAD_EAST, size=16, bold=True, align=center, before=12, after=12)
    _para_style(doc, "Abstract", base="Body Text")
    _para_style(doc, "TOC Heading", east=HEAD_EAST, size=16, bold=True, align=center, before=12, after=12)
    _para_style(doc, "Table Caption", east=HEAD_EAST, size=10.5, align=center, before=6, after=3, keep_next=True)
    _para_style(doc, "Image Caption", east=HEAD_EAST, size=10.5, align=center, before=3, after=6)
    _para_style(doc, "Captioned Figure", align=center, single=True, keep_next=True, before=6, after=0)
    _para_style(doc, "Figure", align=center, single=True, keep_next=True)
    _para_style(doc, "Table Text", size=10.5, align=center, single=True, before=0, after=0)
    _para_style(doc, "Equation", align=center, before=3, after=3)
    for level in (1, 2, 3):
        toc = _para_style(doc, f"toc {level}", before=0, after=0, left_indent=body_pt * 2 * (level - 1))
        toc.paragraph_format.tab_stops.add_tab_stop(Emu(width), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)

    has_cover = bool(meta.get("title")) and _truthy(meta.get("cover"), True)
    header_text = str(meta.get("header") or "").strip()
    page_numbers = _truthy(meta.get("page-numbers"), True)
    if header_text or page_numbers:
        section.different_first_page_header_footer = has_cover
        if has_cover:
            for para in section.first_page_header.paragraphs:
                para.style = doc.styles["Normal"]
                para.text = ""
        if header_text:
            header = section.header
            header.is_linked_to_previous = False
            para = header.paragraphs[0] if header.paragraphs else header.add_paragraph()
            para.text = header_text
            para.alignment = center
        if page_numbers:
            footer = section.footer
            footer.is_linked_to_previous = False
            para = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
            for run in list(para.runs):
                run._r.getparent().remove(run._r)
            para.alignment = center
            _add_page_field(para)

    if meta.get("title"):
        doc.core_properties.title = str(meta["title"])
    if meta.get("author"):
        doc.core_properties.author = str(meta["author"])
    doc.save(str(dest))
    return {"text_width": width, "body_pt": body_pt, "cover": has_cover}


# --------------------------------------------------------------------------
# post-processing of pandoc's output
# --------------------------------------------------------------------------

def _style_name(paragraph) -> str:
    try:
        return paragraph.style.name if paragraph.style is not None else ""
    except (KeyError, ValueError):
        return ""


def _heading_level(paragraph) -> int | None:
    match = re.fullmatch(r"(?i)heading (\d)", _style_name(paragraph))
    return int(match.group(1)) if match else None


def fix_math_fonts(body) -> int:
    count = 0
    for mrun in body.iter(qn("m:r")):
        if mrun.find(qn("w:rPr")) is not None:
            continue
        rpr = OxmlElement("w:rPr")
        fonts = OxmlElement("w:rFonts")
        for key in ("w:ascii", "w:hAnsi", "w:cs"):
            fonts.set(qn(key), LATIN_FONT)
        fonts.set(qn("w:eastAsia"), BODY_EAST)
        rpr.append(fonts)
        mrpr = mrun.find(qn("m:rPr"))
        mrun.insert(0 if mrpr is None else list(mrun).index(mrpr) + 1, rpr)
        count += 1
    return count


# pandoc's texmath writes a few OMML property children in an order the schema
# rejects (m:count after m:mcJc) and pairs m:nor with m:sty, which CT_RPR forbids.
OMML_CHILD_ORDER = {
    qn("m:rPr"): [qn(t) for t in ("m:lit", "m:nor", "m:scr", "m:sty", "m:brk", "m:aln")],
    qn("m:mcPr"): [qn(t) for t in ("m:count", "m:mcJc")],
}


def normalize_omml(body) -> int:
    changed = 0
    for tag, order in OMML_CHILD_ORDER.items():
        for props in body.iter(tag):
            children = list(props)
            if tag == qn("m:rPr") and props.find(qn("m:nor")) is not None:
                for sty in props.findall(qn("m:sty")):
                    props.remove(sty)
                    changed += 1
                children = list(props)
            ranked = sorted(children, key=lambda c: order.index(c.tag) if c.tag in order else len(order))
            if ranked != children:
                for child in children:
                    props.remove(child)
                for child in ranked:
                    props.append(child)
                changed += 1
    return changed


def _equation_table(doc, paragraph, math_para, label: str, text_width: int) -> None:
    """Replace a display-equation paragraph with spacer | equation | number.

    Putting the number on the equation's own line would make the equation
    inline, and Word then shrinks fractions and limits to text size. A
    borderless three-column table keeps full display style in Word and
    LibreOffice alike; it is the usual layout for numbered equations.
    """
    side = int(Mm(15))
    widths = [side, text_width - 2 * side, side]
    table = doc.add_table(rows=1, cols=3)
    tbl = table._tbl
    paragraph._p.addprevious(tbl)
    style = tbl.tblPr.find(qn("w:tblStyle"))
    if style is not None:
        tbl.tblPr.remove(style)
    tblw = OxmlElement("w:tblW")
    tblw.set(qn("w:w"), str(Emu(text_width).twips))
    tblw.set(qn("w:type"), "dxa")
    _insert_ordered(tbl.tblPr, tblw, TBLPR_ORDER)
    borders = OxmlElement("w:tblBorders")
    for tag in ("w:top", "w:left", "w:bottom", "w:right", "w:insideH", "w:insideV"):
        borders.append(_border(tag, "nil"))
    _insert_ordered(tbl.tblPr, borders, TBLPR_ORDER)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    for gc, width in zip(tbl.tblGrid.findall(qn("w:gridCol")), widths):
        gc.set(qn("w:w"), str(Emu(width).twips))
    row = table.rows[0]
    row._tr.get_or_add_trPr().append(OxmlElement("w:cantSplit"))
    for cell, width in zip(row.cells, widths):
        cell.width = Emu(width)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        cell.paragraphs[0].style = doc.styles["Equation"]
    row.cells[1].paragraphs[0]._p.append(math_para)
    tcpr = row.cells[2]._tc.get_or_add_tcPr()
    _insert_ordered(tcpr, OxmlElement("w:noWrap"), TCPR_ORDER)
    number = row.cells[2].paragraphs[0]
    number.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = number.add_run(label)
    _set_east_asian_font(run._r, BODY_EAST)
    paragraph._p.getparent().remove(paragraph._p)


def number_equations(doc, enabled: bool, fmt: str, text_width: int) -> int:
    count = 0
    for paragraph in list(doc.paragraphs):
        p = paragraph._p
        paras = p.findall(qn("m:oMathPara"))
        if len(paras) != 1:
            continue
        others = [c for c in p if c.tag not in (qn("w:pPr"), qn("m:oMathPara"), qn("w:bookmarkStart"), qn("w:bookmarkEnd"))]
        if others:
            continue
        paragraph.style = doc.styles["Equation"]
        if not enabled or len(paras[0].findall(qn("m:oMath"))) != 1:
            continue
        count += 1
        _equation_table(doc, paragraph, paras[0], fmt.format(n=count), text_width)
    return count


HALF_CHAR = Pt(10.5 * 0.55)
CELL_PAD = Pt(12)


def column_widths(rows, ncols: int, text_width: int) -> list[int]:
    """Give short columns (numbers, symbols, labels) their natural width so they
    never wrap mid-number, and share what is left among the long-text columns."""
    natural = [0] * ncols
    for r_index, row in enumerate(rows):
        for col, cell in enumerate(row.cells[:ncols]):
            text = cell.text.strip()
            width = max((display_width(line) for line in text.splitlines()), default=0)
            if r_index == 0 and width > 8:
                width = (width + 1) // 2  # headers may wrap onto two lines
            natural[col] = max(natural[col], int(width * HALF_CHAR + CELL_PAD))
    natural = [max(n, int(Mm(12))) for n in natural]
    if sum(natural) <= text_width:
        extra = text_width - sum(natural)
        widths = [n + extra * n // sum(natural) for n in natural]
    else:
        fixed, flexible = {}, list(range(ncols))
        while flexible:
            share = (text_width - sum(fixed.values())) // len(flexible)
            fits = [c for c in flexible if natural[c] <= share]
            if not fits:
                break
            for c in fits:
                fixed[c] = natural[c]
            flexible = [c for c in flexible if c not in fixed]
        remaining = text_width - sum(fixed.values())
        weight = sum(natural[c] for c in flexible) or 1
        widths = [fixed.get(c, remaining * natural[c] // weight) for c in range(ncols)]
    widths[-1] += text_width - sum(widths)
    return widths


def format_tables(doc, text_width: int) -> int:
    count = 0
    body = doc.element.body
    for table in doc.tables:
        tbl = table._tbl
        if tbl.getparent() is not body:
            continue
        count += 1
        rows = table.rows
        ncols = len(tbl.tblGrid.findall(qn("w:gridCol"))) or max(len(r.cells) for r in rows)

        widths = column_widths(rows, ncols, text_width)

        tblpr = tbl.tblPr
        style = tblpr.find(qn("w:tblStyle"))
        if style is not None:
            tblpr.remove(style)
        tblw = OxmlElement("w:tblW")
        tblw.set(qn("w:w"), str(Emu(text_width).twips))
        tblw.set(qn("w:type"), "dxa")
        _insert_ordered(tblpr, tblw, TBLPR_ORDER)
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        borders = OxmlElement("w:tblBorders")
        for tag, val, size in (
            ("w:top", "single", 12), ("w:left", "nil", 0), ("w:bottom", "single", 12),
            ("w:right", "nil", 0), ("w:insideH", "nil", 0), ("w:insideV", "nil", 0),
        ):
            borders.append(_border(tag, val, size))
        _insert_ordered(tblpr, borders, TBLPR_ORDER)
        table.autofit = False

        grid = tbl.tblGrid
        for gc in list(grid):
            grid.remove(gc)
        for w in widths:
            gc = OxmlElement("w:gridCol")
            gc.set(qn("w:w"), str(Emu(w).twips))
            grid.append(gc)

        keep_together = len(rows) <= 20
        for r_index, row in enumerate(rows):
            trpr = row._tr.get_or_add_trPr()
            if trpr.find(qn("w:cantSplit")) is None:
                trpr.append(OxmlElement("w:cantSplit"))
            if r_index == 0 and trpr.find(qn("w:tblHeader")) is None:
                trpr.append(OxmlElement("w:tblHeader"))
            for c_index, cell in enumerate(row.cells[:ncols]):
                cell.width = Emu(widths[c_index])
                cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                if r_index == 0:
                    tcpr = cell._tc.get_or_add_tcPr()
                    tcb = OxmlElement("w:tcBorders")
                    tcb.append(_border("w:bottom", "single", 6))
                    _insert_ordered(tcpr, tcb, TCPR_ORDER)
                long_text = display_width(cell.text.strip()) > 30
                for paragraph in cell.paragraphs:
                    paragraph.style = doc.styles["Table Text"]
                    if keep_together and r_index < len(rows) - 1:
                        paragraph.paragraph_format.keep_with_next = True
                    if long_text:
                        paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
                    if r_index == 0:
                        for run in paragraph.runs:
                            run.bold = True
    return count


def fit_images(body, text_width: int) -> int:
    fitted = 0
    for inline in body.iter(qn("wp:inline")):
        extent = inline.find(qn("wp:extent"))
        if extent is None:
            continue
        cx, cy = int(extent.get("cx")), int(extent.get("cy"))
        if cx <= text_width:
            continue
        ratio = text_width / cx
        new_cx, new_cy = text_width, int(cy * ratio)
        extent.set("cx", str(new_cx))
        extent.set("cy", str(new_cy))
        for ext in inline.iter(qn("a:ext")):
            if ext.get("cx") and ext.get("cy"):
                ext.set("cx", str(new_cx))
                ext.set("cy", str(new_cy))
        fitted += 1
    return fitted


def _text_run(text: str | None = None, *, tab: bool = False) -> OxmlElement:
    run = OxmlElement("w:r")
    if tab:
        run.append(OxmlElement("w:tab"))
    if text is not None:
        t = OxmlElement("w:t")
        t.set(qn("xml:space"), "preserve")
        t.text = text
        run.append(t)
    return run


def _fld(kind: str) -> OxmlElement:
    run = OxmlElement("w:r")
    fld = OxmlElement("w:fldChar")
    fld.set(qn("w:fldCharType"), kind)
    run.append(fld)
    return run


def _new_paragraph(doc, style: str, before_element) -> "object":
    p = OxmlElement("w:p")
    before_element.addprevious(p)
    from docx.text.paragraph import Paragraph

    paragraph = Paragraph(p, doc._body)
    paragraph.style = doc.styles[style]
    return paragraph


def arrange_front_matter(doc, meta: dict, depth: int) -> dict:
    """Cover page, 摘要 page, a TOC with cached entries, and the page breaks between them."""
    paragraphs = doc.paragraphs
    front = [p for p in paragraphs if _style_name(p) in FRONT_STYLES]
    abstract = [p for p in paragraphs if _style_name(p) in ABSTRACT_STYLES]
    lead = front + abstract
    lead_elems = {p._p for p in lead}

    body_start = None
    for child in doc.element.body:
        if child.tag == qn("w:sectPr"):
            break
        if child in lead_elems or child.tag in (qn("w:bookmarkStart"), qn("w:bookmarkEnd")):
            continue
        body_start = child
        break
    if body_start is None:
        return {"toc_entries": 0}

    if abstract and front:
        abstract[0].paragraph_format.page_break_before = True

    headings = [(p, _heading_level(p)) for p in doc.paragraphs]
    headings = [(p, lvl) for p, lvl in headings if lvl and lvl <= depth and p.text.strip()]
    want_toc = _truthy(meta.get("toc"), True) and len(headings) >= 2

    toc_entries = 0
    if want_toc:
        title = _new_paragraph(doc, "TOC Heading", body_start)
        title.add_run(str(meta.get("toc-title") or "目录"))
        if lead:
            title.paragraph_format.page_break_before = True
        levels = sorted({lvl for _, lvl in headings})
        instr = OxmlElement("w:instrText")
        instr.set(qn("xml:space"), "preserve")
        instr.text = f' TOC \\o "1-{max(levels)}" \\h \\z \\u '
        for index, (heading, level) in enumerate(headings):
            entry = _new_paragraph(doc, f"toc {min(level, 3)}", body_start)
            if index == 0:
                entry._p.append(_fld("begin"))
                instr_run = OxmlElement("w:r")
                instr_run.append(instr)
                entry._p.append(instr_run)
                entry._p.append(_fld("separate"))
            entry._p.append(_text_run(heading.text.strip()))
            entry._p.append(_text_run(tab=True))
            entry._p.append(_text_run(""))
            if index == len(headings) - 1:
                entry._p.append(_fld("end"))
            toc_entries += 1

    if lead or want_toc:
        if body_start.tag == qn("w:p"):
            from docx.text.paragraph import Paragraph

            Paragraph(body_start, doc._body).paragraph_format.page_break_before = True
        else:
            spacer = _new_paragraph(doc, "Compact", body_start)
            spacer.paragraph_format.page_break_before = True
    return {"toc_entries": toc_entries, "headings": [h.text.strip() for h, _ in headings]}


def postprocess(raw: Path, out: Path, meta: dict, info: dict) -> dict:
    doc = Document(str(raw))
    body = doc.element.body
    text_width = _text_width(doc.sections[0])
    stats = {
        "omml_normalized": normalize_omml(body),
        "math_runs_fonted": fix_math_fonts(body),
        "tables": format_tables(doc, text_width),
        "numbered_equations": number_equations(
            doc,
            _truthy(meta.get("equation-numbers"), True),
            str(meta.get("equation-number-format") or "({n})"),
            text_width,
        ),
        "images_fitted": fit_images(body, text_width),
    }
    try:
        depth = int(meta.get("toc-depth") or 2)
    except ValueError:
        depth = 2
    stats.update(arrange_front_matter(doc, meta, depth))
    doc.save(str(out))
    return stats


# --------------------------------------------------------------------------
# checks, rendering, TOC page numbers
# --------------------------------------------------------------------------

def run_checks(docx: Path) -> dict:
    office = SCRIPTS_DIR / "office"
    results = {}
    for name in ("preflight", "validate", "deliverable_check"):
        cmd = [sys.executable, str(office / f"{name}.py"), str(docx)]
        if name != "validate":
            cmd.append("--json")
        done = _run(cmd)
        output = (done.stdout or "") + (done.stderr or "")
        results[name] = {"ok": done.returncode == 0, "exit": done.returncode}
        if done.returncode != 0:
            results[name]["detail"] = output.strip()[-1500:]
    return results


def _page_texts(pdf: Path) -> list[str]:
    try:
        import pymupdf

        with pymupdf.open(str(pdf)) as document:
            return [page.get_text() for page in document]
    except ImportError:
        from pypdf import PdfReader

        return [(page.extract_text() or "") for page in PdfReader(str(pdf)).pages]


def _squash(text: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))


def fill_toc_pages(docx: Path, pdf: Path, toc_title: str) -> int:
    pages = [_squash(t) for t in _page_texts(pdf)]
    doc = Document(str(docx))
    entries = [p for p in doc.paragraphs if re.fullmatch(r"(?i)toc \d", _style_name(p))]
    if not entries:
        return 0
    title_key = _squash(toc_title)
    cursor = 0
    for index, text in enumerate(pages):
        if title_key and title_key in text:
            cursor = index + 1
    filled = 0
    for entry in entries:
        runs = entry._p.findall(qn("w:r"))
        tab_index = next((i for i, r in enumerate(runs) if r.find(qn("w:tab")) is not None), None)
        if tab_index is None or tab_index + 1 >= len(runs):
            continue
        key = _squash("".join(t.text or "" for r in runs[:tab_index] for t in r.findall(qn("w:t"))))
        found = next((i for i in range(cursor, len(pages)) if key and key in pages[i]), None)
        if found is None:
            continue
        cursor = found
        target = runs[tab_index + 1].find(qn("w:t"))
        if target is not None:
            target.text = str(found + 1)
            filled += 1
    doc.save(str(docx))
    return filled


def render(docx: Path, preview_dir: Path, pages: bool, dpi: int, toc_title: str) -> dict:
    from office.render import rasterize, to_pdf, verify_math

    preview_dir.mkdir(parents=True, exist_ok=True)
    pdf = preview_dir / f"{docx.stem}.pdf"
    report = to_pdf(docx, pdf)
    if not report["ok"]:
        return {"status": "unavailable", "attempts": report["attempts"]}
    filled = fill_toc_pages(docx, pdf, toc_title)
    if filled:
        report = to_pdf(docx, pdf)
        if not report["ok"]:
            return {"status": "failed-after-toc", "attempts": report["attempts"]}
    result = {
        "status": "ok",
        "engine": report["attempts"][-1]["engine"],
        "pdf": str(pdf),
        "page_count": len(_page_texts(pdf)),
        "toc_pages_filled": filled,
        "math": verify_math(docx, pdf),
    }
    if pages:
        for old in preview_dir.glob(f"{pdf.stem}-page*.jpg"):
            old.unlink()
        result["pages"] = rasterize(pdf, dpi, 180)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Markdown -> Word report via pandoc + template")
    parser.add_argument("markdown", help="Source .md (pandoc Markdown with YAML front matter)")
    parser.add_argument("-o", "--out", required=True, help="Output .docx path")
    parser.add_argument("--template", help="Template .docx (default: assets/cn-tech-report.docx)")
    parser.add_argument("--no-render", action="store_true", help="Skip PDF/page-image rendering")
    parser.add_argument("--no-pages", action="store_true", help="Render the PDF but no page images")
    parser.add_argument("--dpi", type=int, default=80)
    parser.add_argument("--preview-dir", help="Where the preview PDF and page images go")
    args = parser.parse_args()

    md = Path(args.markdown)
    if not md.is_file():
        print(f"Error: {md} does not exist", file=sys.stderr)
        return 2
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    meta = read_metadata(md)
    template = Path(args.template or meta.get("template") or DEFAULT_TEMPLATE)
    if not template.is_absolute() and not template.is_file():
        template = md.parent / template
    if not template.is_file():
        print(f"Error: template {template} does not exist", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory(prefix="build_docx_") as tmp:
        reference = Path(tmp) / "reference.docx"
        info = prepare_reference(template, meta, reference)
        raw = Path(tmp) / "pandoc.docx"
        warnings = run_pandoc(md, reference, raw, str(meta.get("abstract-title") or "摘要"))
        stats = postprocess(raw, out, meta, info)

    report = {"out": str(out), "template": str(template), "pandoc_warnings": warnings, **stats}

    if not args.no_render:
        preview = Path(args.preview_dir) if args.preview_dir else md.resolve().parent / "_preview"
        if "deliverables" in preview.resolve().parts:
            preview = Path.cwd() / "_preview"
        report["render"] = render(
            out, preview, not args.no_pages, args.dpi, str(meta.get("toc-title") or "目录")
        )

    report["checks"] = run_checks(out)
    report["ok"] = all(check["ok"] for check in report["checks"].values()) and (
        report.get("render", {}).get("math", {}).get("status") != "missing"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
