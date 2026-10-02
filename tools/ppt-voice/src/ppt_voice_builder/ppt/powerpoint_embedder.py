import os
import shutil
from collections.abc import Sequence
from contextlib import suppress
from pathlib import Path
from typing import Any

from ppt_voice_builder.config.models import TimingConfig
from ppt_voice_builder.domain.errors import PowerPointError
from ppt_voice_builder.domain.models import AudioArtifact, BuildResult

TOOL_AUDIO_PREFIX = "PPTVOICE_AUDIO_"
MEDIA_PLAY_EFFECT = 83
TRIGGER_WITH_PREVIOUS = 2


def _tool_shape_name(slide_index: int) -> str:
    return f"{TOOL_AUDIO_PREFIX}SLIDE_{slide_index:03d}"


def ensure_media_auto_play(slide: Any, shape: Any) -> None:
    """Make an embedded media shape start reliably when its slide appears."""
    animation_settings = shape.AnimationSettings
    animation_settings.Animate = True
    play_settings = animation_settings.PlaySettings
    play_settings.PlayOnEntry = True
    play_settings.PauseAnimation = False
    play_settings.HideWhileNotPlaying = True

    sequence = slide.TimeLine.MainSequence
    media_effects: list[Any] = []
    for effect_index in range(1, int(sequence.Count) + 1):
        effect = sequence(effect_index)
        with suppress(Exception):
            if (
                int(effect.Shape.Id) == int(shape.Id)
                and int(effect.EffectType) == MEDIA_PLAY_EFFECT
            ):
                media_effects.append(effect)
    if not media_effects:
        media_effects.append(
            sequence.AddEffect(
                shape,
                MEDIA_PLAY_EFFECT,
                0,
                TRIGGER_WITH_PREVIOUS,
            )
        )
    for effect in media_effects:
        effect.Timing.TriggerType = TRIGGER_WITH_PREVIOUS
        effect.Timing.TriggerDelayTime = 0


class PowerPointEmbedder:
    def build(
        self,
        source_pptx: Path,
        output_pptx: Path,
        audio_artifacts: Sequence[AudioArtifact],
        timing: TimingConfig,
    ) -> BuildResult:
        try:
            if __import__("sys").platform == "win32":
                return self._build_with_powerpoint(source_pptx, output_pptx, audio_artifacts, timing)
        except Exception:
            pass
        from ppt_voice_builder.ppt.linux_engine import embed_audio_ooxml

        return embed_audio_ooxml(source_pptx, output_pptx, audio_artifacts, timing)

    def _build_with_powerpoint(
        self,
        source_pptx: Path,
        output_pptx: Path,
        audio_artifacts: Sequence[AudioArtifact],
        timing: TimingConfig,
    ) -> BuildResult:
        source_pptx = source_pptx.resolve()
        output_pptx = output_pptx.resolve()
        output_pptx.parent.mkdir(parents=True, exist_ok=True)
        building = output_pptx.with_suffix(".building.pptx")
        building.unlink(missing_ok=True)
        shutil.copy2(source_pptx, building)
        app: Any = None
        presentation: Any = None
        initialized = False
        try:
            import pythoncom
            import win32com.client

            pythoncom.CoInitialize()
            initialized = True
            app = win32com.client.DispatchEx("PowerPoint.Application")
            presentation = app.Presentations.Open(str(building), WithWindow=False)
            by_slide = {artifact.slide_index: artifact for artifact in audio_artifacts}
            for slide_index in range(1, presentation.Slides.Count + 1):
                slide = presentation.Slides(slide_index)
                for shape_index in range(slide.Shapes.Count, 0, -1):
                    shape = slide.Shapes(shape_index)
                    if str(shape.Name).startswith(TOOL_AUDIO_PREFIX):
                        shape.Delete()
                artifact = by_slide.get(slide_index)
                if artifact is None:
                    continue
                shape = slide.Shapes.AddMediaObject2(
                    str(artifact.local_path.resolve()),
                    False,
                    True,
                    -100,
                    -100,
                    1,
                    1,
                )
                shape.Name = _tool_shape_name(slide_index)
                ensure_media_auto_play(slide, shape)
                transition = slide.SlideShowTransition
                transition.AdvanceOnClick = timing.advance_on_click
                transition.AdvanceOnTime = True
                if slide_index == presentation.Slides.Count:
                    advance = artifact.duration_seconds + timing.last_slide_hold_seconds
                else:
                    advance = max(
                        timing.minimum_slide_seconds,
                        artifact.duration_seconds + timing.transition_buffer_seconds,
                    )
                transition.AdvanceTime = advance
            presentation.SlideShowSettings.AdvanceMode = 2
            slide_count = int(presentation.Slides.Count)
            presentation.Save()
            presentation.Close()
            presentation = None
            app.Quit()
            app = None
            os.replace(building, output_pptx)
            return BuildResult(output_pptx, slide_count)
        except Exception as exc:
            raise PowerPointError(f"PowerPoint 嵌入失败：{exc}") from exc
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
