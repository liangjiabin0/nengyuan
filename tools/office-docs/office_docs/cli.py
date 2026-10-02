from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .csv_render import render_csv
from .docx_render import render_docx
from .fonts import preset_font_names, reportlab_family, resolve_font_files
from .inspect import dumps, inspect_csv, inspect_docx, inspect_pdf, inspect_pptx, inspect_xlsx
from .pdf_render import render_pdf
from .pptx_render import render_pptx
from .spec import load_csv_spec, load_deck_spec, load_document_spec, load_markdown_spec, load_workbook_spec
from .xlsx_render import render_xlsx


def _load_doc(args: argparse.Namespace):
    if args.markdown:
        return load_markdown_spec(args.markdown)
    if args.spec:
        return load_document_spec(args.spec)
    if args.spec_json:
        return load_document_spec(raw=args.spec_json)
    raise SystemExit("需要 --spec 或 --markdown")


def _require_out(args: argparse.Namespace):
    if not args.out:
        raise SystemExit("需要 --out")
    return Path(args.out)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="office_docs",
        description="兼容用排版引擎。对话交付请用官方 docx/xlsx/pdf/pptx 技能，不要再调用 render-*。",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_doc_args(p):
        p.add_argument("--spec", help="JSON 规格文件")
        p.add_argument("--markdown", help="Markdown 源文件，由引擎按预设排版")
        p.add_argument("--spec-json", dest="spec_json", help="内联 JSON 规格")
        p.add_argument("--out", required=True, help="输出文件")

    add_doc_args(sub.add_parser("render-docx", help="生成 Word"))
    add_doc_args(sub.add_parser("render-pdf", help="生成 PDF"))

    x = sub.add_parser("render-xlsx", help="生成 Excel")
    x.add_argument("--spec", help="JSON 规格文件")
    x.add_argument("--spec-json", dest="spec_json")
    x.add_argument("--out", required=True)

    c = sub.add_parser("render-csv", help="生成 CSV")
    c.add_argument("--spec", help="JSON 规格文件")
    c.add_argument("--spec-json", dest="spec_json")
    c.add_argument("--out", required=True)

    ptx = sub.add_parser("render-pptx", help="生成 PPTX")
    ptx.add_argument("--spec", help="JSON 规格文件")
    ptx.add_argument("--spec-json", dest="spec_json")
    ptx.add_argument("--out", required=True)

    for name in ("inspect-docx", "inspect-xlsx", "inspect-csv", "inspect-pptx"):
        p = sub.add_parser(name)
        p.add_argument("path")
    p = sub.add_parser("inspect-pdf")
    p.add_argument("path")
    p.add_argument("--render-dir", dest="render_dir")

    sub.add_parser("fonts", help="列出本机可用中英文字体")
    sub.add_parser("presets", help="列出预设")
    return parser


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)
    command = args.command
    try:
        if command == "render-docx":
            path = render_docx(_load_doc(args), _require_out(args))
            print(json.dumps({"ok": True, "out": str(path)}, ensure_ascii=False))
            return 0
        if command == "render-pdf":
            path = render_pdf(_load_doc(args), _require_out(args))
            print(json.dumps({"ok": True, "out": str(path)}, ensure_ascii=False))
            return 0
        if command == "render-xlsx":
            data = load_workbook_spec(args.spec, args.spec_json)
            path = render_xlsx(data, _require_out(args))
            print(json.dumps({"ok": True, "out": str(path)}, ensure_ascii=False))
            return 0
        if command == "render-csv":
            data = load_csv_spec(args.spec, args.spec_json)
            path = render_csv(data, _require_out(args))
            print(json.dumps({"ok": True, "out": str(path)}, ensure_ascii=False))
            return 0
        if command == "render-pptx":
            if not args.spec and not args.spec_json:
                raise SystemExit("需要 --spec 或 --spec-json")
            data = load_deck_spec(args.spec, args.spec_json)
            path = render_pptx(data, _require_out(args))
            print(json.dumps({"ok": True, "out": str(path)}, ensure_ascii=False))
            return 0
        if command == "inspect-docx":
            print(dumps(inspect_docx(args.path)))
            return 0
        if command == "inspect-xlsx":
            print(dumps(inspect_xlsx(args.path)))
            return 0
        if command == "inspect-csv":
            print(dumps(inspect_csv(args.path)))
            return 0
        if command == "inspect-pptx":
            print(dumps(inspect_pptx(args.path)))
            return 0
        if command == "inspect-pdf":
            print(dumps(inspect_pdf(args.path, args.render_dir)))
            return 0
        if command == "fonts":
            files = {key: str(value) for key, value in resolve_font_files().items()}
            print(json.dumps({
                "files": files,
                "docx_cn_report": preset_font_names("cn-report"),
                "reportlab": reportlab_family("cn-report"),
            }, ensure_ascii=False, indent=2))
            return 0
        if command == "presets":
            print(json.dumps({
                "document": ["cn-report", "cn-business", "en-report", "memo"],
                "workbook": ["cn-workbook", "data-export"],
                "pptx": ["cn-report", "cn-business", "en-report", "memo"],
                "csv_encoding": ["utf-8-sig", "utf-8", "gbk"],
            }, ensure_ascii=False, indent=2))
            return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 1
