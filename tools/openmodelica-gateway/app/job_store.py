from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .config import DATA_DIR


class JobStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        DATA_DIR.mkdir(parents=True, exist_ok=True)

    def create(self, request: dict[str, Any]) -> dict[str, Any]:
        job_id = uuid.uuid4().hex
        job_dir = DATA_DIR / "jobs" / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        job = {
            "job_id": job_id,
            "status": "queued",
            "created_at": time.time(),
            "dir": str(job_dir),
            "request": request,
            "result": None,
            "error": None,
        }
        with self._lock:
            self._jobs[job_id] = job
        return job

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None

    def update(self, job_id: str, **fields: Any) -> None:
        with self._lock:
            if job_id in self._jobs:
                self._jobs[job_id].update(fields)

    def dir_of(self, job_id: str) -> Path:
        job = self.get(job_id)
        if not job:
            raise KeyError(job_id)
        return Path(job["dir"])


STORE = JobStore()
