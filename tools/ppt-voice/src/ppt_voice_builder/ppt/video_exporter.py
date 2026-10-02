import os
import time
from contextlib import suppress
from pathlib import Path
from typing import Any

from ppt_voice_builder.domain.errors import PowerPointError

PP_MEDIA_DONE = 3
PP_MEDIA_FAILED = 4


def _wait_file_ready(path: Path, timeout_seconds: float = 90) -> None:
    deadline = time.time() + timeout_seconds
    last_size = -1
    stable = 0
    while time.time() < deadline:
        try:
            size = path.stat().st_size
            with path.open("rb") as handle:
                handle.read(64)
            if size >= 1024 and size == last_size:
                stable += 1
                if stable >= 2:
                    return
            else:
                stable = 0
            last_size = size
        except OSError:
            stable = 0
        time.sleep(1)
    raise PowerPointError(f"视频文件仍被占用或尚未写完：{path}")


def _replace_with_retry(source: Path, dest: Path, attempts: int = 30) -> None:
    last_error: OSError | None = None
    for _ in range(attempts):
        try:
            os.replace(source, dest)
            return
        except OSError as exc:
            last_error = exc
            time.sleep(1)
    raise PowerPointError(f"无法写入成品视频（文件被占用）：{dest}") from last_error


def export_presentation_video(
    source_pptx: Path,
    output_mp4: Path,
    *,
    timeout_seconds: float = 40 * 60,
    vert_resolution: int = 1080,
    frames_per_second: int = 30,
    quality: int = 85,
) -> dict[str, Any]:
    import sys

    if sys.platform != "win32":
        from ppt_voice_builder.ppt.linux_engine import export_video_ffmpeg

        return export_video_ffmpeg(
            source_pptx,
            output_mp4,
            vert_resolution=vert_resolution,
            frames_per_second=frames_per_second,
        )
    try:
        return _export_presentation_video_powerpoint(
            source_pptx,
            output_mp4,
            timeout_seconds=timeout_seconds,
            vert_resolution=vert_resolution,
            frames_per_second=frames_per_second,
            quality=quality,
        )
    except Exception:
        from ppt_voice_builder.ppt.linux_engine import export_video_ffmpeg

        return export_video_ffmpeg(
            source_pptx,
            output_mp4,
            vert_resolution=vert_resolution,
            frames_per_second=frames_per_second,
        )


def _export_presentation_video_powerpoint(
    source_pptx: Path,
    output_mp4: Path,
    *,
    timeout_seconds: float = 40 * 60,
    vert_resolution: int = 1080,
    frames_per_second: int = 30,
    quality: int = 85,
) -> dict[str, Any]:
    source_pptx = source_pptx.expanduser().resolve()
    output_mp4 = output_mp4.expanduser().resolve()
    if not source_pptx.is_file():
        raise FileNotFoundError(f"找不到配音 PPT：{source_pptx}")
    output_mp4.parent.mkdir(parents=True, exist_ok=True)
    temp_mp4 = output_mp4.with_name(f"{output_mp4.stem}.exporting.{os.getpid()}.mp4")
    for stale in output_mp4.parent.glob(f"{output_mp4.stem}.exporting.*.mp4"):
        with suppress(OSError):
            stale.unlink()

    app: Any = None
    presentation: Any = None
    initialized = False
    try:
        import pythoncom
        import win32com.client

        pythoncom.CoInitialize()
        initialized = True
        app = win32com.client.DispatchEx("PowerPoint.Application")
        presentation = app.Presentations.Open(str(source_pptx), WithWindow=False, ReadOnly=True)
        presentation.CreateVideo(
            str(temp_mp4),
            True,
            5,
            int(vert_resolution),
            int(frames_per_second),
            int(quality),
        )
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            status = int(presentation.CreateVideoStatus)
            if status == PP_MEDIA_DONE:
                break
            if status == PP_MEDIA_FAILED:
                raise PowerPointError("PowerPoint 导出视频失败")
            time.sleep(2)
        else:
            raise PowerPointError("导出视频超时")
        presentation.Close()
        presentation = None
        app.Quit()
        app = None
        time.sleep(2)
    except Exception as exc:
        raise PowerPointError(f"导出配音视频失败：{exc}") from exc
    finally:
        if presentation is not None:
            with suppress(Exception):
                presentation.Close()
        if app is not None:
            with suppress(Exception):
                app.Quit()
        if initialized:
            with suppress(Exception):
                pythoncom.CoUninitialize()

    _wait_file_ready(temp_mp4)
    _replace_with_retry(temp_mp4, output_mp4)
    if not output_mp4.is_file() or output_mp4.stat().st_size < 1024:
        raise PowerPointError(f"未生成有效视频：{output_mp4}")
    return {
        "outputPath": str(output_mp4),
        "bytes": output_mp4.stat().st_size,
    }
