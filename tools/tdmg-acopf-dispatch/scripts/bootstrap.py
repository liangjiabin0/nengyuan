#!/usr/bin/env python3
"""Install the pinned numerical backend into this skill's private vendor folder."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


TARGET = Path(__file__).resolve().parent / "_vendor"
PACKAGES = ("numpy==1.26.4", "scipy==1.14.1", "pypower==5.1.19")


def main() -> int:
    TARGET.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-compile",
        "--upgrade",
        "--target",
        str(TARGET),
        *PACKAGES,
    ]
    print("Installing pinned AC-OPF dependencies into", TARGET)
    return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())
