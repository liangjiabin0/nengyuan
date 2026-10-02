from ppt_voice_builder.audio.cache import AudioCache, build_cache_key
from ppt_voice_builder.audio.duration import validate_mp3
from ppt_voice_builder.bailian.client import BailianClient
from ppt_voice_builder.config.models import Settings
from ppt_voice_builder.domain.models import AudioArtifact, SynthesisRequest


class AudioSynthesizer:
    def __init__(self, client: BailianClient, settings: Settings, cache: AudioCache) -> None:
        self.client = client
        self.settings = settings
        self.cache = cache

    def synthesize_slide(
        self,
        slide_index: int,
        text: str,
        pronunciation_hash: str,
    ) -> AudioArtifact:
        voice_id = self.settings.voice.voice_id
        if not voice_id:
            raise ValueError("未配置 voice_id")
        cache_key = build_cache_key(
            normalized_text=text,
            model=self.settings.bailian.model,
            voice_id=voice_id,
            instruction=self.settings.voice.instruction,
            rate=self.settings.voice.rate,
            pitch=self.settings.voice.pitch,
            volume=self.settings.voice.volume,
            seed=self.settings.voice.seed,
            sample_rate=self.settings.bailian.sample_rate,
            pronunciation_hash=pronunciation_hash,
        )
        cached = self.cache.lookup(cache_key)
        if cached is not None:
            try:
                return AudioArtifact(slide_index, cache_key, cached, validate_mp3(cached), "cache")
            except Exception:
                cached.unlink(missing_ok=True)
        request = SynthesisRequest(
            text=text,
            model=self.settings.bailian.model,
            voice_id=voice_id,
            instruction=self.settings.voice.instruction,
            rate=self.settings.voice.rate,
            pitch=self.settings.voice.pitch,
            volume=self.settings.voice.volume,
            seed=self.settings.voice.seed,
            sample_rate=self.settings.bailian.sample_rate,
        )
        response = self.client.synthesize(request)
        staged = self.cache.staging_path(cache_key)
        try:
            self.client.download_audio(response.audio_url, staged)
            duration = validate_mp3(staged)
            final_path = self.cache.commit(cache_key, staged)
        finally:
            staged.unlink(missing_ok=True)
        return AudioArtifact(slide_index, cache_key, final_path, duration, "generated")
