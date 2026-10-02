from __future__ import annotations

import json
import math
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from ..config import MAX_RESULT_POINTS, MODELICA_VERSION


def ascii_work_dir(job_dir: Path) -> Path:
    try:
        str(job_dir.resolve()).encode("ascii")
        return job_dir
    except UnicodeEncodeError:
        pass
    root = Path(os.environ.get("TEMP") or tempfile.gettempdir()) / "om-gateway-jobs"
    root.mkdir(parents=True, exist_ok=True)
    work = root / job_dir.name
    work.mkdir(parents=True, exist_ok=True)
    return work


def downsample(values: list[float], max_points: int) -> list[float]:
    if max_points <= 0 or len(values) <= max_points:
        return values
    step = math.ceil(len(values) / max_points)
    return values[::step]


def _send(omc: Any, expr: str) -> Any:
    try:
        return omc.sendExpression(expr)
    except Exception:
        return None


def load_standard_library(omc: Any) -> bool:
    for expr in (
        f'loadModel(Modelica, {{"{MODELICA_VERSION}"}})',
        "loadModel(Modelica)",
        'loadModel(Modelica, {"3.2.3"})',
    ):
        result = _send(omc, expr)
        if result is True or str(result).lower() in {"true", "ok"}:
            return True
    return False


def check_model(model_name: str, code: str, job_dir: Path) -> dict[str, Any]:
    work_dir = ascii_work_dir(job_dir)
    model_path = work_dir / "model.mo"
    model_path.write_text(code, encoding="utf-8")
    try:
        from OMPython import OMCSessionZMQ
    except Exception as exc:
        return {
            "ok": False,
            "model_name": model_name,
            "check_ok": False,
            "compiler_messages": [f"OMPython 不可用：{exc}"],
        }
    try:
        omc = OMCSessionZMQ()
    except Exception as exc:
        return {
            "ok": False,
            "model_name": model_name,
            "check_ok": False,
            "compiler_messages": [f"无法连接 OpenModelica：{exc}"],
        }
    try:
        load_standard_library(omc)
        loaded = omc.sendExpression(f'loadFile("{model_path.as_posix()}")')
        checked = omc.sendExpression(f"checkModel({model_name})")
        errors = omc.sendExpression("getErrorString()")
        ok = bool(loaded) and "successfully" in str(checked).lower() or bool(checked)
        return {
            "ok": bool(ok),
            "model_name": model_name,
            "check_ok": bool(ok),
            "check_message": str(checked),
            "compiler_messages": [str(errors)] if errors else [],
        }
    except Exception as exc:
        return {
            "ok": False,
            "model_name": model_name,
            "check_ok": False,
            "compiler_messages": [f"checkModel 异常：{exc}"],
        }
    finally:
        try:
            omc.sendExpression("quit()")
        except Exception:
            pass


def simulate(payload: dict[str, Any], job_dir: Path) -> dict[str, Any]:
    from OMPython import ModelicaSystem

    model = payload["model"]
    options = payload.get("options") or {}
    parameters = payload.get("parameters") or {}
    outputs = payload.get("outputs") or ["time"]
    max_points = int(payload.get("max_points") or MAX_RESULT_POINTS)
    work_dir = ascii_work_dir(job_dir)
    model_path = work_dir / "model.mo"
    model_path.write_text(model["modelica_code"], encoding="utf-8")
    (job_dir / "request.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    try:
        system = ModelicaSystem(str(model_path), model["model_name"], ["Modelica"])
    except Exception:
        system = ModelicaSystem(str(model_path), model["model_name"], [])
    try:
        if parameters:
            system.setParameters([f"{key}={value}" for key, value in parameters.items()])
        system.setSimulationOptions(
            [
                f"startTime={options.get('start_time', 0)}",
                f"stopTime={options.get('stop_time', 1)}",
                f"stepSize={(float(options.get('stop_time', 1)) - float(options.get('start_time', 0))) / max(int(options.get('number_of_intervals', 500)), 1)}",
                f"tolerance={options.get('tolerance', 1e-6)}",
                f"solver={options.get('solver', 'dassl')}",
            ]
        )
        system.simulate()
    except UnicodeDecodeError as exc:
        raise RuntimeError(
            f"OpenModelica 读取模型或结果失败（编码 {exc.encoding}）。请把仿真工作目录放到纯英文路径，或设置 OMG_DATA_DIR。"
        ) from exc
    available = list(system.getQuantities() or [])
    names = [item.get("name") if isinstance(item, dict) else str(item) for item in available]
    requested = [name for name in outputs if name in names or name == "time"]
    if "time" not in requested:
        requested = ["time", *requested]
    solutions = system.getSolutions(requested)
    series: dict[str, list[float]] = {}
    if isinstance(solutions, dict):
        for key, values in solutions.items():
            series[key] = downsample([float(v) for v in list(values)], max_points)
    else:
        for index, key in enumerate(requested):
            values = solutions[index] if index < len(solutions) else []
            series[key] = downsample([float(v) for v in list(values)], max_points)
    result = {
        "model_name": model["model_name"],
        "parameters_applied": parameters,
        "available_variables": names,
        "missing_requested_outputs": [name for name in outputs if name not in series],
        "series": series,
        "artifacts": {"model": "model.mo", "result": "result.mat"},
    }
    (job_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if work_dir != job_dir:
        for name in ("model.mo", "result.mat"):
            src = work_dir / name
            if src.exists():
                shutil.copy2(src, job_dir / name)
    return result
