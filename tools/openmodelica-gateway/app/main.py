from __future__ import annotations

import os
import shutil
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse

from .config import API_KEY, MAX_CODE_BYTES, MAX_RESULT_POINTS, MAX_WORKERS, MODELICA_VERSION
from .job_store import STORE
from .schemas import CheckRequest, JobAccepted, SimulationRequest
from .security import require_api_key
from .services.openmodelica import check_model
from .services.runner import executor, run_simulation_job

app = FastAPI(title="OpenModelica Agent Gateway", version="1.0.0")
SERVICE_NAME = "openmodelica-agent-gateway"


def _resolve_omc() -> str | None:
    configured = os.environ.get("OPENMODELICA_OMC", "").strip()
    if configured:
        path = Path(configured)
        if path.is_file():
            return str(path)
    found = shutil.which("omc")
    return found


@app.get("/health")
def health():
    omc_path = _resolve_omc()
    ompython = False
    ompython_error = ""
    try:
        import OMPython  # noqa: F401

        ompython = True
    except Exception as exc:
        ompython_error = str(exc)
    ok = bool(ompython and omc_path)
    payload = {
        "ok": ok,
        "service": SERVICE_NAME,
        "ompython": ompython,
        "omc": bool(omc_path),
        "omcPath": omc_path,
        "modelica": MODELICA_VERSION,
    }
    if ompython_error:
        payload["error"] = ompython_error
    elif not omc_path:
        payload["error"] = "omc 未安装或不在 PATH。设置 OPENMODELICA_OMC 或安装 OpenModelica。"
    return payload


@app.get("/v1/info")
def info(_: None = Depends(require_api_key)):
    return {
        "service": SERVICE_NAME,
        "openmodelica_target": "1.27.0",
        "msl": MODELICA_VERSION,
        "max_workers": MAX_WORKERS,
        "max_code_bytes": MAX_CODE_BYTES,
        "max_result_points": MAX_RESULT_POINTS,
        "omc": _resolve_omc(),
    }


@app.post("/v1/models/check")
def check(req: CheckRequest, _: None = Depends(require_api_key)):
    if len(req.model.modelica_code.encode("utf-8")) > MAX_CODE_BYTES:
        raise HTTPException(status_code=413, detail="modelica_code too large")
    job = STORE.create(req.model.model_dump())
    try:
        return check_model(req.model.model_name, req.model.modelica_code, Path(job["dir"]))
    except Exception as exc:
        return {
            "ok": False,
            "model_name": req.model.model_name,
            "check_ok": False,
            "compiler_messages": [f"checkModel 异常：{exc}"],
        }


@app.post("/v1/simulations", status_code=202)
def simulate(req: SimulationRequest, _: None = Depends(require_api_key)):
    if len(req.model.modelica_code.encode("utf-8")) > MAX_CODE_BYTES:
        raise HTTPException(status_code=413, detail="modelica_code too large")
    job = STORE.create(req.model_dump())
    executor().submit(run_simulation_job, job["job_id"], req.model_dump())
    return JobAccepted(
        job_id=job["job_id"],
        status="queued",
        status_url=f"/v1/jobs/{job['job_id']}",
        result_url=f"/v1/jobs/{job['job_id']}/result",
    )


@app.get("/v1/jobs/{job_id}")
def job_status(job_id: str, _: None = Depends(require_api_key)):
    job = STORE.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return {"job_id": job_id, "status": job["status"], "error": job.get("error")}


@app.get("/v1/jobs/{job_id}/result")
def job_result(job_id: str, _: None = Depends(require_api_key)):
    job = STORE.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    if job["status"] != "succeeded":
        raise HTTPException(status_code=409, detail={"status": job["status"], "error": job.get("error")})
    return job["result"]


@app.get("/v1/jobs/{job_id}/artifacts/{name}")
def artifact(job_id: str, name: str, _: None = Depends(require_api_key)):
    allowed = {"model.mo", "result.mat", "request.json", "result.json", "error.txt"}
    if name not in allowed:
        raise HTTPException(status_code=400, detail="artifact not allowed")
    path = STORE.dir_of(job_id) / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="artifact missing")
    return FileResponse(path)


def create_app():
    return app


if __name__ == "__main__":
    import uvicorn

    from .config import HOST, PORT

    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=False)
