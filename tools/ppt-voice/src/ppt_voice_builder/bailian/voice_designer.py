import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from ppt_voice_builder.bailian.client import BailianClient
from ppt_voice_builder.config.models import Settings
from ppt_voice_builder.domain.errors import ConfigurationError
from ppt_voice_builder.domain.models import VoiceDesignResult


def mask_identifier(value: str) -> str:
    if len(value) <= 12:
        return "****"
    return f"{value[:8]}…{value[-4:]}"


class VoiceDesigner:
    def __init__(self, settings: Settings, config_root: Path) -> None:
        self.settings = settings
        self.root = config_root.resolve()
        self.voices_dir = self.root / "profiles" / "voices"
        self.voices_dir.mkdir(parents=True, exist_ok=True)
        self.pending_path = self.voices_dir / ".pending.json"

    def _client(self) -> BailianClient:
        if self.settings.api_key is None:
            raise ConfigurationError("缺少 DASHSCOPE_API_KEY")
        workspace_id = (
            self.settings.workspace_id.get_secret_value()
            if self.settings.workspace_id is not None
            else None
        )
        return BailianClient(
            self.settings.api_key.get_secret_value(),
            workspace_id,
            self.settings.bailian.request_timeout_seconds,
            self.settings.bailian.max_retries,
        )

    def create(self, prefix: str = "pptvoice") -> VoiceDesignResult:
        with self._client() as client:
            result = client.create_voice_by_design(
                target_model=self.settings.bailian.model,
                prefix=prefix,
                voice_prompt=self.settings.voice.prompt,
                preview_text=self.settings.voice.preview_text,
            )
        preview_path = self.voices_dir / f"preview.{result.response_format}"
        preview_path.write_bytes(result.preview_audio)
        pending = {
            "voice_id": result.voice_id,
            "target_model": result.target_model,
            "preview_path": str(preview_path),
            "created_at": datetime.now(UTC).isoformat(),
        }
        self.pending_path.write_text(
            json.dumps(pending, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return result

    def pending(self) -> dict[str, Any]:
        if not self.pending_path.exists():
            raise ConfigurationError("没有待确认音色，请先运行 voice create")
        value = json.loads(self.pending_path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ConfigurationError("待确认音色记录损坏")
        return value

    def preview(self) -> Path:
        path = Path(str(self.pending().get("preview_path", "")))
        if not path.is_file():
            raise ConfigurationError("找不到试听音频，请重新创建音色")
        os.startfile(path)
        return path

    def confirm(self, voice_id: str) -> Path:
        pending = self.pending()
        if pending.get("voice_id") != voice_id:
            raise ConfigurationError("确认的 voice_id 与最近创建的音色不一致")
        profile = {
            "profile_name": self.settings.voice.profile_name,
            "model": self.settings.bailian.model,
            "voice_id": voice_id,
            "created_at": pending.get("created_at"),
            "voice_prompt": self.settings.voice.prompt,
            "preview_text": self.settings.voice.preview_text,
        }
        destination = self.voices_dir / "active.yaml"
        temporary = destination.with_suffix(".yaml.tmp")
        temporary.write_text(
            yaml.safe_dump(profile, allow_unicode=True, sort_keys=False), encoding="utf-8"
        )
        os.replace(temporary, destination)
        self.pending_path.unlink(missing_ok=True)
        return destination

    def list_local(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for path in sorted(self.voices_dir.glob("*.yaml")):
            value = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            if isinstance(value, dict):
                safe = dict(value)
                if isinstance(safe.get("voice_id"), str):
                    safe["voice_id"] = mask_identifier(safe["voice_id"])
                safe["path"] = str(path)
                result.append(safe)
        return result
