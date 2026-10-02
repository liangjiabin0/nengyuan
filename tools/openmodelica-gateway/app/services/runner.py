from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any

from ..config import MAX_WORKERS
from ..job_store import STORE
from .openmodelica import check_model, simulate


_EXECUTOR: ThreadPoolExecutor | None = None


def executor() -> ThreadPoolExecutor:
    global _EXECUTOR
    if _EXECUTOR is None:
        _EXECUTOR = ThreadPoolExecutor(max_workers=MAX_WORKERS)
    return _EXECUTOR


def run_check(model_name: str, code: str, job_dir: str) -> dict[str, Any]:
    from pathlib import Path

    return check_model(model_name, code, Path(job_dir))


def run_simulation_job(job_id: str, payload: dict[str, Any]) -> None:
    STORE.update(job_id, status="running")
    try:
        result = simulate(payload, STORE.dir_of(job_id))
        STORE.update(job_id, status="succeeded", result=result, error=None)
    except Exception as exc:
        error_path = STORE.dir_of(job_id) / "error.txt"
        error_path.write_text(str(exc), encoding="utf-8")
        STORE.update(job_id, status="failed", error=str(exc))
