from pathlib import Path

from mutagen.mp3 import MP3

from ppt_voice_builder.domain.errors import AudioValidationError


def validate_mp3(path: Path) -> float:
    if not path.is_file():
        raise AudioValidationError(f"MP3 不存在：{path}")
    if path.stat().st_size <= 1024:
        raise AudioValidationError(f"MP3 文件过小：{path}")
    try:
        audio = MP3(path)  # type: ignore[no-untyped-call]
        if audio.info is None:
            raise AudioValidationError(f"MP3 缺少音频信息：{path}")
        duration = float(audio.info.length)
    except Exception as exc:
        raise AudioValidationError(f"无法读取 MP3：{path}") from exc
    if duration <= 0.2:
        raise AudioValidationError(f"MP3 时长异常：{duration:.3f} 秒")
    return duration
