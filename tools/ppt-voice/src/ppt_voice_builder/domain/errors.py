class PptVoiceError(Exception):
    """Base exception with a user-safe message."""


class ConfigurationError(PptVoiceError):
    pass


class PreflightError(PptVoiceError):
    pass


class BailianError(PptVoiceError):
    def __init__(self, message: str, *, request_id: str | None = None) -> None:
        self.request_id = request_id
        suffix = f"（request_id={request_id}）" if request_id else ""
        super().__init__(f"{message}{suffix}")


class AuthenticationError(BailianError):
    pass


class ResponseFormatError(BailianError):
    pass


class AudioValidationError(PptVoiceError):
    pass


class PowerPointError(PptVoiceError):
    pass


class ValidationError(PptVoiceError):
    pass
