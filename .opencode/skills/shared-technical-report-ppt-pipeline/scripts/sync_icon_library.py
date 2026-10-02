#!/usr/bin/env python3
"""Download and verify the pinned allowlisted SVG icon library."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
import urllib.request
from pathlib import Path
from xml.etree import ElementTree as ET


SKILL_DIR = Path(__file__).resolve().parents[1]
DEFAULT_ROOT = SKILL_DIR / "assets" / "electrical-icons"
SVG_NS = "http://www.w3.org/2000/svg"


def download(url: str, attempts: int = 4) -> bytes:
    error: Exception | None = None
    for attempt in range(attempts):
        request = urllib.request.Request(url, headers={"User-Agent": "Codex-PPT-icon-sync/1"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status}: {url}")
                return response.read()
        except Exception as exc:  # network transport errors differ by platform
            error = exc
            if attempt + 1 < attempts:
                time.sleep(2**attempt)
    raise RuntimeError(f"download failed after {attempts} attempts: {url}") from error


def validate_svg(name: str, data: bytes, expected_view_box: str) -> None:
    if len(data) > 100_000:
        raise ValueError(f"{name}: SVG is unexpectedly large")
    text = data.decode("utf-8")
    if re.search(r"<(script|image|foreignObject)\b", text, re.I):
        raise ValueError(f"{name}: embedded script, raster image, or foreignObject is forbidden")
    root = ET.fromstring(data)
    if root.tag not in {"svg", f"{{{SVG_NS}}}svg"}:
        raise ValueError(f"{name}: root element is not svg")
    if root.attrib.get("viewBox") != expected_view_box:
        raise ValueError(f"{name}: unexpected viewBox {root.attrib.get('viewBox')!r}")
    if "currentColor" not in text:
        raise ValueError(f"{name}: SVG is not color-token based")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()

    root = args.root.resolve()
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    version = manifest["version"]
    expected_view_box = manifest["style"]["viewBox"]
    base = f"https://raw.githubusercontent.com/tabler/tabler-icons/v{version}"
    svg_dir = root / "svg"
    svg_dir.mkdir(parents=True, exist_ok=True)

    lock = {
        "schemaVersion": "electrical-icon-lock.v1",
        "library": manifest["library"],
        "version": version,
        "sourceCommitPolicy": f"tag v{version}",
        "icons": {},
    }
    for name in manifest["allowedIcons"]:
        target = svg_dir / f"{name}.svg"
        url = f"{base}/icons/outline/{name}.svg"
        if args.refresh or not target.is_file():
            data = download(url)
            validate_svg(name, data, expected_view_box)
            target.write_bytes(data)
        else:
            data = target.read_bytes()
            validate_svg(name, data, expected_view_box)
        lock["icons"][name] = {
            "file": f"svg/{name}.svg",
            "source": url,
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
        }

    license_data = download(f"{base}/LICENSE")
    (root / "LICENSE.txt").write_bytes(license_data)
    lock["licenseSha256"] = hashlib.sha256(license_data).hexdigest()
    (root / "lock.json").write_text(
        json.dumps(lock, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"synced {len(lock['icons'])} icons to {svg_dir}")


if __name__ == "__main__":
    main()
