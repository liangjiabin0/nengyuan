import base64
from typing import Any

from ppt_voice_builder.domain.errors import ResponseFormatError
from ppt_voice_builder.domain.models import SynthesisResult, VoiceDesignResult


def _mapping(value: Any, field: str, request_id: str | None) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ResponseFormatError(f"百炼响应缺少对象字段 {field}", request_id=request_id)
    return value


def parse_synthesis_response(data: dict[str, Any]) -> SynthesisResult:
    request_id = data.get("request_id") if isinstance(data.get("request_id"), str) else None
    output = _mapping(data.get("output"), "output", request_id)
    audio = _mapping(output.get("audio"), "output.audio", request_id)
    url = audio.get("url")
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        raise ResponseFormatError("百炼响应缺少有效的 output.audio.url", request_id=request_id)
    usage = _mapping(data.get("usage", {}), "usage", request_id)
    characters = usage.get("characters", 0)
    if not isinstance(characters, int):
        raise ResponseFormatError("百炼 usage.characters 类型无效", request_id=request_id)
    return SynthesisResult(url, request_id, characters, usage)


def parse_voice_design_response(
    data: dict[str, Any],
    *,
    requested_target_model: str,
) -> VoiceDesignResult:
    request_id = data.get("request_id") if isinstance(data.get("request_id"), str) else None
    output = _mapping(data.get("output"), "output", request_id)
    preview = _mapping(output.get("preview_audio"), "output.preview_audio", request_id)
    voice_id = output.get("voice_id")
    target_model = output.get("target_model", requested_target_model)
    encoded = preview.get("data")
    response_format = preview.get("response_format")
    sample_rate = preview.get("sample_rate")
    if not isinstance(voice_id, str) or not voice_id:
        raise ResponseFormatError("声音设计响应缺少 voice_id", request_id=request_id)
    if not isinstance(target_model, str) or not target_model:
        raise ResponseFormatError("声音设计响应缺少 target_model", request_id=request_id)
    if not isinstance(encoded, str) or not encoded:
        raise ResponseFormatError("声音设计响应缺少预览音频", request_id=request_id)
    if not isinstance(response_format, str) or not response_format:
        raise ResponseFormatError("声音设计响应缺少必要字段", request_id=request_id)
    if not isinstance(sample_rate, int):
        raise ResponseFormatError("预览音频采样率无效", request_id=request_id)
    try:
        audio = base64.b64decode(encoded, validate=True)
    except ValueError as exc:
        raise ResponseFormatError("预览音频不是有效 Base64", request_id=request_id) from exc
    return VoiceDesignResult(
        voice_id, target_model, audio, response_format, sample_rate, request_id
    )
