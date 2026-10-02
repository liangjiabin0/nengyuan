#!/usr/bin/env python3
"""Create or refresh tools/office-docs-venv, the Python the office skills run in.

    python tools/office-docs/run.py --ensure    # prints the venv interpreter

The venv holds the libraries behind the docx / xlsx / pptx / pdf skills
(python-docx, pandoc via pypandoc_binary, openpyxl, pypdf, ...). Dependencies
are reinstalled whenever requirements.txt is newer than the last install.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent
TOOLS_DIR = PKG_DIR.parent
VENV_DIR = TOOLS_DIR / "office-docs-venv"
REQ = PKG_DIR / "requirements.txt"
TUN = "https://pypi.tuna.tsinghua.edu.cn/simple"
MARKER = VENV_DIR / ".deps-ok"


def venv_python() -> Path:
    if os.name == "nt":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def ensure_venv() -> Path:
    python = venv_python()
    if python.exists() and MARKER.exists() and REQ.exists():
        if MARKER.stat().st_mtime >= REQ.stat().st_mtime:
            return python
    if not python.exists():
        print(f"[office-docs] creating venv {VENV_DIR}", file=sys.stderr)
        subprocess.check_call([sys.executable, "-m", "venv", str(VENV_DIR)])
    install = [str(python), "-m", "pip", "install", "-i", TUN, "-r", str(REQ)]
    try:
        subprocess.check_call(install)
    except subprocess.CalledProcessError:
        subprocess.check_call([str(python), "-m", "pip", "install", "-r", str(REQ)])
    MARKER.write_text("ok\n", encoding="utf-8")
    return python


def main() -> int:
    print(ensure_venv())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
