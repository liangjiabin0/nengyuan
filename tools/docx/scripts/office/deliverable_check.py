"""
AI4ES delivery gate for a generated .docx / .xlsx / .pptx.

    python deliverable_check.py deliverables/报告.docx
    python deliverable_check.py deliverables/报告.docx --json

preflight.py answers "will Word open it". This answers "is it fit to hand to a
human", and it fails on three things the reader should never see:

1. **Internal system references.** Corpus paths, `*.md:120-180` line citations,
   `[E1]` / `[L2]` chips, session workspace paths, absolute drive paths, repo
   directories and agent/tool names. Those citation forms exist so the chat UI
   can linkify evidence; inside a delivered document they are unresolvable
   noise. A deliverable cites by author-year, DOI or URL instead.
2. **Markdown or LaTeX source.** `**bold**`, `|---|`, backtick fences, `$...$`,
   `\\frac` — anything that was supposed to become Word formatting or a native
   formula and got written as literal text.
3. **Fake formulas.** An `m:oMath` holding one run of ASCII like
   `x^(k+1) = arg min_x sum_i w_i` is not a formula: Word shows it as italic
   text, and every text-based PDF path drops it entirely, which is why formulas
   "disappear" on conversion. Build real OMML (`m:sSup`, `m:f`, `m:nary`, …) —
   `scripts/latex_to_omml.ts` does it from LaTeX.
4. **Unreadable cached TOC fields.** Headless renderers do not reliably refresh
   Word fields. A generated TOC therefore needs useful cached display text, not
   an empty result or an "update field" placeholder.

Exit 0 when clean, 1 on violations, 2 on usage errors.
"""

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
X_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math"

TEXT_TAGS = {f"{{{ns}}}t" for ns in (W_NS, A_NS, X_NS)}
MATH_TEXT = f"{{{M_NS}}}t"
MATH_RUN = f"{{{M_NS}}}r"
OMATH = f"{{{M_NS}}}oMath"
W_FLD_CHAR = f"{{{W_NS}}}fldChar"
W_INSTR_TEXT = f"{{{W_NS}}}instrText"
W_TEXT = f"{{{W_NS}}}t"

# Structural OMML elements. A formula with none of these is plain text.
MATH_STRUCTURE = {
    f"{{{M_NS}}}{name}"
    for name in ("sSup", "sSub", "sSubSup", "f", "nary", "rad", "d", "m", "func", "limLow", "limUpp", "acc", "bar", "groupChr", "eqArr")
}

INTERNAL_PATTERNS: tuple[tuple[str, str, str], ...] = (
    ("corpus-path", r"knowledge-corpus[/\\]", "语料内部路径"),
    # Chinese copy uses the full-width colon far more often than the ASCII one.
    ("line-citation", r"\.(?:md|txt|csv|json)\s*[:：︓#]\s*\d+(?:\s*[-–—～~]\s*\d+)?", "文件行号引用"),
    ("evidence-chip", r"\[\s*[ELel]\s?\d{1,3}\s*\]", "E1/L1 证据标记"),
    ("workspace-path", r"chat-workspaces[/\\]|storage[/\\]chat-workspaces", "会话工作区路径"),
    ("drive-path", r"[A-Za-z]:\\[\w\u4e00-\u9fff]", "本机绝对路径"),
    ("posix-path", r"(?:/home/|/root/|/data/ai4es)", "服务器绝对路径"),
    ("repo-dir", r"(?<![\w./\\-])(?:repro|deliverables|tools|storage|node_modules)[/\\][\w./\\-]+", "仓库内部目录"),
    ("runtime-name", r"AI4ES_PROJECT_ROOT|office-docs-venv|knowledge-qa|opencode", "运行时/代理内部名称"),
)

MARKDOWN_PATTERNS: tuple[tuple[str, str, str], ...] = (
    ("md-bold", r"\*\*[^*\n]{1,80}\*\*", "Markdown 粗体"),
    ("md-heading", r"(?:^|\n)\s{0,3}#{1,6}\s+\S", "Markdown 标题"),
    ("md-table", r"\|\s*-{3,}", "Markdown 表格分隔线"),
    ("md-code", r"```|(?<!`)`[^`\n]{1,60}`(?!`)", "Markdown 代码标记"),
    ("latex-display", r"\$\$", "LaTeX 独立公式标记"),
    ("latex-inline", r"\$[^$\n]*[\\^_{}][^$\n]*\$", "LaTeX 行内公式"),
    ("latex-macro", r"\\(?:frac|sum|int|sqrt|begin|end|left|right|mathbf|text)\b", "LaTeX 宏"),
)

# ASCII stand-ins for real math structure.
ASCII_MATH = re.compile(r"\^|_|<=|>=|~|\bsqrt\b|\barg\s*min\b|\barg\s*max\b|\bsum_\b|\*\*")


def _parts(target: Path) -> dict[str, bytes]:
    if target.is_dir():
        return {
            path.relative_to(target).as_posix(): path.read_bytes()
            for path in sorted(p for p in target.rglob("*") if p.is_file())
        }
    with zipfile.ZipFile(target) as zf:
        return {
            info.filename: zf.read(info.filename)
            for info in zf.infolist()
            if not info.is_dir() and info.filename.endswith(".xml")
        }


CONTENT_ROOTS = ("word/", "ppt/", "xl/")


def _visible_text(parts: dict[str, bytes]) -> tuple[list[tuple[str, str]], list[str]]:
    """(part name, text) for every visible string, math excluded, plus unreadable parts."""
    found: list[tuple[str, str]] = []
    unreadable: list[str] = []
    for name, data in parts.items():
        if name.startswith("docProps/") or name.endswith(".rels"):
            continue
        try:
            root = ET.fromstring(data)
        except ET.ParseError as exc:
            if name.startswith(CONTENT_ROOTS):
                unreadable.append(f"{name}: {exc}")
            continue
        for element in root.iter():
            if element.tag in TEXT_TAGS and (element.text or "").strip():
                found.append((name, element.text))
    return found, unreadable


def _spreadsheet_formulas(parts: dict[str, bytes]) -> int:
    total = 0
    for name, data in parts.items():
        if not (name.startswith("xl/worksheets/") and name.endswith(".xml")):
            continue
        try:
            root = ET.fromstring(data)
        except ET.ParseError:
            continue
        total += sum(1 for _ in root.iter(f"{{{X_NS}}}f"))
    return total


def _formulas(parts: dict[str, bytes]) -> list[dict]:
    formulas = []
    for name, data in parts.items():
        if name.endswith(".rels"):
            continue
        try:
            root = ET.fromstring(data)
        except ET.ParseError:
            continue
        for index, omath in enumerate(root.iter(OMATH)):
            children = list(omath.iter())
            text = "".join(node.text or "" for node in omath.iter(MATH_TEXT))
            formulas.append(
                {
                    "part": name,
                    "index": index,
                    "text": text,
                    "runs": sum(1 for node in children if node.tag == MATH_RUN),
                    "structured": any(node.tag in MATH_STRUCTURE for node in children),
                }
            )
    return formulas


def _toc_fields(parts: dict[str, bytes]) -> list[str]:
    """Return cached visible text for each complex TOC field in document.xml."""
    data = parts.get("word/document.xml")
    if not data:
        return []
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return []

    fields: list[str] = []
    active = False
    is_toc = False
    separated = False
    cached: list[str] = []
    fld_type = f"{{{W_NS}}}fldCharType"
    for element in root.iter():
        if element.tag == W_FLD_CHAR:
            kind = element.get(fld_type) or element.get("fldCharType")
            if kind == "begin":
                active, is_toc, separated, cached = True, False, False, []
            elif kind == "separate" and active and is_toc:
                separated = True
            elif kind == "end" and active:
                if is_toc:
                    fields.append("".join(cached).strip())
                active, is_toc, separated, cached = False, False, False, []
        elif active and element.tag == W_INSTR_TEXT and "TOC" in (element.text or "").upper():
            is_toc = True
        elif active and is_toc and separated and element.tag == W_TEXT:
            cached.append(element.text or "")
    return fields


def check(target: Path) -> dict:
    parts = _parts(target)
    errors: list[dict] = []
    warnings: list[dict] = []

    texts, unreadable = _visible_text(parts)
    joined = "\n".join(text for _, text in texts)

    if unreadable:
        # A part that will not parse cannot be scanned, so passing the document
        # here would mean "clean" on a file the application cannot even open.
        errors.append(
            {
                "group": "structure",
                "code": "unparsable-part",
                "label": "主内容部件 XML 无法解析，内容无从检查；先用 preflight.py 修结构",
                "count": len(unreadable),
                "samples": [{"part": item.split(":")[0], "excerpt": item[:120]} for item in unreadable[:3]],
            }
        )

    for group, patterns in (("internal", INTERNAL_PATTERNS), ("markdown", MARKDOWN_PATTERNS)):
        for code, pattern, label in patterns:
            regex = re.compile(pattern)
            hits = []
            for part, text in texts:
                for match in regex.finditer(text):
                    hits.append({"part": part, "excerpt": text[max(0, match.start() - 20) : match.end() + 20].strip()})
                    if len(hits) >= 5:
                        break
                if len(hits) >= 5:
                    break
            if hits:
                errors.append({"group": group, "code": code, "label": label, "count": len(hits), "samples": hits[:3]})

    formulas = _formulas(parts)
    fake = [f for f in formulas if not f["structured"] and ASCII_MATH.search(f["text"] or "")]
    if fake:
        errors.append(
            {
                "group": "formula",
                "code": "ascii-math",
                "label": "OMML 里是 ASCII 伪公式，没有 m:sSup/m:f/m:nary 结构；Word 只当斜体文本，转 PDF 会整条丢失",
                "count": len(fake),
                "samples": [{"part": f["part"], "excerpt": (f["text"] or "")[:80]} for f in fake[:3]],
            }
        )
    empty = [f for f in formulas if not (f["text"] or "").strip() and not f["structured"]]
    if empty:
        warnings.append({"group": "formula", "code": "empty-math", "label": "存在空的 m:oMath", "count": len(empty)})

    math_text_in_body = re.compile(r"[A-Za-z]\w*\^|[A-Za-z]\w*_\{|\bR\^\(-1\)")
    body_math = [part for part, text in texts if math_text_in_body.search(text)]
    if body_math:
        warnings.append(
            {
                "group": "formula",
                "code": "math-in-body",
                "label": "正文普通文本里出现上下标写法，应改为 OMML 公式",
                "count": len(body_math),
            }
        )

    toc_fields = _toc_fields(parts)
    toc_placeholder = re.compile(
        r"(?:更新|刷新).{0,8}字段|update\s+(?:the\s+)?field|"
        r"no\s+table\s+of\s+contents\s+entries\s+found|right[- ]click",
        re.IGNORECASE,
    )
    bad_toc = [cache for cache in toc_fields if not cache or toc_placeholder.search(cache)]
    if bad_toc:
        errors.append(
            {
                "group": "field",
                "code": "toc-cache",
                "label": "目录字段没有可读的缓存目录；无界面渲染时会显示空白或更新字段提示",
                "count": len(bad_toc),
                "samples": [
                    {"part": "word/document.xml", "excerpt": cache[:100] or "<empty>"}
                    for cache in bad_toc[:3]
                ],
            }
        )

    return {
        "ok": not errors,
        "target": str(target),
        "stats": {
            "parts": len(parts),
            "text_nodes": len(texts),
            "characters": len(joined),
            "formulas": len(formulas),
            "structured_formulas": sum(1 for f in formulas if f["structured"]),
            "spreadsheet_formulas": _spreadsheet_formulas(parts),
            "toc_fields": len(toc_fields),
        },
        "errors": errors,
        "warnings": warnings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="AI4ES delivery gate for an Office deliverable")
    parser.add_argument("target", help=".docx/.xlsx/.pptx or an unpacked directory")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    target = Path(args.target)
    if not target.exists():
        print(f"Error: {target} does not exist", file=sys.stderr)
        return 2

    report = check(target)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(f"{'OK' if report['ok'] else 'REJECTED'}  {target}")
        for item in report["errors"]:
            print(f"  error [{item['code']}] {item['label']} ×{item['count']}")
            for sample in item["samples"]:
                print(f"           {sample['part']}: {sample['excerpt']}")
        for item in report["warnings"]:
            print(f"  warn  [{item['code']}] {item['label']} ×{item['count']}")
        print(f"  stats: {json.dumps(report['stats'], ensure_ascii=False)}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
