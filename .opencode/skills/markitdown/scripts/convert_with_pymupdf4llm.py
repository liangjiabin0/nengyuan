"""PDF fallback using pymupdf4llm (https://github.com/pymupdf/pymupdf4llm)."""
from __future__ import annotations

import argparse
from pathlib import Path

import pymupdf4llm


def main() -> None:
    parser = argparse.ArgumentParser(description='Convert a PDF to Markdown with pymupdf4llm')
    parser.add_argument('input')
    parser.add_argument('-o', '--output', required=True)
    args = parser.parse_args()
    text = pymupdf4llm.to_markdown(args.input) or ''
    Path(args.output).write_text(text, encoding='utf-8')


if __name__ == '__main__':
    main()
