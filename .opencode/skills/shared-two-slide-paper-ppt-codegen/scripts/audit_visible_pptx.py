import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


FORBIDDEN = (
    r"图、?公式和流程按.*组合",
    r"论文图与表格数据共同支撑",
    r"论文结果",
    r"公式来源",
    r"来源[：:]",
    r"未运行作者代码",
    r"根据论文",
    r"此处放置",
    r"用于补充版面",
)
NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}


def slide_number(name: str) -> int:
    match = re.search(r"slide(\d+)\.xml$", name)
    return int(match.group(1)) if match else 0


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: audit_visible_pptx.py <deck.pptx>")
    deck = Path(sys.argv[1])
    if not deck.is_file():
        raise SystemExit(f"ERROR: deck not found: {deck}")
    findings = []
    with zipfile.ZipFile(deck) as archive:
        slide_names = sorted(
            (name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
            key=slide_number,
        )
        for name in slide_names:
            root = ET.fromstring(archive.read(name))
            text = "".join(node.text or "" for node in root.findall(".//a:t", NS))
            for pattern in FORBIDDEN:
                match = re.search(pattern, text, flags=re.IGNORECASE)
                if match:
                    findings.append(f"slide {slide_number(name)}: {match.group(0)}")
    if findings:
        raise SystemExit("ERROR: forbidden visible wording\n" + "\n".join(findings))
    print(f"PASS: {len(slide_names)} slides contain no forbidden backstage/source wording")


if __name__ == "__main__":
    main()
