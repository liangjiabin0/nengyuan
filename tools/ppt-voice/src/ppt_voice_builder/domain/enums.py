from enum import StrEnum


class TaskStatus(StrEnum):
    PENDING = "pending"
    NOTES_READY = "notes_ready"
    GENERATING = "generating"
    AUDIO_READY = "audio_ready"
    EMBEDDED = "embedded"
    VERIFIED = "verified"
    FAILED = "failed"


class EmptyNotePolicy(StrEnum):
    ERROR = "error"
    SKIP = "skip"
