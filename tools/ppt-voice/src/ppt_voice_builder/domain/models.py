from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from ppt_voice_builder.domain.enums import TaskStatus


@dataclass(frozen=True)
class SlideNote:
    slide_index: int
    slide_id: int
    title: str
    raw_text: str
    normalized_text: str
    has_note: bool


@dataclass(frozen=True)
class VoiceProfile:
    profile_name: str
    model: str
    voice_id: str | None
    voice_prompt: str
    preview_text: str
    instruction: str
    rate: float
    pitch: float
    volume: int
    seed: int


@dataclass(frozen=True)
class AudioArtifact:
    slide_index: int
    cache_key: str
    local_path: Path
    duration_seconds: float
    source: Literal["generated", "cache"]


@dataclass
class SlideTask:
    slide_index: int
    note_hash: str
    cache_key: str | None
    status: TaskStatus
    audio_path: str | None
    duration_seconds: float | None
    error_message: str | None


@dataclass(frozen=True)
class SynthesisRequest:
    text: str
    model: str
    voice_id: str
    instruction: str = ""
    rate: float = 1.0
    pitch: float = 1.0
    volume: int = 50
    seed: int = 0
    sample_rate: int = 24_000


@dataclass(frozen=True)
class SynthesisResult:
    audio_url: str
    request_id: str | None
    characters: int
    usage: dict[str, Any]


@dataclass(frozen=True)
class VoiceDesignResult:
    voice_id: str
    target_model: str
    preview_audio: bytes
    response_format: str
    sample_rate: int
    request_id: str | None


@dataclass(frozen=True)
class BuildResult:
    output_path: Path
    slide_count: int


@dataclass(frozen=True)
class ValidationResult:
    valid: bool
    slide_count: int
    errors: tuple[str, ...]
    slide_timings: tuple[float, ...]
