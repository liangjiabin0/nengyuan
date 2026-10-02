from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

WINDOWS_FONTS = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"

CANDIDATES = {
    "simsun": ["simsun.ttc", "SimSun.ttc", "NSimSun.ttf", "simsun.ttf"],
    "simhei": ["simhei.ttf", "SimHei.ttf"],
    "yahei": ["msyh.ttc", "msyh.ttf", "Microsoft YaHei.ttf"],
    "yahei_bold": ["msyhbd.ttc", "msyhbd.ttf"],
    "kaiti": ["simkai.ttf", "KaiTi.ttf"],
    "times": ["times.ttf", "Times New Roman.ttf", "TimesNewRoman.ttf"],
    "times_bold": ["timesbd.ttf", "Times New Roman Bold.ttf"],
    "arial": ["arial.ttf", "Arial.ttf"],
}

LINUX_DIRS = [
    Path("/usr/share/fonts"),
    Path("/usr/local/share/fonts"),
    Path.home() / ".fonts",
    Path("/usr/share/fonts/opentype/noto"),
    Path("/usr/share/fonts/truetype/liberation"),
]


def _search(names: list[str]) -> Path | None:
    roots = [WINDOWS_FONTS, *LINUX_DIRS]
    for root in roots:
        if not root.exists():
            continue
        for name in names:
            direct = root / name
            if direct.exists():
                return direct
        try:
            for path in root.rglob("*"):
                if path.name.lower() in {item.lower() for item in names}:
                    return path
        except OSError:
            continue
    return None


@lru_cache(maxsize=1)
def resolve_font_files() -> dict[str, Path]:
    found: dict[str, Path] = {}
    for key, names in CANDIDATES.items():
        path = _search(names)
        if path:
            found[key] = path
    return found


def preset_font_names(preset: str) -> dict[str, str]:
    """Logical font names used by python-docx (must exist on the viewing PC)."""
    if preset == "cn-business":
        return {
            "east": "微软雅黑",
            "east_heading": "微软雅黑",
            "ascii": "Calibri",
            "title": "微软雅黑",
        }
    if preset == "en-report":
        return {
            "east": "宋体",
            "east_heading": "Arial",
            "ascii": "Times New Roman",
            "title": "Times New Roman",
        }
    if preset == "memo":
        return {
            "east": "宋体",
            "east_heading": "黑体",
            "ascii": "Times New Roman",
            "title": "黑体",
        }
    return {
        "east": "宋体",
        "east_heading": "黑体",
        "ascii": "Times New Roman",
        "title": "黑体",
    }


_RL_REGISTERED = False
_RL_FAMILY: dict[str, str] = {}


def reportlab_family(preset: str = "cn-report") -> dict[str, str]:
    """Register TTF/TTC fonts for ReportLab and return family mapping."""
    global _RL_REGISTERED, _RL_FAMILY
    if _RL_REGISTERED:
        return dict(_RL_FAMILY)

    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfbase.ttfonts import TTFont

    files = resolve_font_files()
    family: dict[str, str] = {}

    def try_register(logical: str, key: str, subfont: int = 0) -> bool:
        path = files.get(key)
        if not path:
            return False
        try:
            pdfmetrics.registerFont(TTFont(logical, str(path), subfontIndex=subfont))
            family[key] = logical
            return True
        except Exception:
            if path.suffix.lower() == ".ttc":
                try:
                    pdfmetrics.registerFont(TTFont(logical, str(path), subfontIndex=0))
                    family[key] = logical
                    return True
                except Exception:
                    return False
            return False

    if not try_register("OfficeSimSun", "simsun"):
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        family["simsun"] = "STSong-Light"
    else:
        family["simsun"] = "OfficeSimSun"

    if try_register("OfficeSimHei", "simhei"):
        family["simhei"] = "OfficeSimHei"
    else:
        family["simhei"] = family["simsun"]

    if try_register("OfficeYaHei", "yahei"):
        family["yahei"] = "OfficeYaHei"
    else:
        family["yahei"] = family["simhei"]

    if try_register("OfficeTimes", "times"):
        family["times"] = "OfficeTimes"
    else:
        family["times"] = "Times-Roman"

    if try_register("OfficeTimesBold", "times_bold"):
        family["times_bold"] = "OfficeTimesBold"
    else:
        family["times_bold"] = "Times-Bold"

    _RL_REGISTERED = True
    _RL_FAMILY = family
    _ = preset
    return dict(family)


def pdf_body_font(preset: str) -> str:
    family = reportlab_family(preset)
    if preset == "cn-business":
        return family.get("yahei") or family["simsun"]
    if preset == "en-report":
        return family.get("times") or "Times-Roman"
    return family["simsun"]


def pdf_heading_font(preset: str) -> str:
    family = reportlab_family(preset)
    if preset == "cn-business":
        return family.get("yahei") or family["simhei"]
    if preset == "en-report":
        return family.get("times_bold") or "Times-Bold"
    return family.get("simhei") or family["simsun"]
