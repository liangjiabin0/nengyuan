"""Optional Linux adapter for the official ESOPT SDK (never substitutes a license)."""
from __future__ import annotations

import functools
import json
import os
import subprocess
from pathlib import Path
from typing import Any

from . import paths


def install_dir() -> Path:
    return Path(os.environ.get("ESOPT_NATIVE_HOME") or paths.workspace_root() / "upstream-linux").expanduser().resolve()


def executable() -> Path:
    return install_dir() / "bin" / "esopt-native"


def highs_library() -> Path:
    return install_dir() / "deps" / "highs" / "lib" / "libhighs.so"


def license_configured() -> bool:
    value = os.environ.get("LICENSE_LOCATION", "")
    return bool(value and Path(value).is_file())


def run(spec: dict[str, Any], timeout: int = 120) -> dict[str, Any]:
    payload = {**spec, "highs_lib": str(highs_library()), "time_limit": timeout}
    aliases = {"bin": "binary", "bool": "binary", "int": "integer", "integ": "integer"}
    payload["variables"] = [{**var, "domain": aliases.get(str(var.get("domain") or var.get("type") or "continuous").lower(),
                            str(var.get("domain") or var.get("type") or "continuous").lower())}
                            for var in spec.get("variables") or []]
    completed = subprocess.run([str(executable())], input=json.dumps(payload), text=True,
                               capture_output=True, timeout=timeout + 10)
    # ESOPT license/PSLP diagnostics are non-JSON lines; only our adapter emits JSON.
    result = None
    for line in reversed(completed.stdout.splitlines()):
        try:
            candidate = json.loads(line)
            if isinstance(candidate, dict):
                result = candidate
                break
        except json.JSONDecodeError:
            continue
    if result is None or completed.returncode != 0 or result.get("error"):
        error = (result or {}).get("error") or (completed.stderr or completed.stdout)[-2000:]
        raise RuntimeError(f"ESOPT native failed (exit {completed.returncode}): {error}")
    result["license_mode"] = "configured_unverified" if license_configured() else "trial_300"
    if payload.get("pslp"):
        result["pslp_diagnostics"] = [line for line in completed.stdout.splitlines() if line.startswith("[PSLP]")][-12:]
    return result


@functools.lru_cache(maxsize=8)
def _probe(binary: str, stamp: int, library_stamp: int, license_stamp: int) -> dict[str, Any]:
    try:
        result = run({"variables": [{"name": "probe", "lb": 1, "ub": 2}],
                      "constraints": [], "objective": {"terms": [{"var": "probe", "coef": 1}]}}, 10)
        return {"ready": result.get("ok") is True and abs(result.get("objective", 0) - 1) < 1e-8,
                "detail": "Native ESOPT + HiGHS probe passed"}
    except Exception as error:
        return {"ready": False, "detail": str(error)}


def installation() -> dict[str, Any]:
    exe, library = executable(), highs_library()
    license_file = Path(os.environ.get("LICENSE_LOCATION", "/nonexistent-esopt-license"))
    state = {"ready": False, "detail": "Native ESOPT has not been installed"}
    if exe.is_file() and library.is_file():
        state = _probe(str(exe), exe.stat().st_mtime_ns, library.stat().st_mtime_ns,
                       license_file.stat().st_mtime_ns if license_file.is_file() else 0)
    return {**state, "executable": str(exe), "highs_library": str(library),
            "license_configured": license_configured(), "license_validated": False,
            "unlicensed_variable_limit": 300, "unlicensed_constraint_limit": 300,
            "upstream": "https://github.com/yuntaoju2022/smart-energy-system",
            "upstream_commit": "38d7df0e679d93da848e05f30327a4f2a56dc60b"}


def solve(spec: dict[str, Any], timeout: int = 120) -> dict[str, Any]:
    from .highspy_backend import solve_linear_spec
    mode = os.environ.get("ESOPT_BACKEND", "auto").lower()
    if mode not in {"auto", "native", "highspy"}:
        raise ValueError("ESOPT_BACKEND must be auto, native or highspy")
    pslp = bool(spec.get("pslp"))
    if mode == "highspy" and pslp:
        raise RuntimeError("PSLP requires the native ESOPT backend")
    reason = ""
    ready = installation()["ready"] if mode != "highspy" else False
    nvars = len(spec.get("variables") or [])
    ncons = len(spec.get("constraints") or [])
    # File presence is not proof of a valid license. Larger licensed models still
    # pass through ESOPT's own authorization check in the subprocess.
    if ready and not license_configured() and (nvars > 300 or ncons > 300):
        reason = f"ESOPT trial limit exceeded ({nvars} variables, {ncons} constraints); full license required"
    elif ready:
        return run(spec, timeout)
    else:
        reason = "Native ESOPT unavailable" if mode != "highspy" else "HiGHS explicitly selected"
    if mode == "native" or pslp:
        raise RuntimeError(reason)
    result = solve_linear_spec(spec, timeout)
    result["backend_selection_reason"] = reason
    result["engine"] = "highs"
    return result
