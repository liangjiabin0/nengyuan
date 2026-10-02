import hashlib
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from ppt_voice_builder.audio.cache import AudioCache, build_cache_key
from ppt_voice_builder.audio.duration import validate_mp3
from ppt_voice_builder.bailian.client import BailianClient
from ppt_voice_builder.bailian.voice_designer import VoiceDesigner, mask_identifier
from ppt_voice_builder.config.models import Settings
from ppt_voice_builder.domain.enums import EmptyNotePolicy, TaskStatus
from ppt_voice_builder.domain.errors import ConfigurationError, PreflightError, ValidationError
from ppt_voice_builder.domain.models import (
    AudioArtifact,
    SlideNote,
    SlideTask,
    SynthesisRequest,
    ValidationResult,
)
from ppt_voice_builder.ppt.notes_reader import read_slide_notes
from ppt_voice_builder.ppt.powerpoint_embedder import PowerPointEmbedder
from ppt_voice_builder.ppt.preflight import PreflightReport, build_preflight_report
from ppt_voice_builder.ppt.validator import PowerPointValidator
from ppt_voice_builder.reporting.report_builder import build_html_report
from ppt_voice_builder.text.pronunciation import (
    apply_replacements,
    dictionary_hash,
    load_replacements,
)
from ppt_voice_builder.workflow.manifest import BuildManifest, ManifestStore

ProgressCallback = Callable[[str, int, int], None]


@dataclass(frozen=True)
class WorkflowResult:
    preflight: PreflightReport
    output_path: Path | None
    manifest_path: Path | None
    report_path: Path | None
    dry_run: bool


def _file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _note_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class WorkflowOrchestrator:
    def __init__(
        self,
        settings: Settings,
        *,
        config_root: Path | None = None,
        progress: ProgressCallback | None = None,
        embedder: PowerPointEmbedder | None = None,
        validator: PowerPointValidator | None = None,
    ) -> None:
        self.settings = settings
        self.config_root = (config_root or Path.cwd()).resolve()
        self.progress = progress or (lambda _message, _current, _total: None)
        self.embedder = embedder or PowerPointEmbedder()
        self.validator = validator or PowerPointValidator()

    def _prepared_notes(self, source_pptx: Path) -> list[SlideNote]:
        replacements = load_replacements(self.settings.project.pronunciation_file)
        result: list[SlideNote] = []
        for note in read_slide_notes(source_pptx):
            normalized = apply_replacements(note.normalized_text, replacements)
            result.append(
                SlideNote(
                    note.slide_index,
                    note.slide_id,
                    note.title,
                    note.raw_text,
                    normalized,
                    bool(normalized),
                )
            )
        return result

    def check(self, source_pptx: Path) -> PreflightReport:
        notes = self._prepared_notes(source_pptx)
        price = self.settings.bailian.prices_per_10k_chars.get(self.settings.bailian.model)
        if price is None:
            raise ConfigurationError(f"未配置模型 {self.settings.bailian.model} 的估算单价")
        report = build_preflight_report(notes, price)
        if (
            report.empty_note_slides
            and self.settings.notes.empty_note_policy is EmptyNotePolicy.ERROR
        ):
            pages = "、".join(map(str, report.empty_note_slides))
            raise PreflightError(f"以下页面没有演讲者备注：{pages}")
        return report

    def create_voice(self, prefix: str = "pptvoice") -> tuple[str, Path]:
        designer = VoiceDesigner(self.settings, self.config_root)
        result = designer.create(prefix)
        return result.voice_id, Path(str(designer.pending()["preview_path"]))

    def preview_voice(self) -> Path:
        return VoiceDesigner(self.settings, self.config_root).preview()

    def confirm_voice(self, voice_id: str) -> Path:
        return VoiceDesigner(self.settings, self.config_root).confirm(voice_id)

    def list_voices(self) -> list[dict[str, object]]:
        return VoiceDesigner(self.settings, self.config_root).list_local()

    def build(self, source_pptx: Path, *, dry_run: bool = False) -> WorkflowResult:
        source_pptx = source_pptx.expanduser().resolve()
        report = self.check(source_pptx)
        if dry_run:
            return WorkflowResult(report, None, None, None, True)
        if not self.settings.voice.voice_id:
            raise ConfigurationError("尚未确认 voice_id，请先运行 voice create/confirm")
        if self.settings.api_key is None:
            raise ConfigurationError("缺少 DASHSCOPE_API_KEY")

        source_hash = _file_hash(source_pptx)
        store = ManifestStore(self.settings.project.work_dir / source_hash / "manifest.json")
        prepared_notes = self._prepared_notes(source_pptx)
        previous = store.load() if store.path.exists() else None
        previous_by_slide = {task.slide_index: task for task in previous.tasks} if previous else {}
        tasks: list[SlideTask] = []
        for note in prepared_notes:
            note_digest = _note_hash(note.normalized_text)
            old = previous_by_slide.get(note.slide_index)
            if old is not None and old.note_hash == note_digest:
                tasks.append(old)
            else:
                tasks.append(
                    SlideTask(
                        note.slide_index,
                        note_digest,
                        None,
                        TaskStatus.NOTES_READY,
                        None,
                        None,
                        None,
                    )
                )
        manifest = BuildManifest(
            source_path=str(source_pptx),
            source_hash=source_hash,
            tasks=tasks,
            created_at=previous.created_at if previous else BuildManifest("", "", []).created_at,
            model=self.settings.bailian.model,
            masked_voice_id=mask_identifier(self.settings.voice.voice_id),
            api_calls=previous.api_calls if previous else 0,
            cache_hits=previous.cache_hits if previous else 0,
            retries=previous.retries if previous else [],
        )
        store.save(manifest)
        cache = AudioCache(self.settings.project.cache_dir)
        pronunciation_digest = dictionary_hash(self.settings.project.pronunciation_file)
        artifacts: list[AudioArtifact] = []
        api_key = self.settings.api_key.get_secret_value()
        workspace_id = (
            self.settings.workspace_id.get_secret_value()
            if self.settings.workspace_id is not None
            else None
        )
        with BailianClient(
            api_key,
            workspace_id,
            self.settings.bailian.request_timeout_seconds,
            self.settings.bailian.max_retries,
        ) as client:
            total = len(prepared_notes)
            for note, task in zip(prepared_notes, manifest.tasks, strict=True):
                if not note.has_note:
                    continue
                cache_key = build_cache_key(
                    normalized_text=note.normalized_text,
                    model=self.settings.bailian.model,
                    voice_id=self.settings.voice.voice_id,
                    instruction=self.settings.voice.instruction,
                    rate=self.settings.voice.rate,
                    pitch=self.settings.voice.pitch,
                    volume=self.settings.voice.volume,
                    seed=self.settings.voice.seed,
                    sample_rate=self.settings.bailian.sample_rate,
                    pronunciation_hash=pronunciation_digest,
                )
                self.progress(f"处理第 {note.slide_index} 页", note.slide_index, total)
                cached = cache.lookup(cache_key)
                if cached is not None:
                    try:
                        duration = validate_mp3(cached)
                        artifact = AudioArtifact(
                            note.slide_index, cache_key, cached, duration, "cache"
                        )
                        manifest.cache_hits += 1
                    except Exception:
                        cached.unlink(missing_ok=True)
                        cached = None
                if cached is None:
                    task.status = TaskStatus.GENERATING
                    task.error_message = None
                    store.save(manifest)
                    calls_before = client.request_count
                    retries_before = len(client.retry_events)
                    try:
                        response = client.synthesize(
                            SynthesisRequest(
                                note.normalized_text,
                                self.settings.bailian.model,
                                self.settings.voice.voice_id,
                                self.settings.voice.instruction,
                                self.settings.voice.rate,
                                self.settings.voice.pitch,
                                self.settings.voice.volume,
                                self.settings.voice.seed,
                                self.settings.bailian.sample_rate,
                            )
                        )
                        staged = cache.staging_path(cache_key)
                        client.download_audio(response.audio_url, staged)
                        duration = validate_mp3(staged)
                        final = cache.commit(cache_key, staged)
                        artifact = AudioArtifact(
                            note.slide_index, cache_key, final, duration, "generated"
                        )
                    except Exception as exc:
                        manifest.api_calls += client.request_count - calls_before
                        manifest.retries.extend(client.retry_events[retries_before:])
                        task.status = TaskStatus.FAILED
                        task.error_message = str(exc)
                        manifest.retries.append(f"第 {note.slide_index} 页：{exc}")
                        store.save(manifest)
                        raise
                    manifest.api_calls += client.request_count - calls_before
                    manifest.retries.extend(client.retry_events[retries_before:])
                artifacts.append(artifact)
                task.cache_key = cache_key
                task.audio_path = str(artifact.local_path)
                task.duration_seconds = artifact.duration_seconds
                task.status = TaskStatus.AUDIO_READY
                store.save(manifest)

        output = self.settings.project.output_dir / (
            source_pptx.stem + self.settings.project.output_suffix + ".pptx"
        )
        self.progress("正在嵌入 PowerPoint", len(prepared_notes), len(prepared_notes))
        built = self.embedder.build(source_pptx, output, artifacts, self.settings.timing)
        for task in manifest.tasks:
            if task.audio_path:
                task.status = TaskStatus.EMBEDDED
        store.save(manifest)
        validation = self.validator.validate(
            output,
            expected_slide_count=built.slide_count,
            expected_audio_slides={artifact.slide_index for artifact in artifacts},
        )
        manifest.verification = {
            "valid": validation.valid,
            "errors": list(validation.errors),
            "slide_timings": list(validation.slide_timings),
        }
        if validation.valid:
            for task in manifest.tasks:
                if task.audio_path:
                    task.status = TaskStatus.VERIFIED
        store.save(manifest)
        output_manifest = output.with_name(output.stem + "_manifest.json")
        shutil.copy2(store.path, output_manifest)
        report_path = output.with_name(output.stem + "_生成报告.html")
        build_html_report(report_path, manifest, report)
        if not validation.valid:
            raise ValidationError("输出 PPT 验证失败：" + "；".join(validation.errors))
        return WorkflowResult(report, output, output_manifest, report_path, False)

    def resume(self, manifest_path: Path) -> WorkflowResult:
        manifest = ManifestStore(manifest_path).load()
        return self.build(Path(manifest.source_path))

    def inspect(self, pptx_path: Path) -> ValidationResult:
        return self.validator.validate(pptx_path)
