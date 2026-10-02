from collections.abc import Collection
from contextlib import suppress
from pathlib import Path
from typing import Any

from ppt_voice_builder.domain.errors import PowerPointError
from ppt_voice_builder.domain.models import ValidationResult
from ppt_voice_builder.ppt.powerpoint_embedder import (
    MEDIA_PLAY_EFFECT,
    TOOL_AUDIO_PREFIX,
    TRIGGER_WITH_PREVIOUS,
)


class PowerPointValidator:
    def validate(
        self,
        pptx_path: Path,
        *,
        expected_slide_count: int | None = None,
        expected_audio_slides: Collection[int] | None = None,
    ) -> ValidationResult:
        try:
            if __import__("sys").platform == "win32":
                return self._validate_with_powerpoint(
                    pptx_path,
                    expected_slide_count=expected_slide_count,
                    expected_audio_slides=expected_audio_slides,
                )
        except Exception:
            pass
        from ppt_voice_builder.ppt.linux_engine import validate_ooxml

        return validate_ooxml(
            pptx_path,
            expected_slide_count=expected_slide_count,
            expected_audio_slides=expected_audio_slides,
        )

    def _validate_with_powerpoint(
        self,
        pptx_path: Path,
        *,
        expected_slide_count: int | None = None,
        expected_audio_slides: Collection[int] | None = None,
    ) -> ValidationResult:
        app: Any = None
        presentation: Any = None
        initialized = False
        errors: list[str] = []
        timings: list[float] = []
        try:
            import pythoncom
            import win32com.client

            pythoncom.CoInitialize()
            initialized = True
            app = win32com.client.DispatchEx("PowerPoint.Application")
            presentation = app.Presentations.Open(
                str(pptx_path.resolve()), ReadOnly=True, WithWindow=False
            )
            slide_count = int(presentation.Slides.Count)
            if expected_slide_count is not None and slide_count != expected_slide_count:
                errors.append(f"页数不一致：预期 {expected_slide_count}，实际 {slide_count}")
            expected = set(expected_audio_slides or range(1, slide_count + 1))
            for slide_index in range(1, slide_count + 1):
                slide = presentation.Slides(slide_index)
                matches = [
                    str(slide.Shapes(i).Name)
                    for i in range(1, slide.Shapes.Count + 1)
                    if str(slide.Shapes(i).Name).startswith(TOOL_AUDIO_PREFIX)
                ]
                if slide_index in expected and len(matches) != 1:
                    errors.append(f"第 {slide_index} 页工具音频数量应为 1，实际 {len(matches)}")
                if len(matches) > 1:
                    errors.append(f"第 {slide_index} 页存在重复工具音频")
                if slide_index in expected and len(matches) == 1:
                    audio_shape = next(
                        slide.Shapes(i)
                        for i in range(1, slide.Shapes.Count + 1)
                        if str(slide.Shapes(i).Name).startswith(TOOL_AUDIO_PREFIX)
                    )
                    play_on_entry = bool(
                        audio_shape.AnimationSettings.PlaySettings.PlayOnEntry
                    )
                    matching_effects = []
                    sequence = slide.TimeLine.MainSequence
                    for effect_index in range(1, int(sequence.Count) + 1):
                        effect = sequence(effect_index)
                        with suppress(Exception):
                            if (
                                int(effect.Shape.Id) == int(audio_shape.Id)
                                and int(effect.EffectType) == MEDIA_PLAY_EFFECT
                            ):
                                matching_effects.append(effect)
                    if not play_on_entry:
                        errors.append(f"第 {slide_index} 页音频未开启进入时播放")
                    if not matching_effects:
                        errors.append(f"第 {slide_index} 页缺少音频播放动画")
                    elif not any(
                        int(effect.Timing.TriggerType) == TRIGGER_WITH_PREVIOUS
                        for effect in matching_effects
                    ):
                        errors.append(f"第 {slide_index} 页音频播放动画不是自动触发")
                transition = slide.SlideShowTransition
                advance_time = float(transition.AdvanceTime)
                timings.append(advance_time)
                if slide_index in expected and not bool(transition.AdvanceOnTime):
                    errors.append(f"第 {slide_index} 页未开启定时翻页")
                if slide_index in expected and advance_time <= 0:
                    errors.append(f"第 {slide_index} 页翻页时间无效")
            if int(presentation.SlideShowSettings.AdvanceMode) != 2:
                errors.append("演示文稿未使用幻灯片计时")
            return ValidationResult(not errors, slide_count, tuple(errors), tuple(timings))
        except Exception as exc:
            raise PowerPointError(f"PowerPoint 验证失败：{exc}") from exc
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
