from collections.abc import Mapping
from pathlib import Path
from typing import Any

import yaml
from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from ppt_voice_builder.config.models import Settings
from ppt_voice_builder.domain.errors import ConfigurationError


class _EnvironmentSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    api_key: SecretStr | None = Field(default=None, validation_alias="DASHSCOPE_API_KEY")
    workspace_id: SecretStr | None = Field(default=None, validation_alias="BAILIAN_WORKSPACE_ID")


def _resolve_project_paths(raw: dict[str, Any], root: Path) -> None:
    project = raw.setdefault("project", {})
    if not isinstance(project, dict):
        raise ConfigurationError("project 配置必须是映射")
    defaults = {
        "cache_dir": "./cache",
        "work_dir": "./work",
        "output_dir": "./output",
        "pronunciation_file": "./profiles/pronunciation.yaml",
    }
    for key, default in defaults.items():
        path = Path(str(project.get(key, default))).expanduser()
        project[key] = (path if path.is_absolute() else root / path).resolve()


def _load_active_voice(raw: dict[str, Any], root: Path) -> None:
    voice = raw.setdefault("voice", {})
    if not isinstance(voice, dict) or voice.get("voice_id"):
        return
    active_path = root / "profiles" / "voices" / "active.yaml"
    if not active_path.exists():
        return
    active = yaml.safe_load(active_path.read_text(encoding="utf-8")) or {}
    if isinstance(active, dict):
        for key in ("profile_name", "voice_id", "model", "voice_prompt", "preview_text"):
            if key in active:
                destination = "prompt" if key == "voice_prompt" else key
                if destination != "model":
                    voice[destination] = active[key]


def load_settings(
    config_path: Path = Path("config.yaml"),
    *,
    env: Mapping[str, str] | None = None,
) -> Settings:
    config_path = config_path.expanduser().resolve()
    root = config_path.parent
    raw: dict[str, Any] = {}
    if config_path.exists():
        loaded = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
        if not isinstance(loaded, dict):
            raise ConfigurationError("配置文件顶层必须是 YAML 映射")
        raw = loaded
    _load_active_voice(raw, root)
    _resolve_project_paths(raw, root)
    if env is None:
        environment = _EnvironmentSettings(_env_file=root / ".env")
        raw["api_key"] = (
            environment.api_key
            if environment.api_key is not None and environment.api_key.get_secret_value()
            else None
        )
        raw["workspace_id"] = (
            environment.workspace_id
            if environment.workspace_id is not None and environment.workspace_id.get_secret_value()
            else None
        )
    else:
        raw["api_key"] = env.get("DASHSCOPE_API_KEY") or None
        raw["workspace_id"] = env.get("BAILIAN_WORKSPACE_ID") or None
    return Settings.model_validate(raw)
