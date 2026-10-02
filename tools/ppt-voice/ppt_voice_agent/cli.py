from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from decimal import Decimal
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=_json_default) + "\n")
    sys.stdout.flush()


def _json_default(value: Any) -> Any:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, Path):
        return str(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _load_json_file(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _health() -> dict[str, Any]:
    info: dict[str, Any] = {
        "ok": False,
        "type": "result",
        "python": sys.version.split()[0],
        "package": False,
        "pptx": False,
        "powerpoint": False,
        "libreoffice": False,
        "ffmpeg": False,
        "pdftoppm": False,
        "embedEngine": "ooxml",
        "hasApiKey": bool(os.environ.get("DASHSCOPE_API_KEY")),
    }
    try:
        import ppt_voice_builder  # noqa: F401

        info["package"] = True
    except Exception as exc:
        info["packageError"] = str(exc)
    try:
        import pptx  # noqa: F401

        info["pptx"] = True
    except Exception as exc:
        info["pptxError"] = str(exc)
    try:
        from ppt_voice_builder.ppt.linux_engine import runtime_probes

        info.update(runtime_probes())
    except Exception as exc:
        info["probeError"] = str(exc)
        try:
            import winreg

            winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, "PowerPoint.Application")
            info["powerpoint"] = True
            info["embedEngine"] = "powerpoint"
        except Exception:
            info["powerpoint"] = False
    info["ok"] = bool(info["package"] and info["pptx"])
    return info


def _inspect(pptx: Path) -> dict[str, Any]:
    from ppt_voice_builder.ppt.inspector import inspect_slides

    slides = inspect_slides(pptx)
    return {
        "ok": True,
        "type": "result",
        "slideCount": len(slides),
        "emptyNoteSlides": [item["slideIndex"] for item in slides if not item["hasNote"]],
        "characterCount": sum(int(item["characterCount"]) for item in slides),
        "slides": slides,
    }


def _write_notes(pptx: Path, notes_path: Path, output: Path) -> dict[str, Any]:
    from ppt_voice_builder.ppt.notes_writer import write_slide_notes

    payload = _load_json_file(notes_path)
    raw_notes = payload.get("notes", payload) if isinstance(payload, dict) else payload
    notes_by_index: dict[int, str] = {}
    if isinstance(raw_notes, dict):
        for key, value in raw_notes.items():
            notes_by_index[int(key)] = str(value or "")
    elif isinstance(raw_notes, list):
        for item in raw_notes:
            if not isinstance(item, dict):
                continue
            index = int(item.get("slideIndex") or item.get("index") or 0)
            if index > 0:
                notes_by_index[index] = str(item.get("text") or item.get("notes") or "")
    written = write_slide_notes(pptx, output, notes_by_index)
    return {"ok": True, "type": "result", "outputPath": str(written), "updatedSlides": sorted(notes_by_index)}


def _check(pptx: Path, config: Path) -> dict[str, Any]:
    from ppt_voice_builder.config.loader import load_settings
    from ppt_voice_builder.workflow.orchestrator import WorkflowOrchestrator

    settings = load_settings(config)
    report = WorkflowOrchestrator(settings, config_root=config.parent).check(pptx)
    return {
        "ok": True,
        "type": "result",
        "slideCount": report.slide_count,
        "emptyNoteSlides": list(report.empty_note_slides),
        "characterCount": report.character_count,
        "estimatedCostYuan": format(report.estimated_cost_yuan, "f"),
    }


def _synthesize_one(pptx: Path, slide_index: int, output: Path, config: Path) -> dict[str, Any]:
    from ppt_voice_builder.audio.cache import AudioCache
    from ppt_voice_builder.bailian.client import BailianClient
    from ppt_voice_builder.bailian.synthesizer import AudioSynthesizer
    from ppt_voice_builder.config.loader import load_settings
    from ppt_voice_builder.ppt.inspector import inspect_slides
    from ppt_voice_builder.text.pronunciation import apply_replacements, dictionary_hash, load_replacements

    settings = load_settings(config)
    if not settings.voice.voice_id:
        raise ValueError("尚未配置 voice_id")
    if settings.api_key is None:
        raise ValueError("缺少 DASHSCOPE_API_KEY")
    slides = inspect_slides(pptx)
    target = next((item for item in slides if int(item["slideIndex"]) == slide_index), None)
    if target is None:
        raise ValueError(f"找不到第 {slide_index} 页")
    replacements = load_replacements(settings.project.pronunciation_file)
    text = apply_replacements(str(target["notes"] or ""), replacements)
    if not text:
        raise ValueError(f"第 {slide_index} 页没有演讲者备注")
    cache = AudioCache(settings.project.cache_dir)
    api_key = settings.api_key.get_secret_value()
    workspace_id = (
        settings.workspace_id.get_secret_value() if settings.workspace_id is not None else None
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    with BailianClient(
        api_key,
        workspace_id,
        settings.bailian.request_timeout_seconds,
        settings.bailian.max_retries,
    ) as client:
        synthesizer = AudioSynthesizer(client, settings, cache)
        artifact = synthesizer.synthesize_slide(
            slide_index,
            text,
            dictionary_hash(settings.project.pronunciation_file),
        )
    output.write_bytes(artifact.local_path.read_bytes())
    return {
        "ok": True,
        "type": "result",
        "slideIndex": slide_index,
        "audioPath": str(output),
        "cachePath": str(artifact.local_path),
        "durationSeconds": artifact.duration_seconds,
        "source": artifact.source,
        "characters": len(text),
    }


def _build(pptx: Path, config: Path) -> dict[str, Any]:
    from ppt_voice_builder.config.loader import load_settings
    from ppt_voice_builder.workflow.orchestrator import WorkflowOrchestrator

    settings = load_settings(config)

    def progress(message: str, current: int, total: int) -> None:
        emit(
            {
                "ok": True,
                "type": "progress",
                "message": message,
                "current": current,
                "total": total,
            }
        )

    result = WorkflowOrchestrator(
        settings,
        config_root=config.parent,
        progress=progress,
    ).build(pptx, dry_run=False)
    return {
        "ok": True,
        "type": "result",
        "dryRun": False,
        "outputPath": str(result.output_path) if result.output_path else None,
        "manifestPath": str(result.manifest_path) if result.manifest_path else None,
        "reportPath": str(result.report_path) if result.report_path else None,
        "slideCount": result.preflight.slide_count,
        "emptyNoteSlides": list(result.preflight.empty_note_slides),
        "characterCount": result.preflight.character_count,
        "estimatedCostYuan": format(result.preflight.estimated_cost_yuan, "f"),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ppt-voice-agent")
    parser.add_argument(
        "command",
        choices=["health", "inspect", "write-notes", "check", "synthesize-one", "build", "export-slides", "export-video"],
    )
    parser.add_argument("--pptx", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--notes", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--slide", type=int)
    args = parser.parse_args(argv)
    try:
        if args.command == "health":
            emit(_health())
            return 0
        if args.command == "inspect":
            if not args.pptx:
                raise ValueError("inspect 需要 --pptx")
            emit(_inspect(args.pptx))
            return 0
        if args.command == "write-notes":
            if not args.pptx or not args.notes or not args.output:
                raise ValueError("write-notes 需要 --pptx --notes --output")
            emit(_write_notes(args.pptx, args.notes, args.output))
            return 0
        if args.command == "check":
            if not args.pptx or not args.config:
                raise ValueError("check 需要 --pptx --config")
            emit(_check(args.pptx, args.config))
            return 0
        if args.command == "synthesize-one":
            if not args.pptx or not args.slide or not args.output or not args.config:
                raise ValueError("synthesize-one 需要 --pptx --slide --output --config")
            emit(_synthesize_one(args.pptx, args.slide, args.output, args.config))
            return 0
        if args.command == "build":
            if not args.pptx or not args.config:
                raise ValueError("build 需要 --pptx --config")
            emit(_build(args.pptx, args.config))
            return 0
        if args.command == "export-slides":
            if not args.pptx or not args.output:
                raise ValueError("export-slides 需要 --pptx --output")
            from ppt_voice_builder.ppt.slide_exporter import export_slide_images

            result = export_slide_images(args.pptx, args.output)
            emit({"ok": True, "type": "result", **result})
            return 0
        if args.command == "export-video":
            if not args.pptx or not args.output:
                raise ValueError("export-video 需要 --pptx --output")
            from ppt_voice_builder.ppt.video_exporter import export_presentation_video

            result = export_presentation_video(args.pptx, args.output)
            emit({"ok": True, "type": "result", **result})
            return 0
        raise ValueError(f"未知命令：{args.command}")
    except Exception as exc:
        emit(
            {
                "ok": False,
                "type": "error",
                "error": str(exc),
                "trace": traceback.format_exc(limit=6),
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
