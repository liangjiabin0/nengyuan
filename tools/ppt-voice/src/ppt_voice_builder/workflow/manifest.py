import json
import os
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ppt_voice_builder.domain.enums import TaskStatus
from ppt_voice_builder.domain.models import SlideTask


@dataclass
class BuildManifest:
    source_path: str
    source_hash: str
    tasks: list[SlideTask]
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    model: str = ""
    masked_voice_id: str = ""
    api_calls: int = 0
    cache_hits: int = 0
    retries: list[str] = field(default_factory=list)
    verification: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        for task in data["tasks"]:
            task["status"] = str(task["status"])
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BuildManifest":
        tasks = [
            SlideTask(
                slide_index=int(item["slide_index"]),
                note_hash=str(item["note_hash"]),
                cache_key=item.get("cache_key"),
                status=TaskStatus(item["status"]),
                audio_path=item.get("audio_path"),
                duration_seconds=item.get("duration_seconds"),
                error_message=item.get("error_message"),
            )
            for item in data.get("tasks", [])
        ]
        return cls(
            source_path=str(data["source_path"]),
            source_hash=str(data["source_hash"]),
            tasks=tasks,
            created_at=str(data.get("created_at", datetime.now(UTC).isoformat())),
            updated_at=str(data.get("updated_at", datetime.now(UTC).isoformat())),
            model=str(data.get("model", "")),
            masked_voice_id=str(data.get("masked_voice_id", "")),
            api_calls=int(data.get("api_calls", 0)),
            cache_hits=int(data.get("cache_hits", 0)),
            retries=list(data.get("retries", [])),
            verification=data.get("verification"),
        )


class ManifestStore:
    def __init__(self, path: Path) -> None:
        self.path = path.resolve()

    def save(self, manifest: BuildManifest) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        manifest.updated_at = datetime.now(UTC).isoformat()
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        payload = json.dumps(manifest.to_dict(), ensure_ascii=False, indent=2)
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)

    def load(self) -> BuildManifest:
        data = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("manifest 顶层必须是对象")
        return BuildManifest.from_dict(data)
