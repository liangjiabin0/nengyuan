import os
import random
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from ppt_voice_builder.bailian.response_parser import (
    parse_synthesis_response,
    parse_voice_design_response,
)
from ppt_voice_builder.domain.errors import AuthenticationError, BailianError, ResponseFormatError
from ppt_voice_builder.domain.models import SynthesisRequest, SynthesisResult, VoiceDesignResult

# CosyVoice 系统音色大多不支持 instruction；带上会被引擎以 428 拒绝。
VOICES_WITHOUT_INSTRUCTION = {
    "longshuo_v3",
    "longxiaochun_v3",
    "longhua_v3",
    "longshu_v3",
    "longxiaoxia_v3",
    "longanyang",
}


class BailianClient:
    def __init__(
        self,
        api_key: str,
        workspace_id: str | None,
        timeout_seconds: float,
        max_retries: int = 3,
        *,
        base_url: str | None = None,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not api_key:
            raise ValueError("api_key 不能为空")
        normalized_workspace_id = workspace_id.strip() if workspace_id else ""
        self.base_url = (
            f"https://{normalized_workspace_id}.cn-beijing.maas.aliyuncs.com"
            if normalized_workspace_id
            else "https://dashscope.aliyuncs.com"
        )
        if base_url:
            from urllib.parse import urlsplit
            parsed = urlsplit(base_url.strip())
            if parsed.scheme not in {"https", "http"} or not parsed.netloc or parsed.username or parsed.password:
                raise ValueError("BAILIAN_BASE_URL 必须为有效的 HTTP(S) 服务地址")
            # The TTS endpoint uses /api/v1, not the OpenAI compatible-mode path.
            self.base_url = base_url.strip().rstrip("/")
            for suffix in ("/compatible-mode/v1", "/api/v1"):
                if self.base_url.endswith(suffix):
                    self.base_url = self.base_url[:-len(suffix)]
        self.max_retries = max_retries
        self._sleep = sleep
        self.request_count = 0
        self.retry_events: list[str] = []
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            timeout=timeout_seconds,
            transport=transport,
            follow_redirects=True,
        )
        self._download_client = httpx.Client(
            timeout=timeout_seconds,
            transport=transport,
            follow_redirects=True,
        )

    def __enter__(self) -> "BailianClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()
        self._download_client.close()

    @staticmethod
    def _error_details(response: httpx.Response) -> tuple[str, str | None]:
        try:
            data = response.json()
        except ValueError:
            return f"HTTP {response.status_code}", None
        if not isinstance(data, dict):
            return f"HTTP {response.status_code}", None
        code = data.get("code") or data.get("error_code") or f"HTTP {response.status_code}"
        message = data.get("message") or data.get("error_message") or "请求失败"
        request_id = data.get("request_id")
        return f"{code}: {message}", request_id if isinstance(request_id, str) else None

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        for attempt in range(1, self.max_retries + 1):
            self.request_count += 1
            try:
                response = self._client.post(path, json=payload)
            except (httpx.ConnectError, httpx.ReadTimeout, httpx.WriteTimeout) as exc:
                if attempt >= self.max_retries:
                    raise BailianError("连接百炼服务失败") from exc
                self.retry_events.append(f"连接失败，第 {attempt} 次请求后重试")
                self._sleep(min(2 ** (attempt - 1) + random.random(), 30))
                continue
            if response.status_code < 400:
                try:
                    data = response.json()
                except ValueError as exc:
                    raise ResponseFormatError("百炼返回了非 JSON 响应") from exc
                if not isinstance(data, dict):
                    raise ResponseFormatError("百炼响应顶层不是 JSON 对象")
                return data
            details, request_id = self._error_details(response)
            if response.status_code in (401, 403):
                raise AuthenticationError(details, request_id=request_id)
            retryable = response.status_code == 429 or response.status_code in (500, 502, 503, 504)
            if not retryable or attempt >= self.max_retries:
                raise BailianError(details, request_id=request_id)
            self.retry_events.append(f"HTTP {response.status_code}，第 {attempt} 次请求后重试")
            retry_after = response.headers.get("Retry-After")
            try:
                delay = float(retry_after) if retry_after is not None else 2 ** (attempt - 1)
            except ValueError:
                delay = 2 ** (attempt - 1)
            self._sleep(min(max(delay, 0), 60))
        raise AssertionError("unreachable")

    def create_voice_by_design(
        self,
        *,
        target_model: str,
        prefix: str,
        voice_prompt: str,
        preview_text: str,
    ) -> VoiceDesignResult:
        payload = {
            "model": "voice-enrollment",
            "input": {
                "action": "create_voice",
                "target_model": target_model,
                "voice_prompt": voice_prompt,
                "preview_text": preview_text,
                "prefix": prefix,
                "language_hints": ["zh"],
            },
            "parameters": {"sample_rate": 24_000, "response_format": "mp3"},
        }
        return parse_voice_design_response(
            self._post("/api/v1/services/audio/tts/customization", payload),
            requested_target_model=target_model,
        )

    def synthesize(self, request: SynthesisRequest) -> SynthesisResult:
        input_data: dict[str, Any] = {
            "text": request.text,
            "voice": request.voice_id,
            "format": "mp3",
            "sample_rate": request.sample_rate,
            "volume": request.volume,
            "rate": request.rate,
            "pitch": request.pitch,
            "seed": request.seed,
            "language_hints": ["zh"],
        }
        if request.instruction and request.voice_id not in VOICES_WITHOUT_INSTRUCTION:
            input_data["instruction"] = request.instruction
        payload = {"model": request.model, "input": input_data}
        try:
            return parse_synthesis_response(
                self._post("/api/v1/services/audio/tts/SpeechSynthesizer", payload)
            )
        except BailianError as exc:
            if "instruction" in input_data and "428" in str(exc):
                input_data.pop("instruction", None)
                return parse_synthesis_response(
                    self._post("/api/v1/services/audio/tts/SpeechSynthesizer", payload)
                )
            raise

    def download_audio(self, url: str, destination: Path) -> Path:
        destination = destination.resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".part")
        try:
            with self._download_client.stream("GET", url) as response:
                response.raise_for_status()
                with temporary.open("wb") as stream:
                    for chunk in response.iter_bytes():
                        stream.write(chunk)
                    stream.flush()
                    os.fsync(stream.fileno())
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
        return destination
