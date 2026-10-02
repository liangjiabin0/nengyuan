from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from collections.abc import Collection, Sequence
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from ppt_voice_builder.domain.errors import PowerPointError
from ppt_voice_builder.domain.models import AudioArtifact, BuildResult, ValidationResult

TOOL_AUDIO_PREFIX = "PPTVOICE_AUDIO_"


def slide_image_name(slide_index: int) -> str:
    return f"slide-{slide_index:03d}.png"

NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"

REL_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
REL_MEDIA = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/media"
REL_AUDIO = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio"
REL_IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
REL_MS_MEDIA = "http://schemas.microsoft.com/office/2007/relationships/media"

P14_MEDIA_URI = "{DAA4B4D4-6D07-4AB7-A35D-F8BDBD01E9F7}"

_PNG_1X1 = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)

ET.register_namespace("a", NS_A)
ET.register_namespace("r", NS_R)
ET.register_namespace("p", NS_P)
ET.register_namespace("p14", NS_P14)
# Keep package content types readable by LibreOffice on Linux.
ET.register_namespace("", NS_CT)


def _qn(ns: str, tag: str) -> str:
    return f"{{{ns}}}{tag}"


def which_executable(*names: str, extra: Sequence[str] = ()) -> Path | None:
    for name in names:
        found = shutil.which(name)
        if found:
            return Path(found)
    for candidate in extra:
        path = Path(candidate)
        if path.is_file():
            return path
    return None


def which_soffice() -> Path | None:
    extra = (
        "/usr/bin/soffice",
        "/usr/lib/libreoffice/program/soffice",
        "/usr/lib/libreoffice/program/soffice.bin",
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    )
    return which_executable("soffice", "libreoffice", extra=extra)


def which_ffmpeg() -> Path | None:
    return which_executable("ffmpeg")


def which_pdftoppm() -> Path | None:
    return which_executable("pdftoppm")


def powerpoint_com_available() -> bool:
    if sys.platform != "win32":
        return False
    try:
        import winreg

        winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, "PowerPoint.Application")
        return True
    except Exception:
        return False


def runtime_probes() -> dict[str, Any]:
    powerpoint = powerpoint_com_available()
    return {
        "powerpoint": powerpoint,
        "libreoffice": which_soffice() is not None,
        "ffmpeg": which_ffmpeg() is not None,
        "pdftoppm": which_pdftoppm() is not None,
        "embedEngine": "powerpoint" if powerpoint else "ooxml",
    }


def _run(cmd: Sequence[str], *, cwd: Path | None = None, timeout: int = 180) -> None:
    completed = subprocess.run(
        list(cmd),
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise PowerPointError(f"{cmd[0]} 失败：{detail or completed.returncode}")


def _tool_shape_name(slide_index: int) -> str:
    return f"{TOOL_AUDIO_PREFIX}SLIDE_{slide_index:03d}"


def export_slides_with_libreoffice(source_pptx: Path, output_dir: Path, width: int = 1600) -> list[str]:
    soffice = which_soffice()
    pdftoppm = which_pdftoppm()
    if soffice is None:
        raise PowerPointError("未找到 LibreOffice（soffice）")
    if pdftoppm is None:
        raise PowerPointError("未找到 pdftoppm（poppler-utils）")
    source_pptx = source_pptx.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ppt-voice-lo-") as raw_tmp:
        tmp = Path(raw_tmp)
        profile = tmp / "lo-profile"
        profile.mkdir()
        profile_uri = profile.resolve().as_uri()
        _run(
            [
                str(soffice),
                "--headless",
                "--nologo",
                "--nofirststartwizard",
                "--norestore",
                f"-env:UserInstallation={profile_uri}",
                "--convert-to",
                "pdf:impress_pdf_Export",
                "--outdir",
                str(tmp),
                str(source_pptx),
            ],
            timeout=240,
        )
        pdfs = sorted(tmp.glob("*.pdf"))
        if not pdfs:
            raise PowerPointError("LibreOffice 未生成 PDF")
        prefix = tmp / "page"
        _run(
            [str(pdftoppm), "-png", "-r", "144", str(pdfs[0]), str(prefix)],
            timeout=180,
        )
        pages = sorted(tmp.glob("page*.png"), key=lambda item: item.name)
        if not pages:
            raise PowerPointError("pdftoppm 未生成 PNG")
        written: list[str] = []
        for index, page in enumerate(pages, start=1):
            dest = output_dir / slide_image_name(index)
            shutil.copy2(page, dest)
            written.append(str(dest))
        return written


def _parse_xml(path: Path) -> ET.ElementTree:
    return ET.parse(path)


def _write_xml(tree: ET.ElementTree, path: Path) -> None:
    tree.write(path, encoding="UTF-8", xml_declaration=True)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _unzip(source: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source) as archive:
        archive.extractall(dest)


def _zip_dir(source: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(source.rglob("*")):
            if file.is_dir():
                continue
            archive.write(file, file.relative_to(source).as_posix())
    os.replace(tmp, dest)


def _slide_entries(root: Path) -> list[tuple[int, Path, Path]]:
    pres = root / "ppt" / "presentation.xml"
    rels = root / "ppt" / "_rels" / "presentation.xml.rels"
    if not pres.is_file() or not rels.is_file():
        raise PowerPointError("PPTX 缺少 presentation.xml")
    rel_tree = _parse_xml(rels)
    rel_map: dict[str, str] = {}
    for rel in rel_tree.getroot():
        if _local(rel.tag) != "Relationship":
            continue
        rel_map[rel.attrib.get("Id", "")] = rel.attrib.get("Target", "")
    pres_tree = _parse_xml(pres)
    entries: list[tuple[int, Path, Path]] = []
    index = 0
    for node in pres_tree.getroot().iter():
        if _local(node.tag) != "sldId":
            continue
        rid = node.attrib.get(_qn(NS_R, "id")) or node.attrib.get("r:id") or ""
        target = rel_map.get(rid, "")
        if not target:
            continue
        index += 1
        slide_path = (root / "ppt" / target).resolve()
        rel_path = slide_path.parent / "_rels" / f"{slide_path.name}.rels"
        entries.append((index, slide_path, rel_path))
    if entries:
        return entries
    slides = sorted((root / "ppt" / "slides").glob("slide*.xml"))
    for index, slide_path in enumerate(slides, start=1):
        rel_path = slide_path.parent / "_rels" / f"{slide_path.name}.rels"
        entries.append((index, slide_path, rel_path))
    return entries


def _next_rid(rel_root: ET.Element) -> str:
    used = 1
    for rel in rel_root:
        if _local(rel.tag) != "Relationship":
            continue
        match = re.search(r"(\d+)$", rel.attrib.get("Id", ""))
        if match:
            used = max(used, int(match.group(1)) + 1)
    return f"rId{used}"


def _ensure_content_types(root: Path, parts: Sequence[tuple[str, str]], defaults: Sequence[tuple[str, str]]) -> None:
    path = root / "[Content_Types].xml"
    tree = _parse_xml(path)
    ct_root = tree.getroot()
    existing_defaults = {
        node.attrib.get("Extension", "").lower()
        for node in ct_root
        if _local(node.tag) == "Default"
    }
    existing_overrides = {
        node.attrib.get("PartName", "")
        for node in ct_root
        if _local(node.tag) == "Override"
    }
    for ext, content_type in defaults:
        if ext.lower() in existing_defaults:
            continue
        ET.SubElement(ct_root, _qn(NS_CT, "Default"), Extension=ext, ContentType=content_type)
        existing_defaults.add(ext.lower())
    for part, content_type in parts:
        if part in existing_overrides:
            continue
        ET.SubElement(ct_root, _qn(NS_CT, "Override"), PartName=part, ContentType=content_type)
        existing_overrides.add(part)
    _write_xml(tree, path)


def _max_shape_id(slide_root: ET.Element) -> int:
    highest = 2
    for node in slide_root.iter():
        if _local(node.tag) != "cNvPr":
            continue
        try:
            highest = max(highest, int(node.attrib.get("id", "0")))
        except ValueError:
            continue
    return highest


def _remove_tool_audio(slide_root: ET.Element, rel_root: ET.Element | None) -> list[str]:
    removed_targets: list[str] = []
    sp_tree = None
    for node in slide_root.iter():
        if _local(node.tag) == "spTree":
            sp_tree = node
            break
    if sp_tree is None:
        return removed_targets
    drop_rids: set[str] = set()
    for child in list(sp_tree):
        names = [
            item.attrib.get("name", "")
            for item in child.iter()
            if _local(item.tag) == "cNvPr"
        ]
        if not any(name.startswith(TOOL_AUDIO_PREFIX) for name in names):
            continue
        for item in child.iter():
            for key, value in item.attrib.items():
                if key.endswith("}embed") or key.endswith("}link") or key == "r:embed" or key == "r:link":
                    if value:
                        drop_rids.add(value)
        sp_tree.remove(child)
    if rel_root is not None and drop_rids:
        for rel in list(rel_root):
            if rel.attrib.get("Id") in drop_rids:
                target = rel.attrib.get("Target", "")
                if target:
                    removed_targets.append(target)
                rel_root.remove(rel)
    return removed_targets


def _set_transition(slide_root: ET.Element, advance_ms: int, advance_on_click: bool) -> None:
    transition = None
    for child in list(slide_root):
        if _local(child.tag) == "transition":
            transition = child
            break
    if transition is None:
        transition = ET.Element(_qn(NS_P, "transition"))
        insert_at = len(slide_root)
        for index, child in enumerate(list(slide_root)):
            if _local(child.tag) in {"timing", "extLst"}:
                insert_at = index
                break
        slide_root.insert(insert_at, transition)
    transition.set("advClick", "1" if advance_on_click else "0")
    transition.set("advTm", str(max(1, advance_ms)))


def _ensure_timing(slide_root: ET.Element, shape_id: int) -> None:
    for child in list(slide_root):
        if _local(child.tag) == "timing":
            slide_root.remove(child)
    timing = ET.SubElement(slide_root, _qn(NS_P, "timing"))
    tn_lst = ET.SubElement(timing, _qn(NS_P, "tnLst"))
    par = ET.SubElement(tn_lst, _qn(NS_P, "par"))
    root_tn = ET.SubElement(par, _qn(NS_P, "cTn"), id="1", dur="indefinite", restart="never", nodeType="tmRoot")
    child_tn = ET.SubElement(root_tn, _qn(NS_P, "childTnLst"))
    seq = ET.SubElement(child_tn, _qn(NS_P, "seq"), concurrent="1", nextAc="seek")
    seq_tn = ET.SubElement(seq, _qn(NS_P, "cTn"), id="2", dur="indefinite", nodeType="mainSeq")
    seq_children = ET.SubElement(seq_tn, _qn(NS_P, "childTnLst"))
    audio = ET.SubElement(seq_children, _qn(NS_P, "audio"))
    c_media = ET.SubElement(audio, _qn(NS_P, "cMediaNode"), vol="80000")
    media_tn = ET.SubElement(c_media, _qn(NS_P, "cTn"), id="3", fill="hold", display="0")
    st = ET.SubElement(media_tn, _qn(NS_P, "stCondLst"))
    ET.SubElement(st, _qn(NS_P, "cond"), delay="0")
    tgt = ET.SubElement(c_media, _qn(NS_P, "tgtEl"))
    ET.SubElement(tgt, _qn(NS_P, "spTgt"), spid=str(shape_id))
    prev = ET.SubElement(seq, _qn(NS_P, "prevCondLst"))
    prev_cond = ET.SubElement(prev, _qn(NS_P, "cond"), evt="onPrev", delay="0")
    prev_tgt = ET.SubElement(prev_cond, _qn(NS_P, "tgtEl"))
    ET.SubElement(prev_tgt, _qn(NS_P, "sldTgt"))
    nxt = ET.SubElement(seq, _qn(NS_P, "nextCondLst"))
    next_cond = ET.SubElement(nxt, _qn(NS_P, "cond"), evt="onNext", delay="0")
    next_tgt = ET.SubElement(next_cond, _qn(NS_P, "tgtEl"))
    ET.SubElement(next_tgt, _qn(NS_P, "sldTgt"))


def _ensure_show_timings(root: Path) -> None:
    path = root / "ppt" / "presentation.xml"
    tree = _parse_xml(path)
    pres = tree.getroot()
    show = None
    for child in pres:
        if _local(child.tag) == "sldShowPr":
            show = child
            break
    if show is None:
        show = ET.SubElement(pres, _qn(NS_P, "sldShowPr"))
    show.set("useTimings", "1")
    _write_xml(tree, path)


def _add_pic(
    slide_root: ET.Element,
    *,
    shape_id: int,
    name: str,
    r_audio: str,
    r_media: str,
    r_image: str,
) -> None:
    sp_tree = None
    for node in slide_root.iter():
        if _local(node.tag) == "spTree":
            sp_tree = node
            break
    if sp_tree is None:
        raise PowerPointError("幻灯片缺少 spTree")
    pic = ET.SubElement(sp_tree, _qn(NS_P, "pic"))
    nv = ET.SubElement(pic, _qn(NS_P, "nvPicPr"))
    cnv = ET.SubElement(nv, _qn(NS_P, "cNvPr"), id=str(shape_id), name=name)
    hlink = ET.SubElement(cnv, _qn(NS_A, "hlinkClick"))
    hlink.set(_qn(NS_R, "id"), "")
    hlink.set("action", "ppaction://media")
    cnv_pic = ET.SubElement(nv, _qn(NS_P, "cNvPicPr"))
    ET.SubElement(cnv_pic, _qn(NS_A, "picLocks"), noChangeAspect="1")
    nv_pr = ET.SubElement(nv, _qn(NS_P, "nvPr"))
    audio_file = ET.SubElement(nv_pr, _qn(NS_A, "audioFile"))
    audio_file.set(_qn(NS_R, "link"), r_audio)
    ext_lst = ET.SubElement(nv_pr, _qn(NS_P, "extLst"))
    ext = ET.SubElement(ext_lst, _qn(NS_P, "ext"), uri=P14_MEDIA_URI)
    media = ET.SubElement(ext, _qn(NS_P14, "media"))
    media.set(_qn(NS_R, "embed"), r_media)
    blip_fill = ET.SubElement(pic, _qn(NS_P, "blipFill"))
    blip = ET.SubElement(blip_fill, _qn(NS_A, "blip"))
    blip.set(_qn(NS_R, "embed"), r_image)
    stretch = ET.SubElement(blip_fill, _qn(NS_A, "stretch"))
    ET.SubElement(stretch, _qn(NS_A, "fillRect"))
    sp_pr = ET.SubElement(pic, _qn(NS_P, "spPr"))
    xfrm = ET.SubElement(sp_pr, _qn(NS_A, "xfrm"))
    ET.SubElement(xfrm, _qn(NS_A, "off"), x="-914400", y="-914400")
    ET.SubElement(xfrm, _qn(NS_A, "ext"), cx="91440", cy="91440")
    geom = ET.SubElement(sp_pr, _qn(NS_A, "prstGeom"), prst="rect")
    ET.SubElement(geom, _qn(NS_A, "avLst"))


def _advance_seconds(artifact: AudioArtifact, timing: Any, last: bool) -> float:
    if last:
        return artifact.duration_seconds + float(timing.last_slide_hold_seconds)
    return max(float(timing.minimum_slide_seconds), artifact.duration_seconds + float(timing.transition_buffer_seconds))


def embed_audio_ooxml(
    source_pptx: Path,
    output_pptx: Path,
    audio_artifacts: Sequence[AudioArtifact],
    timing: Any,
) -> BuildResult:
    source_pptx = source_pptx.expanduser().resolve()
    output_pptx = output_pptx.expanduser().resolve()
    if not source_pptx.is_file():
        raise FileNotFoundError(f"找不到 PPTX：{source_pptx}")
    output_pptx.parent.mkdir(parents=True, exist_ok=True)
    by_slide = {artifact.slide_index: artifact for artifact in audio_artifacts}
    with tempfile.TemporaryDirectory(prefix="ppt-voice-embed-") as raw_tmp:
        root = Path(raw_tmp) / "pkg"
        _unzip(source_pptx, root)
        media_dir = root / "ppt" / "media"
        media_dir.mkdir(parents=True, exist_ok=True)
        icon_name = "pptvoice_icon.png"
        icon_path = media_dir / icon_name
        if not icon_path.is_file():
            icon_path.write_bytes(_PNG_1X1)
        overrides: list[tuple[str, str]] = [(f"/ppt/media/{icon_name}", "image/png")]
        slides = _slide_entries(root)
        for slide_index, slide_path, rel_path in slides:
            slide_tree = _parse_xml(slide_path)
            slide_root = slide_tree.getroot()
            if rel_path.is_file():
                rel_tree = _parse_xml(rel_path)
            else:
                rel_path.parent.mkdir(parents=True, exist_ok=True)
                rel_tree = ET.ElementTree(ET.Element(_qn(NS_REL, "Relationships")))
            rel_root = rel_tree.getroot()
            stale = _remove_tool_audio(slide_root, rel_root)
            for target in stale:
                stale_file = (slide_path.parent / target).resolve()
                if stale_file.is_file() and "pptvoice" in stale_file.name.lower():
                    stale_file.unlink(missing_ok=True)
            artifact = by_slide.get(slide_index)
            if artifact is None:
                _write_xml(slide_tree, slide_path)
                _write_xml(rel_tree, rel_path)
                continue
            audio_src = Path(artifact.local_path).expanduser().resolve()
            if not audio_src.is_file():
                raise FileNotFoundError(f"找不到音频：{audio_src}")
            ext = audio_src.suffix.lower() or ".mp3"
            media_name = f"pptvoice_slide_{slide_index:03d}{ext}"
            media_path = media_dir / media_name
            shutil.copy2(audio_src, media_path)
            overrides.append((f"/ppt/media/{media_name}", "audio/mpeg" if ext == ".mp3" else "application/octet-stream"))
            rel_audio = _next_rid(rel_root)
            ET.SubElement(
                rel_root,
                _qn(NS_REL, "Relationship"),
                Id=rel_audio,
                Type=REL_AUDIO,
                Target=f"../media/{media_name}",
            )
            rel_media = _next_rid(rel_root)
            ET.SubElement(
                rel_root,
                _qn(NS_REL, "Relationship"),
                Id=rel_media,
                Type=REL_MS_MEDIA,
                Target=f"../media/{media_name}",
            )
            rel_image = None
            for rel in rel_root:
                if rel.attrib.get("Type") == REL_IMAGE and rel.attrib.get("Target", "").endswith(icon_name):
                    rel_image = rel.attrib.get("Id")
                    break
            if not rel_image:
                rel_image = _next_rid(rel_root)
                ET.SubElement(
                    rel_root,
                    _qn(NS_REL, "Relationship"),
                    Id=rel_image,
                    Type=REL_IMAGE,
                    Target=f"../media/{icon_name}",
                )
            shape_id = _max_shape_id(slide_root) + 1
            _add_pic(
                slide_root,
                shape_id=shape_id,
                name=_tool_shape_name(slide_index),
                r_audio=rel_audio,
                r_media=rel_media,
                r_image=rel_image,
            )
            seconds = _advance_seconds(artifact, timing, last=slide_index == len(slides))
            _set_transition(slide_root, int(round(seconds * 1000)), bool(timing.advance_on_click))
            _ensure_timing(slide_root, shape_id)
            _write_xml(slide_tree, slide_path)
            _write_xml(rel_tree, rel_path)
        _ensure_content_types(root, overrides, [("mp3", "audio/mpeg"), ("png", "image/png")])
        _ensure_show_timings(root)
        slide_count = len(slides)
        _zip_dir(root, output_pptx)
    return BuildResult(output_pptx, slide_count)


def validate_ooxml(
    pptx_path: Path,
    *,
    expected_slide_count: int | None = None,
    expected_audio_slides: Collection[int] | None = None,
) -> ValidationResult:
    pptx_path = pptx_path.expanduser().resolve()
    if not pptx_path.is_file():
        raise FileNotFoundError(f"找不到 PPTX：{pptx_path}")
    errors: list[str] = []
    timings: list[float] = []
    with tempfile.TemporaryDirectory(prefix="ppt-voice-validate-") as raw_tmp:
        root = Path(raw_tmp) / "pkg"
        _unzip(pptx_path, root)
        slides = _slide_entries(root)
        slide_count = len(slides)
        if expected_slide_count is not None and slide_count != expected_slide_count:
            errors.append(f"页数不一致：预期 {expected_slide_count}，实际 {slide_count}")
        expected = set(expected_audio_slides or range(1, slide_count + 1))
        for slide_index, slide_path, rel_path in slides:
            slide_root = _parse_xml(slide_path).getroot()
            names = [
                node.attrib.get("name", "")
                for node in slide_root.iter()
                if _local(node.tag) == "cNvPr" and node.attrib.get("name", "").startswith(TOOL_AUDIO_PREFIX)
            ]
            if slide_index in expected and len(names) != 1:
                errors.append(f"第 {slide_index} 页工具音频数量应为 1，实际 {len(names)}")
            if len(names) > 1:
                errors.append(f"第 {slide_index} 页存在重复工具音频")
            advance_ms = 0
            for node in slide_root.iter():
                if _local(node.tag) == "transition":
                    try:
                        advance_ms = int(float(node.attrib.get("advTm", "0")))
                    except ValueError:
                        advance_ms = 0
                    if slide_index in expected and node.attrib.get("advClick") not in {"0", "false"}:
                        # 允许单击，但必须同时有定时
                        pass
                    break
            timings.append(advance_ms / 1000.0)
            if slide_index in expected and advance_ms <= 0:
                errors.append(f"第 {slide_index} 页翻页时间无效")
            if slide_index in expected and names:
                has_media = False
                if rel_path.is_file():
                    rel_root = _parse_xml(rel_path).getroot()
                    for rel in rel_root:
                        target = rel.attrib.get("Target", "")
                        rel_type = rel.attrib.get("Type", "")
                        if "media" in rel_type or "audio" in rel_type:
                            media_file = (slide_path.parent / target).resolve()
                            if media_file.is_file():
                                has_media = True
                                break
                if not has_media:
                    errors.append(f"第 {slide_index} 页缺少嵌入音频文件")
        show_ok = False
        pres_path = root / "ppt" / "presentation.xml"
        if pres_path.is_file():
            for node in _parse_xml(pres_path).getroot().iter():
                if _local(node.tag) == "sldShowPr" and node.attrib.get("useTimings", "1") in {"1", "true"}:
                    show_ok = True
        if expected and not show_ok:
            errors.append("演示文稿未使用幻灯片计时")
        return ValidationResult(not errors, slide_count, tuple(errors), tuple(timings))


def _audio_duration_seconds(path: Path) -> float:
    try:
        from mutagen import File as mutagen_file

        meta = mutagen_file(str(path))
        length = float(getattr(getattr(meta, "info", None), "length", 0) or 0)
        if length > 0:
            return length
    except Exception:
        pass
    return 2.0


def _collect_slide_media(root: Path) -> list[tuple[int, Path | None, float]]:
    items: list[tuple[int, Path | None, float]] = []
    for slide_index, slide_path, rel_path in _slide_entries(root):
        advance_ms = 0
        slide_root = _parse_xml(slide_path).getroot()
        for node in slide_root.iter():
            if _local(node.tag) == "transition":
                try:
                    advance_ms = int(float(node.attrib.get("advTm", "0")))
                except ValueError:
                    advance_ms = 0
                break
        audio_path: Path | None = None
        if rel_path.is_file():
            rel_root = _parse_xml(rel_path).getroot()
            for rel in rel_root:
                target = rel.attrib.get("Target", "")
                rel_type = rel.attrib.get("Type", "")
                if not target:
                    continue
                if "audio" in rel_type or "media" in rel_type or target.lower().endswith((".mp3", ".m4a", ".wav")):
                    candidate = (slide_path.parent / target).resolve()
                    if candidate.is_file() and "pptvoice" in candidate.name.lower():
                        audio_path = candidate
                        break
                    if candidate.is_file() and audio_path is None:
                        audio_path = candidate
        duration = advance_ms / 1000.0 if advance_ms > 0 else 0.0
        if audio_path is not None:
            duration = max(duration, _audio_duration_seconds(audio_path))
        if duration <= 0:
            duration = 2.0
        items.append((slide_index, audio_path, duration))
    return items


def export_video_ffmpeg(
    source_pptx: Path,
    output_mp4: Path,
    *,
    vert_resolution: int = 1080,
    frames_per_second: int = 30,
) -> dict[str, Any]:
    ffmpeg = which_ffmpeg()
    if ffmpeg is None:
        raise PowerPointError("未找到 ffmpeg，无法在无 PowerPoint 环境下导出视频")
    source_pptx = source_pptx.expanduser().resolve()
    output_mp4 = output_mp4.expanduser().resolve()
    output_mp4.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ppt-voice-video-") as raw_tmp:
        tmp = Path(raw_tmp)
        pkg = tmp / "pkg"
        _unzip(source_pptx, pkg)
        slides_dir = tmp / "slides"
        try:
            export_slides_with_libreoffice(source_pptx, slides_dir)
        except Exception:
            from ppt_voice_builder.ppt.slide_exporter import export_slides_fallback

            export_slides_fallback(source_pptx, slides_dir)
        media_items = _collect_slide_media(pkg)
        clips: list[Path] = []
        height = int(vert_resolution)
        width = int(round(height * 16 / 9))
        for slide_index, audio_path, duration in media_items:
            image = slides_dir / slide_image_name(slide_index)
            if not image.is_file():
                raise PowerPointError(f"缺少第 {slide_index} 页预览图")
            clip = tmp / f"clip-{slide_index:03d}.mp4"
            cmd = [
                str(ffmpeg),
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-loop",
                "1",
                "-i",
                str(image),
            ]
            if audio_path is not None:
                cmd.extend(["-i", str(audio_path)])
            else:
                cmd.extend(["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"])
            cmd.extend(
                [
                    "-c:v",
                    "libx264",
                    "-tune",
                    "stillimage",
                    "-pix_fmt",
                    "yuv420p",
                    "-r",
                    str(int(frames_per_second)),
                    "-vf",
                    f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2",
                    "-c:a",
                    "aac",
                    "-shortest",
                    "-t",
                    f"{max(0.4, duration):.3f}",
                    str(clip),
                ]
            )
            _run(cmd, timeout=180)
            clips.append(clip)
        if not clips:
            raise PowerPointError("没有可导出的幻灯片")
        concat = tmp / "concat.txt"
        concat.write_text("".join(f"file '{clip.as_posix()}'\n" for clip in clips), encoding="utf-8")
        temp_mp4 = output_mp4.with_name(f"{output_mp4.stem}.exporting.{os.getpid()}.mp4")
        _run(
            [
                str(ffmpeg),
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat),
                "-c",
                "copy",
                str(temp_mp4),
            ],
            timeout=180,
        )
        os.replace(temp_mp4, output_mp4)
    if not output_mp4.is_file() or output_mp4.stat().st_size < 1024:
        raise PowerPointError(f"未生成有效视频：{output_mp4}")
    return {"outputPath": str(output_mp4), "bytes": output_mp4.stat().st_size, "engine": "ffmpeg"}
