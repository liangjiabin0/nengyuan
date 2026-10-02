from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from . import guide, paths
from .expr import ExprError, parse_linear


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if not text:
        raise RuntimeError("esoptc produced empty output")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end < start:
            raise RuntimeError(f"esoptc output is not JSON:\n{text[-2000:]}")
        return json.loads(text[start : end + 1])


def _run_esoptc(args: list[str], stdin_text: str | None = None, timeout: int = 600) -> dict[str, Any]:
    paths.ensure_runtime_path()
    exe = paths.esoptc_exe()
    if not exe.exists():
        raise FileNotFoundError(f"esoptc not found: {exe}. Build work/DCOPF first.")
    env = os.environ.copy()
    completed = subprocess.run(
        [str(exe), *args],
        input=stdin_text,
        text=True,
        capture_output=True,
        cwd=str(paths.dcopf_dir()),
        env=env,
        timeout=timeout,
    )
    payload = None
    if completed.stdout.strip():
        try:
            payload = _extract_json(completed.stdout)
        except Exception:
            payload = None
    if completed.returncode not in (0, 2):
        err = (completed.stderr or completed.stdout or "").strip()
        if payload and payload.get("error"):
            raise RuntimeError(payload["error"])
        raise RuntimeError(err or f"esoptc exited with {completed.returncode}")
    if payload is None:
        raise RuntimeError(completed.stderr or completed.stdout or "esoptc returned no JSON")
    return payload


def _case_aliases() -> dict[str, Path]:
    mapping: dict[str, Path] = {}
    folder = paths.cases_dir()
    if not folder.exists():
        return mapping
    for file in sorted(folder.glob("*.json")):
        stem = file.stem
        mapping[stem.lower()] = file
        mapping[file.name.lower()] = file
        compact = stem.replace("pglib_opf_", "").replace("case", "")
        mapping[compact.lower()] = file
        num = re.search(r"case(\d+)", stem)
        if num:
            mapping[num.group(1)] = file
            mapping[f"case{num.group(1)}"] = file
    return mapping


def resolve_case(name: str) -> Path:
    raw = Path(name)
    if raw.exists():
        return raw.resolve()
    here = paths.cases_dir() / name
    if here.exists():
        return here.resolve()
    if not name.endswith(".json"):
        guess = paths.cases_dir() / f"{name}.json"
        if guess.exists():
            return guess.resolve()
        prefixed = paths.cases_dir() / f"pglib_opf_{name}.json"
        if prefixed.exists():
            return prefixed.resolve()
    aliases = _case_aliases()
    key = name.lower().removesuffix(".json")
    if key in aliases:
        return aliases[key].resolve()
    available = ", ".join(sorted({p.stem for p in aliases.values()}))
    raise FileNotFoundError(f"Unknown case '{name}'. Available: {available}")


def list_cases() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    folder = paths.cases_dir()
    if not folder.exists():
        return items
    for file in sorted(folder.glob("*.json")):
        size = file.stat().st_size
        item: dict[str, Any] = {
            "ok": True,
            "name": file.stem,
            "path": str(file),
            "size_mb": round(size / (1024 * 1024), 3),
            "aliases": [file.stem, file.name],
        }
        num = re.search(r"case(\d+)", file.stem)
        if num:
            item["aliases"].extend([num.group(1), f"case{num.group(1)}"])
        if size < 2_000_000:
            item.update({k: v for k, v in inspect_case(str(file), light=True).items() if k not in item})
        items.append(item)
    return items


def inspect_case(name: str, light: bool = False) -> dict[str, Any]:
    path = resolve_case(name)
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    buses = data.get("bus", [])
    gens = data.get("gen", [])
    branches = data.get("branch", [])
    arcs = data.get("arc", [])
    load = 0.0
    if buses and "pd" in buses[0]:
        load = sum(float(b.get("pd", 0.0)) for b in buses)
    elif "load" in data:
        load = sum(float(ld.get("pd", 0.0)) for ld in data["load"])
    pmin = [float(x) for x in data.get("pmin", [])]
    pmax = [float(x) for x in data.get("pmax", [])]
    result = {
        "ok": True,
        "name": path.stem,
        "path": str(path),
        "buses": len(buses),
        "branches": len(branches),
        "generators": len(gens),
        "arcs": len(arcs),
        "total_load": load,
        "pmin_sum": sum(pmin) if pmin else None,
        "pmax_sum": sum(pmax) if pmax else None,
        "ref_buses": data.get("ref_buses", []),
    }
    if not light:
        result["generator_buses"] = [g.get("bus") for g in gens]
        result["has_load_table"] = "load" in data
    return result


def solve_dcopf(
    case: str,
    pslp: bool = False,
    highs_pre: bool = True,
    with_generators: bool = True,
    timeout: int = 600,
) -> dict[str, Any]:
    case_path = resolve_case(case)
    native = paths.esoptc_exe().exists() and paths.highs_dll().exists()
    if native:
        args = [
            "dcopf",
            "--case",
            paths.native_path(case_path),
            "--json",
            "--pslp",
            "on" if pslp else "off",
            "--highs_pre",
            "on" if highs_pre else "off",
            "--highs-lib",
            paths.native_path(paths.highs_dll()),
        ]
        if not with_generators:
            args.append("--no-generators")
        try:
            result = _run_esoptc(args, timeout=timeout)
            result["case_name"] = case_path.stem
            return result
        except Exception:
            if pslp:
                raise
    from .highspy_backend import solve_dcopf_case

    result = solve_dcopf_case(case_path, timeout=timeout)
    if pslp:
        result["pslp"] = False
        result["note"] = (result.get("note") or "") + "；PSLP 仅在原生 esoptc 上可用"
    return result


def _expand_expr_fields(spec: dict[str, Any]) -> dict[str, Any]:
    out = dict(spec)
    constraints = []
    for con in out.get("constraints") or []:
        item = dict(con)
        if "expr" in item and "terms" not in item:
            parsed = parse_linear(item["expr"])
            item["terms"] = parsed["terms"]
            if parsed["sense"]:
                item.setdefault("sense", parsed["sense"])
                item.setdefault("rhs", parsed["rhs"])
        constraints.append(item)
    out["constraints"] = constraints
    obj = dict(out.get("objective") or {})
    if "expr" in obj and "terms" not in obj:
        parsed = parse_linear(obj["expr"])
        obj["terms"] = parsed["terms"]
        obj.setdefault("sense", parsed["obj_sense"])
    out["objective"] = obj
    return out


def solve_model(model: dict[str, Any] | str, timeout: int = 120) -> dict[str, Any]:
    if isinstance(model, str):
        path = Path(model)
        if path.exists() and path.suffix.lower() in {".mps", ".lp"}:
            return solve_mps(str(path), timeout=timeout)
        if path.exists():
            model = json.loads(path.read_text(encoding="utf-8"))
        else:
            model = json.loads(model)
    spec = _expand_expr_fields(dict(model))
    spec.setdefault("highs_lib", paths.native_path(paths.highs_dll()))
    if paths.esoptc_exe().exists() and paths.highs_dll().exists():
        try:
            return _run_esoptc(["model", "--stdin"], stdin_text=json.dumps(spec), timeout=timeout)
        except Exception:
            pass
    from .highspy_backend import solve_linear_spec

    return solve_linear_spec(spec, timeout=timeout)


def _ascii_safe_copy(src: Path) -> Path:
    try:
        str(src.resolve()).encode("ascii")
        return src.resolve()
    except UnicodeEncodeError:
        import hashlib
        import tempfile

        digest = hashlib.sha256(str(src.resolve()).encode("utf-8", "ignore")).hexdigest()[:16]
        dest = Path(tempfile.gettempdir()) / "esopt-mps" / f"{digest}{src.suffix.lower()}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists() or dest.stat().st_size != src.stat().st_size:
            dest.write_bytes(src.read_bytes())
        return dest


_HIGHS_STATUS = {
    7: "optimal",
    8: "infeasible",
    9: "unbounded_or_infeasible",
    10: "unbounded",
    13: "time_limit",
    14: "iteration_limit",
}


def _mps_has_integer_markers(path: Path) -> bool:
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as handle:
            for index, line in enumerate(handle):
                if index > 400_000:
                    break
                if "INTORG" in line.upper():
                    return True
    except OSError:
        return False
    return False


def _select_mps_values(names: list[str], col_value: list[float], limit: int = 240) -> tuple[dict[str, float], int]:
    nonzero: list[tuple[str, float]] = []
    for index, raw in enumerate(col_value):
        value = float(raw)
        if abs(value) <= 1e-10:
            continue
        name = names[index] if index < len(names) and names[index] else f"x{index}"
        nonzero.append((name, value))
    semantic = [(name, value) for name, value in nonzero if not re.fullmatch(r"x\d+", name)]
    generic = [(name, value) for name, value in nonzero if re.fullmatch(r"x\d+", name)]
    semantic.sort(key=lambda item: abs(item[1]), reverse=True)
    generic.sort(key=lambda item: abs(item[1]), reverse=True)
    picked = semantic[: max(80, limit - 60)] + generic[:60]
    if len(picked) < min(limit, len(nonzero)):
        picked = (semantic + generic)[:limit]
    return {name: value for name, value in picked}, len(nonzero)


def _write_mps_solution(path: Path, names: list[str], col_value: list[float]) -> str:
    nonzero = {
        (names[index] if index < len(names) and names[index] else f"x{index}"): float(value)
        for index, value in enumerate(col_value)
        if abs(float(value)) > 1e-10
    }
    dest = path.with_name(f"{path.stem}.solution.json")
    dest.write_text(json.dumps(nonzero, ensure_ascii=False, indent=2), encoding="utf-8")
    return dest.name


def _pack_mps_result(
    status: int,
    objective: float,
    n_col: int,
    n_row: int,
    values: dict[str, float],
    path: Path,
    backend: str,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    label = _HIGHS_STATUS.get(status, f"status_{status}")
    payload = {
        "ok": status == 7,
        "success": status == 7,
        "engine": "esopt",
        "solver": "ESOPT / HiGHS",
        "backend": backend,
        "mode": "lp" if path.suffix.lower() == ".lp" else "mps",
        "modelFile": path.name,
        "termination_status": status,
        "status": label,
        "objective": objective,
        "n_variables": n_col,
        "n_constraints": n_row,
        "values": values,
        "command": "model",
    }
    if extra:
        payload.update(extra)
    return payload


def _solve_mps_highspy(path: Path, timeout: int) -> dict[str, Any] | None:
    try:
        import highspy  # type: ignore
    except Exception:
        return None
    highs = highspy.Highs()
    try:
        highs.setOptionValue("output_flag", False)
        highs.setOptionValue("log_to_console", False)
        if timeout and timeout > 0:
            highs.setOptionValue("time_limit", float(timeout))
    except Exception:
        pass
    read_status = highs.readModel(str(path))
    if int(read_status) == -1:
        raise RuntimeError(f"HiGHS 无法读取模型文件：{path.name}")
    highs.run()
    info = highs.getInfo()
    status = int(highs.getModelStatus())
    n_col = int(highs.getNumCol())
    n_row = int(highs.getNumRow())
    objective = float(getattr(info, "objective_function_value", highs.getObjectiveValue()))
    solution = highs.getSolution()
    col_value = [float(item) for item in (getattr(solution, "col_value", []) or [])]
    names: list[str] = []
    for index in range(len(col_value)):
        try:
            raw_name = highs.getColName(index)
            if isinstance(raw_name, (tuple, list)):
                raw_name = raw_name[-1] if raw_name else None
            names.append(str(raw_name or "").strip() or f"x{index}")
        except Exception:
            names.append(f"x{index}")
    values, n_nonzero = _select_mps_values(names, col_value)
    extra = {
        "n_nonzero": n_nonzero,
        "problemType": "mip" if _mps_has_integer_markers(path) else "lp",
        "solutionFile": _write_mps_solution(path, names, col_value),
    }
    try:
        extra["mip_gap"] = float(highs.getInfoValue("mip_gap"))
    except Exception:
        pass
    return _pack_mps_result(status, objective, n_col, n_row, values, path, "highspy", extra)


def _solve_mps_dll(path: Path, timeout: int) -> dict[str, Any] | None:
    import ctypes

    paths.ensure_runtime_path()
    dll = paths.highs_dll()
    if not dll.exists():
        return None
    lib = ctypes.CDLL(str(dll))
    lib.Highs_create.restype = ctypes.c_void_p
    lib.Highs_destroy.argtypes = [ctypes.c_void_p]
    lib.Highs_readModel.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    lib.Highs_readModel.restype = ctypes.c_int
    lib.Highs_run.argtypes = [ctypes.c_void_p]
    lib.Highs_run.restype = ctypes.c_int
    lib.Highs_getModelStatus.argtypes = [ctypes.c_void_p]
    lib.Highs_getModelStatus.restype = ctypes.c_int
    lib.Highs_getObjectiveValue.argtypes = [ctypes.c_void_p]
    lib.Highs_getObjectiveValue.restype = ctypes.c_double
    lib.Highs_getNumCol.argtypes = [ctypes.c_void_p]
    lib.Highs_getNumCol.restype = ctypes.c_int
    lib.Highs_getNumRow.argtypes = [ctypes.c_void_p]
    lib.Highs_getNumRow.restype = ctypes.c_int
    lib.Highs_setBoolOptionValue.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    lib.Highs_setDoubleOptionValue.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_double]
    lib.Highs_getSolution.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_double),
    ]
    lib.Highs_getColName.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_char_p]
    highs = lib.Highs_create()
    if not highs:
        return None
    try:
        lib.Highs_setBoolOptionValue(highs, b"output_flag", 0)
        if timeout and timeout > 0:
            lib.Highs_setDoubleOptionValue(highs, b"time_limit", float(timeout))
        native = paths.native_path(path)
        if lib.Highs_readModel(highs, native.encode("utf-8")) < 0:
            raise RuntimeError(f"HiGHS 无法读取模型文件：{path.name}")
        lib.Highs_run(highs)
        status = int(lib.Highs_getModelStatus(highs))
        objective = float(lib.Highs_getObjectiveValue(highs))
        n_col = int(lib.Highs_getNumCol(highs))
        n_row = int(lib.Highs_getNumRow(highs))
        values: dict[str, float] = {}
        extra: dict[str, Any] = {
            "n_nonzero": 0,
            "problemType": "mip" if _mps_has_integer_markers(path) else "lp",
        }
        if n_col > 0:
            col_value = (ctypes.c_double * n_col)()
            lib.Highs_getSolution(highs, col_value, None, None, None)
            names: list[str] = []
            name_buf = ctypes.create_string_buffer(512)
            for index in range(n_col):
                name = f"x{index}"
                try:
                    if lib.Highs_getColName(highs, index, name_buf) >= 0 and name_buf.value:
                        name = name_buf.value.decode("utf-8", "ignore") or name
                except Exception:
                    pass
                names.append(name)
            raw = [float(col_value[index]) for index in range(n_col)]
            values, n_nonzero = _select_mps_values(names, raw)
            extra["n_nonzero"] = n_nonzero
            extra["solutionFile"] = _write_mps_solution(path, names, raw)
        return _pack_mps_result(status, objective, n_col, n_row, values, path, "highs.dll", extra)
    finally:
        lib.Highs_destroy(highs)


def solve_mps(model: str, timeout: int = 3600) -> dict[str, Any]:
    src = Path(model)
    if not src.exists():
        raise FileNotFoundError(f"模型文件不存在：{src}")
    if src.suffix.lower() not in {".mps", ".lp"}:
        raise RuntimeError("只接受 .mps 或 .lp 文件。")
    path = _ascii_safe_copy(src)
    errors: list[str] = []
    for loader in (_solve_mps_highspy, _solve_mps_dll):
        try:
            result = loader(path, timeout)
            if result is not None:
                result["sourcePath"] = src.name
                sol_name = str(result.get("solutionFile") or "")
                if sol_name:
                    produced = path.with_name(sol_name)
                    dest = src.with_name(sol_name)
                    if produced.exists() and produced.resolve() != dest.resolve():
                        dest.write_bytes(produced.read_bytes())
                    if dest.exists():
                        result["solutionFile"] = dest.name
                return result
        except Exception as exc:
            errors.append(f"{loader.__name__}: {exc}")
    raise RuntimeError("无法用 HiGHS 读取 MPS/LP。" + (" " + "；".join(errors) if errors else " 未找到 highspy 或 highs.dll。"))


def _parse_log_objective(text: str) -> float | None:
    matches = re.findall(r"Objective value:\s*([0-9.eE+-]+)", text)
    if not matches:
        return None
    return float(matches[-1])


def compare_reference(case: str, objective: float | None = None) -> dict[str, Any]:
    case_path = resolve_case(case)
    stem = case_path.stem
    num = re.search(r"case(\d+)", stem)
    tag = num.group(1) if num else stem
    log_dir = paths.dcopf_dir()
    logs = {
        "highs": log_dir / f"case{tag}_highs.log",
        "pslp": log_dir / f"case{tag}_pslp.log",
        "pslp_highs": log_dir / f"case{tag}_pslp_highs.log",
    }
    refs: dict[str, Any] = {}
    for key, path in logs.items():
        if path.exists():
            refs[key] = {
                "path": str(path),
                "objective": _parse_log_objective(path.read_text(encoding="utf-8", errors="ignore")),
            }
    result = {"ok": True, "case": stem, "references": refs}
    if objective is not None:
        highs_obj = (refs.get("highs") or {}).get("objective")
        result["computed_objective"] = objective
        result["match_highs"] = highs_obj is not None and abs(highs_obj - objective) <= max(1e-4, 1e-6 * abs(highs_obj))
        result["highs_reference"] = highs_obj
    return result


def capabilities() -> dict[str, Any]:
    from .highspy_backend import highspy_available

    install = paths.esopt_install()
    highs = paths.highs_dll()
    exe = paths.esoptc_exe()
    hp = highspy_available()
    highs_ready = highs.exists() or hp
    headers = {
        "highs": (install / "include" / "model_highs.h").exists(),
        "ipopt": (install / "include" / "model_ipopt.h").exists(),
        "knitro": (install / "include" / "model_knitro.h").exists(),
        "gurobi": (install / "include" / "model_gurobi.h").exists(),
        "cplex": (install / "include" / "model_cplex.h").exists(),
    }
    return {
        "ok": True,
        "workspace": str(paths.workspace_root()),
        "esoptc": str(exe),
        "esoptc_ready": exe.exists(),
        "highs_dll": str(highs),
        "highs_ready": highs_ready,
        "highspy_ready": hp,
        "pslp_dll": str(install / "bin" / "libPSLP.dll"),
        "pslp_ready": (install / "bin" / "libPSLP.dll").exists(),
        "available_on_this_machine": {
            "dcopf_highs": (exe.exists() and highs.exists()) or hp,
            "generic_linear_model": (exe.exists() and highs.exists()) or hp,
            "mps_or_lp_file": highs.exists() or hp,
            "quadratic_or_nonlinear": False,
            "pslp_presolve": False,
            "note": "Native esoptc is Windows-only. Linux uses highspy for DCOPF / LP / MIP. PSLP and quadratic/NL remain unavailable without extra solvers.",
        },
        "solver_headers_present": headers,
        "api": {
            "variables": ["continuous", "integer", "binary", "lb", "ub", "start"],
            "constraints": ["linear terms", "sense <= >= ==", "optional lb/ub range"],
            "objective": ["linear minimize/maximize"],
            "dcopf": ["pg/va/p formulation", "power balance", "thermal limits", "generator outputs"],
        },
        "cases": [p.stem for p in sorted(paths.cases_dir().glob("*.json"))] if paths.cases_dir().exists() else [],
    }


def _session_path() -> Path:
    return Path(os.environ.get("ESOPT_SESSION", Path.home() / ".esopt_model_session.json"))


class ModelSession:
    def __init__(self) -> None:
        self.variables: list[dict[str, Any]] = []
        self.constraints: list[dict[str, Any]] = []
        self.objective: dict[str, Any] | None = None
        self.parameters: dict[str, Any] = {}
        self.last_result: dict[str, Any] | None = None

    @classmethod
    def load(cls) -> "ModelSession":
        path = _session_path()
        session = cls()
        if not path.exists():
            return session
        data = json.loads(path.read_text(encoding="utf-8"))
        session.variables = data.get("variables") or []
        session.constraints = data.get("constraints") or []
        session.objective = data.get("objective")
        session.parameters = data.get("parameters") or {}
        session.last_result = data.get("last_result")
        return session

    def save(self) -> None:
        path = _session_path()
        path.write_text(
            json.dumps(
                {
                    "variables": self.variables,
                    "constraints": self.constraints,
                    "objective": self.objective,
                    "parameters": self.parameters,
                    "last_result": self.last_result,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    def to_spec(self) -> dict[str, Any]:
        if not self.variables:
            raise RuntimeError("model has no variables")
        if self.objective is None:
            raise RuntimeError("model has no objective")
        spec: dict[str, Any] = {
            "variables": self.variables,
            "constraints": self.constraints,
            "objective": self.objective,
        }
        if self.parameters:
            spec["parameters"] = self.parameters
        return spec


def _session() -> ModelSession:
    return ModelSession.load()


def model_create() -> dict[str, Any]:
    session = ModelSession()
    session.save()
    return {"ok": True, "message": "empty model session created", "session": str(_session_path())}


def model_add_variable(
    name: str,
    lb: float | str | None = None,
    ub: float | str | None = None,
    domain: str = "continuous",
    start: float | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {"name": name, "domain": domain}
    if lb is not None:
        item["lb"] = lb
    if ub is not None:
        item["ub"] = ub
    if start is not None:
        item["start"] = start
    session = _session()
    session.variables = [v for v in session.variables if v["name"] != name]
    session.variables.append(item)
    session.save()
    return {"ok": True, "variable": item, "n_variables": len(session.variables)}


def model_add_constraint(
    terms: list[dict[str, Any]] | None = None,
    sense: str = "<=",
    rhs: float = 0.0,
    name: str = "",
    constant: float = 0.0,
    lb: float | str | None = None,
    ub: float | str | None = None,
    expr: str | None = None,
) -> dict[str, Any]:
    if expr:
        parsed = parse_linear(expr)
        terms = parsed["terms"]
        if parsed["sense"]:
            sense = parsed["sense"]
            rhs = parsed["rhs"]
    if not terms:
        raise ExprError("constraint needs terms or expr")
    item: dict[str, Any] = {"terms": terms, "sense": sense, "rhs": rhs}
    if name:
        item["name"] = name
    if constant:
        item["constant"] = constant
    if lb is not None:
        item["lb"] = lb
    if ub is not None:
        item["ub"] = ub
    session = _session()
    session.constraints.append(item)
    session.save()
    return {"ok": True, "constraint": item, "n_constraints": len(session.constraints)}


def model_set_objective(
    terms: list[dict[str, Any]] | None = None,
    sense: str = "minimize",
    constant: float = 0.0,
    expr: str | None = None,
) -> dict[str, Any]:
    if expr:
        parsed = parse_linear(expr)
        terms = parsed["terms"]
        sense = parsed["obj_sense"]
    if not terms:
        raise ExprError("objective needs terms or expr")
    session = _session()
    session.objective = {"terms": terms, "sense": sense, "constant": constant}
    session.save()
    return {"ok": True, "objective": session.objective}


def modeling_help(topic: str = "overview") -> dict[str, Any]:
    return guide.help_payload(topic)


def list_templates() -> dict[str, Any]:
    return guide.template_payload()


def load_template(name: str, solve: bool = False) -> dict[str, Any]:
    payload = guide.template_payload(name)
    if not payload.get("ok"):
        return payload
    model = payload["model"]
    session = ModelSession()
    session.variables = list(model.get("variables") or [])
    session.constraints = []
    for con in model.get("constraints") or []:
        item = dict(con)
        if "expr" in item and "terms" not in item:
            parsed = parse_linear(item["expr"])
            item["terms"] = parsed["terms"]
            if parsed["sense"]:
                item["sense"] = parsed["sense"]
                item["rhs"] = parsed["rhs"]
        session.constraints.append(item)
    obj = dict(model.get("objective") or {})
    if "expr" in obj and "terms" not in obj:
        parsed = parse_linear(obj["expr"])
        obj["terms"] = parsed["terms"]
        obj["sense"] = parsed["obj_sense"]
    session.objective = obj
    session.save()
    result: dict[str, Any] = {"ok": True, "loaded": name, "spec": session.to_spec()}
    if solve:
        result["solve"] = model_optimize()
    return result


def validate_model(spec: dict[str, Any] | None = None) -> dict[str, Any]:
    if spec is None:
        session = _session()
        spec = {
            "variables": session.variables,
            "constraints": session.constraints,
            "objective": session.objective or {},
        }
    model = _expand_expr_fields(spec)
    issues: list[str] = []
    names = [v.get("name") for v in model.get("variables") or []]
    if len(names) != len(set(names)):
        issues.append("duplicate variable names")
    if not names:
        issues.append("no variables")
    known = set(names)
    for v in model.get("variables") or []:
        lb, ub = v.get("lb"), v.get("ub")
        try:
            if lb is not None and ub is not None and float(lb) > float(ub):
                issues.append(f"{v.get('name')} has lb > ub")
        except (TypeError, ValueError):
            pass
    for i, con in enumerate(model.get("constraints") or []):
        for term in con.get("terms") or []:
            if term.get("var") not in known:
                issues.append(f"constraint {con.get('name', i)} uses unknown variable {term.get('var')}")
        if not con.get("terms"):
            issues.append(f"constraint {con.get('name', i)} has no terms")
    obj = model.get("objective") or {}
    if not obj.get("terms"):
        issues.append("objective has no terms")
    for term in obj.get("terms") or []:
        if term.get("var") not in known:
            issues.append(f"objective uses unknown variable {term.get('var')}")
    return {
        "ok": not issues,
        "issues": issues,
        "n_variables": len(names),
        "n_constraints": len(model.get("constraints") or []),
        "objective_sense": obj.get("sense"),
        "ready_to_solve": not issues,
    }


def model_set_parameter(name: str, value: Any) -> dict[str, Any]:
    session = _session()
    session.parameters[name] = value
    session.save()
    return {"ok": True, "parameters": session.parameters}


def model_get() -> dict[str, Any]:
    session = _session()
    return {
        "ok": True,
        "spec": {
            "variables": session.variables,
            "constraints": session.constraints,
            "objective": session.objective,
            "parameters": session.parameters,
        },
        "last_result": session.last_result,
    }


def model_optimize() -> dict[str, Any]:
    session = _session()
    result = solve_model(session.to_spec())
    session.last_result = result
    session.save()
    return result
