from __future__ import annotations

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm, mm
from reportlab.platypus import (
    Image,
    KeepTogether,
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from .fonts import pdf_body_font, pdf_heading_font, reportlab_family
from .text import escape_xml, split_cjk_ascii


def mixed_xml(text: str, *, body: str, ascii_font: str) -> str:
    parts = []
    for chunk, is_cjk in split_cjk_ascii(str(text or "")):
        font = body if is_cjk else ascii_font
        parts.append(f'<font name="{font}">{escape_xml(chunk)}</font>')
    return "".join(parts) or escape_xml(text or "")


def build_styles(preset: str) -> dict[str, ParagraphStyle]:
    reportlab_family(preset)
    body = pdf_body_font(preset)
    heading = pdf_heading_font(preset)
    ascii_font = reportlab_family(preset).get("times") or "Times-Roman"
    base = getSampleStyleSheet()
    styles = {
        "ascii": ascii_font,
        "body_font": body,
        "title": ParagraphStyle(
            "OfficeTitle",
            parent=base["Title"],
            fontName=heading,
            fontSize=18,
            leading=26,
            alignment=TA_CENTER,
            textColor=colors.black,
            spaceAfter=12,
        ),
        "subtitle": ParagraphStyle(
            "OfficeSubtitle",
            parent=base["Normal"],
            fontName=body,
            fontSize=12,
            leading=18,
            alignment=TA_CENTER,
            textColor=colors.black,
            spaceAfter=8,
        ),
        "meta": ParagraphStyle(
            "OfficeMeta",
            parent=base["Normal"],
            fontName=body,
            fontSize=10.5,
            leading=16,
            alignment=TA_CENTER,
            textColor=colors.black,
            spaceAfter=16,
        ),
        "h1": ParagraphStyle(
            "OfficeH1",
            parent=base["Heading1"],
            fontName=heading,
            fontSize=16,
            leading=22,
            textColor=colors.black,
            spaceBefore=12,
            spaceAfter=8,
            alignment=TA_LEFT,
        ),
        "h2": ParagraphStyle(
            "OfficeH2",
            parent=base["Heading2"],
            fontName=heading,
            fontSize=14,
            leading=20,
            textColor=colors.black,
            spaceBefore=8,
            spaceAfter=6,
        ),
        "h3": ParagraphStyle(
            "OfficeH3",
            parent=base["Heading3"],
            fontName=heading,
            fontSize=12,
            leading=18,
            textColor=colors.black,
            spaceBefore=6,
            spaceAfter=4,
        ),
        "body": ParagraphStyle(
            "OfficeBody",
            parent=base["Normal"],
            fontName=body,
            fontSize=12,
            leading=22,
            alignment=TA_JUSTIFY,
            firstLineIndent=24,
            textColor=colors.black,
            wordWrap="CJK",
        ),
        "center": ParagraphStyle(
            "OfficeCenter",
            parent=base["Normal"],
            fontName=body,
            fontSize=10.5,
            leading=16,
            alignment=TA_CENTER,
            firstLineIndent=0,
            textColor=colors.black,
            wordWrap="CJK",
        ),
        "caption": ParagraphStyle(
            "OfficeCaption",
            parent=base["Normal"],
            fontName=body,
            fontSize=10.5,
            leading=16,
            alignment=TA_CENTER,
            firstLineIndent=0,
            textColor=colors.black,
            spaceBefore=4,
            spaceAfter=8,
        ),
        "toc": ParagraphStyle(
            "OfficeToc",
            parent=base["Normal"],
            fontName=body,
            fontSize=12,
            leading=20,
            firstLineIndent=0,
            textColor=colors.black,
        ),
        "ref": ParagraphStyle(
            "OfficeRef",
            parent=base["Normal"],
            fontName=body,
            fontSize=10.5,
            leading=18,
            leftIndent=24,
            firstLineIndent=-24,
            textColor=colors.black,
            wordWrap="CJK",
        ),
        "code": ParagraphStyle(
            "OfficeCode",
            parent=base["Code"],
            fontName="Courier",
            fontSize=9,
            leading=12,
            leftIndent=12,
        ),
    }
    return styles


def header_footer(canvas, doc, spec: dict, styles: dict):
    canvas.saveState()
    body = styles["body_font"]
    canvas.setFillColor(colors.black)
    canvas.setFont(body, 9)
    header = spec.get("header") or spec.get("title") or ""
    if spec.get("confidential"):
        header = f"{header}  内部资料".strip()
    if header:
        canvas.drawCentredString(A4[0] / 2, A4[1] - 14 * mm, header)
        canvas.setStrokeColor(colors.black)
        canvas.setLineWidth(0.4)
        canvas.line(2.5 * cm, A4[1] - 16 * mm, A4[0] - 2.5 * cm, A4[1] - 16 * mm)
    footer = spec.get("footer") or ""
    page = f"{doc.page}"
    text = f"{footer}  {page}".strip() if footer else page
    canvas.drawCentredString(A4[0] / 2, 12 * mm, text)
    canvas.restoreState()


def para(text: str, style: ParagraphStyle, styles: dict) -> Paragraph:
    xml = mixed_xml(text, body=styles["body_font"], ascii_font=styles["ascii"])
    return Paragraph(xml, style)


def table_flowable(block: dict, styles: dict) -> list:
    headers = [str(item) for item in (block.get("headers") or [])]
    rows = block.get("rows") or []
    data = []
    if headers:
        data.append([para(h, styles["center"], styles) for h in headers])
    for row in rows:
        data.append([para(str(cell), styles["center"], styles) for cell in row])
    if not data:
        return []
    col_count = max(len(row) for row in data)
    for row in data:
        while len(row) < col_count:
            row.append(para("", styles["center"], styles))
    usable = A4[0] - 5.5 * cm
    col_width = usable / col_count
    tbl = Table(data, colWidths=[col_width] * col_count, repeatRows=1 if headers else 0)
    cmds = [
        ("FONTNAME", (0, 0), (-1, -1), styles["body_font"]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LINEABOVE", (0, 0), (-1, 0), 1.25, colors.black),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.black),
        ("LINEBELOW", (0, -1), (-1, -1), 1.25, colors.black),
        ("BACKGROUND", (0, 0), (-1, 0), colors.Color(0.96, 0.96, 0.96)),
    ]
    tbl.setStyle(TableStyle(cmds))
    flow = []
    if block.get("title"):
        flow.append(para(block["title"], styles["caption"], styles))
    flow.append(tbl)
    flow.append(Spacer(1, 8))
    return [KeepTogether(flow)]


def render_blocks(blocks: list[dict], styles: dict) -> list:
    story = []
    for block in blocks:
        kind = block.get("type")
        if kind == "paragraph":
            story.append(para(block.get("text") or "", styles["body"], styles))
            story.append(Spacer(1, 4))
        elif kind == "list":
            items = []
            for item in block.get("items") or []:
                items.append(ListItem(para(str(item), styles["body"], styles), leftIndent=18))
            story.append(ListFlowable(items, bulletType="1" if block.get("ordered") else "bullet", start="1"))
        elif kind == "table":
            story.extend(table_flowable(block, styles))
        elif kind == "figure":
            path = block.get("path") or ""
            if path and Path(path).exists():
                width = float(block.get("width_cm") or 14) * cm
                try:
                    from PIL import Image as PILImage
                    with PILImage.open(path) as opened:
                        px_w, px_h = opened.size
                    height = width * (px_h / max(px_w, 1))
                except Exception:
                    height = width * 0.62
                img = Image(path, width=width, height=height)
                img.hAlign = "CENTER"
                pack = [img]
                if block.get("caption"):
                    pack.append(para(block["caption"], styles["caption"], styles))
                story.append(KeepTogether(pack))
            else:
                story.append(para(f"（缺图：{path or '未提供路径'}）", styles["center"], styles))
        elif kind == "equation":
            latex = block.get("latex") or ""
            number = block.get("number") or ""
            text = f"{latex}    （{number}）" if number else latex
            story.append(para(text, styles["center"], styles))
        elif kind == "quote":
            story.append(para(block.get("text") or "", styles["caption"], styles))
        elif kind == "pagebreak":
            story.append(PageBreak())
        elif kind == "code":
            story.append(Preformatted(block.get("text") or "", styles["code"]))
    return story


def render_pdf(spec: dict, output: str | Path) -> Path:
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    styles = build_styles(spec.get("preset") or "cn-report")
    doc = SimpleDocTemplate(
        str(output),
        pagesize=A4,
        leftMargin=3.0 * cm,
        rightMargin=2.5 * cm,
        topMargin=2.6 * cm,
        bottomMargin=2.4 * cm,
        title=spec.get("title") or "",
        author=spec.get("author") or "能元",
    )
    story = []
    if spec.get("title"):
        story.append(para(spec["title"], styles["title"], styles))
    if spec.get("subtitle"):
        story.append(para(spec["subtitle"], styles["subtitle"], styles))
    meta = "  ".join(item for item in [spec.get("org"), spec.get("author"), spec.get("date")] if item)
    if meta:
        story.append(para(meta, styles["meta"], styles))
    if spec.get("toc"):
        story.append(para("目录", styles["h1"], styles))
        for section in spec.get("sections") or []:
            if section.get("heading"):
                indent = "&nbsp;" * (4 * max(int(section.get("level") or 1) - 1, 0))
                story.append(Paragraph(
                    indent + mixed_xml(section["heading"], body=styles["body_font"], ascii_font=styles["ascii"]),
                    styles["toc"],
                ))
        story.append(PageBreak())
    heading_styles = {1: styles["h1"], 2: styles["h2"], 3: styles["h3"]}
    for section in spec.get("sections") or []:
        if section.get("heading"):
            story.append(para(section["heading"], heading_styles.get(int(section.get("level") or 1), styles["h1"]), styles))
        story.extend(render_blocks(section.get("blocks") or [], styles))
    if spec.get("references"):
        story.append(para("参考文献", styles["h1"], styles))
        for index, item in enumerate(spec["references"], start=1):
            story.append(para(f"[{index}] {item}", styles["ref"], styles))
    doc.build(
        story,
        onFirstPage=lambda c, d: header_footer(c, d, spec, styles),
        onLaterPages=lambda c, d: header_footer(c, d, spec, styles),
    )
    return output
