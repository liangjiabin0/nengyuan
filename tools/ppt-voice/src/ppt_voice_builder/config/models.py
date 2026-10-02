from decimal import Decimal
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from ppt_voice_builder.domain.enums import EmptyNotePolicy


class BailianConfig(BaseModel):
    region: Literal["cn-beijing"] = "cn-beijing"
    model: str = "cosyvoice-v3.5-plus"
    preview_model: str = "cosyvoice-v3.5-flash"
    request_timeout_seconds: float = Field(180, gt=0)
    max_retries: int = Field(3, ge=1, le=10)
    sample_rate: Literal[24_000] = 24_000
    prices_per_10k_chars: dict[str, Decimal] = {
        "cosyvoice-v3.5-plus": Decimal("3.5"),
        "cosyvoice-v3.5-flash": Decimal("2.0"),
    }


class VoiceConfig(BaseModel):
    profile_name: str = "正式科技汇报男声"
    voice_id: str | None = None
    prompt: str = "30至40岁的中文专业汇报人员，声音沉稳自然，吐字清晰。"
    preview_text: str = "各位专家，大家好。下面开始本项目汇报。"
    instruction: str = "正式自然的技术汇报语气，语速稍慢，停顿清晰，避免新闻播音腔。"
    rate: float = Field(0.95, ge=0.5, le=2.0)
    pitch: float = Field(1.0, ge=0.5, le=2.0)
    volume: int = Field(50, ge=0, le=100)
    seed: int = Field(12_345, ge=0, le=65_535)


class TimingConfig(BaseModel):
    transition_buffer_seconds: float = Field(0.8, ge=0)
    last_slide_hold_seconds: float = Field(4.0, ge=0)
    minimum_slide_seconds: float = Field(2.0, gt=0)
    advance_on_click: bool = False


class NotesConfig(BaseModel):
    empty_note_policy: EmptyNotePolicy = EmptyNotePolicy.ERROR


class ProjectConfig(BaseModel):
    output_suffix: str = "_自动配音版"
    cache_dir: Path = Path("./cache")
    work_dir: Path = Path("./work")
    output_dir: Path = Path("./output")
    pronunciation_file: Path = Path("./profiles/pronunciation.yaml")


class Settings(BaseModel):
    model_config = ConfigDict(hide_input_in_errors=True)

    bailian: BailianConfig = Field(default_factory=BailianConfig)
    voice: VoiceConfig = Field(default_factory=VoiceConfig)
    timing: TimingConfig = Field(default_factory=TimingConfig)
    notes: NotesConfig = Field(default_factory=NotesConfig)
    project: ProjectConfig = Field(default_factory=ProjectConfig)
    api_key: SecretStr | None = Field(default=None, exclude=True)
    workspace_id: SecretStr | None = Field(default=None, exclude=True)

    @field_validator("workspace_id")
    @classmethod
    def validate_workspace_id(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and any(c in value.get_secret_value() for c in "/:@"):
            raise ValueError("BAILIAN_WORKSPACE_ID 格式无效")
        return value

    @property
    def masked_api_key(self) -> str:
        if self.api_key is None:
            return "<未配置>"
        raw = self.api_key.get_secret_value()
        return "****" + raw[-4:] if len(raw) >= 4 else "****"

    @property
    def masked_workspace_id(self) -> str:
        if self.workspace_id is None:
            return "<未配置>"
        raw = self.workspace_id.get_secret_value()
        return (raw[:3] + "…" + raw[-3:]) if len(raw) > 8 else "****"

    def __repr__(self) -> str:
        return (
            "Settings("
            f"bailian={self.bailian!r}, voice={self.voice!r}, timing={self.timing!r}, "
            f"notes={self.notes!r}, project={self.project!r}, "
            f"api_key={self.masked_api_key!r}, workspace_id={self.masked_workspace_id!r})"
        )
