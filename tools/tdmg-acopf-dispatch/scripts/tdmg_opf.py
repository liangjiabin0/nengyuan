#!/usr/bin/env python3
"""Centralized transmission-distribution-microgrid AC-OPF runner.

The script accepts MATPOWER/PYPOWER cases, optionally augments them with
area/resource metadata, solves an AC OPF with PYPOWER, and writes auditable
machine-readable and human-readable results.
"""

from __future__ import annotations

import argparse
import copy
import csv
import json
import math
import re
import sys
from pathlib import Path
from typing import Any, Iterable


SCRIPT_DIR = Path(__file__).resolve().parent
VENDOR_DIR = SCRIPT_DIR / "_vendor"
if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))

try:
    import numpy as np
    from pypower.api import loadcase, ppoption, rundcopf, runopf
    from pypower.idx_brch import (
        BR_STATUS,
        F_BUS,
        PF,
        PT,
        QF,
        QT,
        RATE_A,
        T_BUS,
    )
    from pypower.idx_bus import (
        BASE_KV,
        BUS_AREA,
        BUS_I,
        BUS_TYPE,
        LAM_P,
        LAM_Q,
        PD,
        QD,
        VA,
        VM,
        VMAX,
        VMIN,
    )
    from pypower.idx_gen import (
        APF,
        PC1,
        PC2,
        QC1MAX,
        QC1MIN,
        QC2MAX,
        QC2MIN,
        GEN_BUS,
        GEN_STATUS,
        MBASE,
        PG,
        PMAX,
        PMIN,
        QG,
        QMAX,
        QMIN,
        VG,
    )
    from pypower.totcost import totcost
except Exception as exc:  # pragma: no cover - exercised by bootstrap failure
    raise SystemExit(
        "Missing solver dependencies. Run bootstrap.py with an available Python "
        f"interpreter. Import error: {exc}"
    ) from exc

import resource_models


MATRIX_NAMES = ("bus", "gen", "branch", "gencost")
MIN_COLS = {"bus": 13, "gen": 21, "branch": 13, "gencost": 4}


class InputError(ValueError):
    """Raised when a case or sidecar violates the supported schema."""


def _number_tokens(text: str) -> list[float]:
    pattern = re.compile(
        r"(?<![A-Za-z_])(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][-+]?\d+)?|[-+]?Inf|NaN)",
        re.IGNORECASE,
    )
    values: list[float] = []
    for token in pattern.findall(text):
        normalized = token.replace("D", "e").replace("d", "e")
        values.append(float(normalized))
    return values


def _remove_matlab_comments(text: str) -> str:
    text = re.sub(r"%\{.*?%\}", "", text, flags=re.DOTALL)
    return "\n".join(line.split("%", 1)[0] for line in text.splitlines())


def _parse_matlab_matrix(text: str, name: str) -> np.ndarray:
    match = re.search(
        rf"(?:mpc\.)?{re.escape(name)}\s*=\s*\[(.*?)\]\s*;",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    )
    if not match:
        raise InputError(f"MATPOWER file is missing matrix '{name}'.")
    body = match.group(1).replace("...", " ")
    raw_rows = body.split(";") if ";" in body else body.splitlines()
    rows = [_number_tokens(row) for row in raw_rows]
    rows = [row for row in rows if row]
    if not rows:
        raise InputError(f"MATPOWER matrix '{name}' is empty.")
    width = max(len(row) for row in rows)
    if name != "gencost" and any(len(row) != width for row in rows):
        raise InputError(f"MATPOWER matrix '{name}' has inconsistent row lengths.")
    padded = [row + [0.0] * (width - len(row)) for row in rows]
    return np.asarray(padded, dtype=float)


def parse_matpower_m(path: Path) -> dict[str, Any]:
    text = _remove_matlab_comments(path.read_text(encoding="utf-8", errors="replace"))
    unsupported_dc = re.search(
        r"(?:mpc\.)?(dcline|dcbus|dcbranch|busdc|branchdc|convdc)\s*=",
        text,
        flags=re.IGNORECASE,
    )
    if unsupported_dc:
        raise InputError(
            f"MATPOWER field '{unsupported_dc.group(1)}' requires an explicit DC-line or AC/DC coupled model; the AC-only parser will not ignore it."
        )
    base_match = re.search(
        r"(?:mpc\.)?baseMVA\s*=\s*([-+]?\d+(?:\.\d*)?(?:[eEdD][-+]?\d+)?)\s*;",
        text,
        flags=re.IGNORECASE,
    )
    if not base_match:
        raise InputError("MATPOWER file is missing baseMVA.")
    version_match = re.search(
        r"(?:mpc\.)?version\s*=\s*['\"]([^'\"]+)['\"]\s*;",
        text,
        flags=re.IGNORECASE,
    )
    case = {
        "version": version_match.group(1) if version_match else "2",
        "baseMVA": float(base_match.group(1).replace("D", "e").replace("d", "e")),
    }
    for name in MATRIX_NAMES:
        case[name] = _parse_matlab_matrix(text, name)
    return case


def _as_numeric_matrix(value: Any, name: str) -> np.ndarray:
    try:
        matrix = np.asarray(value, dtype=float)
    except (TypeError, ValueError) as exc:
        raise InputError(f"'{name}' must be a rectangular numeric array.") from exc
    if matrix.ndim != 2:
        raise InputError(f"'{name}' must be a two-dimensional array.")
    return matrix


def load_json_case(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if "mpc" in data and isinstance(data["mpc"], dict):
        data = data["mpc"]
    unsupported_dc = {
        "dcline", "dcbus", "dcbranch", "busdc", "branchdc", "convdc",
        "dc_networks", "dc_buses", "dc_branches",
    }.intersection({str(key).lower() for key in data})
    if unsupported_dc:
        raise InputError(
            "JSON case contains unsupported DC-network fields: "
            + ", ".join(sorted(unsupported_dc))
            + ". Use AC-side converter equivalents or a dedicated AC/DC solver."
        )
    case = {"version": str(data.get("version", "2")), "baseMVA": float(data["baseMVA"])}
    for name in MATRIX_NAMES:
        if name not in data:
            raise InputError(f"JSON case is missing '{name}'.")
        case[name] = _as_numeric_matrix(data[name], name)
    return case


def load_power_case(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise InputError(f"Case file does not exist: {path}")
    suffix = path.suffix.lower()
    if suffix == ".m":
        case = parse_matpower_m(path)
    elif suffix == ".json":
        case = load_json_case(path)
    elif suffix in {".py", ".mat"}:
        loaded = loadcase(str(path))
        if isinstance(loaded, int):
            raise InputError(f"PYPOWER could not load case '{path}' (error {loaded}).")
        case = loaded
    else:
        raise InputError("Supported case formats are .m, .py, .mat, and .json.")
    normalize_and_validate_case(case)
    return case


def _pad_columns(matrix: np.ndarray, width: int) -> np.ndarray:
    if matrix.shape[1] >= width:
        return matrix.astype(float, copy=True)
    return np.pad(matrix.astype(float), ((0, 0), (0, width - matrix.shape[1])))


def normalize_and_validate_case(case: dict[str, Any]) -> None:
    try:
        base_mva = float(case["baseMVA"])
    except (KeyError, TypeError, ValueError) as exc:
        raise InputError("baseMVA must be a positive number.") from exc
    if not math.isfinite(base_mva) or base_mva <= 0:
        raise InputError("baseMVA must be a positive finite number.")
    case["baseMVA"] = base_mva
    case["version"] = str(case.get("version", "2"))
    for name in MATRIX_NAMES:
        if name not in case:
            raise InputError(f"Case is missing '{name}'.")
        case[name] = _as_numeric_matrix(case[name], name)
        if case[name].shape[1] < MIN_COLS[name]:
            if name in {"gen", "branch"}:
                case[name] = _pad_columns(case[name], MIN_COLS[name])
            else:
                raise InputError(
                    f"'{name}' has {case[name].shape[1]} columns; expected at least {MIN_COLS[name]}."
                )

    buses = [int(round(v)) for v in case["bus"][:, BUS_I]]
    if len(buses) != len(set(buses)):
        raise InputError("Bus numbers must be unique.")
    bus_set = set(buses)
    if not any(int(round(v)) == 3 for v in case["bus"][:, BUS_TYPE]):
        raise InputError("At least one reference/slack bus (BUS_TYPE=3) is required.")
    for value in case["gen"][:, GEN_BUS]:
        if int(round(value)) not in bus_set:
            raise InputError(f"Generator references unknown bus {value:g}.")
    for row in case["branch"]:
        if int(round(row[F_BUS])) not in bus_set or int(round(row[T_BUS])) not in bus_set:
            raise InputError(f"Branch references unknown buses {row[F_BUS]:g}-{row[T_BUS]:g}.")
    ng = case["gen"].shape[0]
    nc = case["gencost"].shape[0]
    if nc not in {ng, 2 * ng}:
        raise InputError(f"gencost must have ng or 2*ng rows; got {nc} rows for {ng} generators.")
    if np.any(case["bus"][:, VMIN] > case["bus"][:, VMAX]):
        raise InputError("A bus has VMIN greater than VMAX.")
    if np.any(case["gen"][:, PMIN] > case["gen"][:, PMAX]):
        raise InputError("A generator has PMIN greater than PMAX.")
    if np.any(case["gen"][:, QMIN] > case["gen"][:, QMAX]):
        raise InputError("A generator has QMIN greater than QMAX.")


def load_optional_json(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    if not path.is_file():
        raise InputError(f"JSON file does not exist: {path}")
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise InputError(f"Top-level JSON value must be an object: {path}")
    return data


def bus_ids(case: dict[str, Any]) -> list[int]:
    return [int(round(v)) for v in case["bus"][:, BUS_I]]


def build_area_map(case: dict[str, Any], config: dict[str, Any]) -> tuple[dict[int, str], dict[str, str]]:
    known = set(bus_ids(case))
    mapping: dict[int, str] = {}
    levels: dict[str, str] = {}
    areas = config.get("areas", [])
    if areas:
        if not isinstance(areas, list):
            raise InputError("config.areas must be an array.")
        for area in areas:
            name = str(area["name"])
            levels[name] = str(area.get("level", "unspecified"))
            for raw_bus in area.get("buses", []):
                bus = int(raw_bus)
                if bus not in known:
                    raise InputError(f"Area '{name}' references unknown bus {bus}.")
                if bus in mapping:
                    raise InputError(f"Bus {bus} belongs to more than one configured area.")
                mapping[bus] = name
    else:
        for row in case["bus"]:
            area_no = int(round(row[BUS_AREA]))
            name = f"area-{area_no}"
            mapping[int(round(row[BUS_I]))] = name
            levels[name] = "unspecified"
    for bus in known:
        mapping.setdefault(bus, "unassigned")
    if "unassigned" in mapping.values():
        levels.setdefault("unassigned", "unspecified")
    return mapping, levels


def _normalize_cost_row(cost: Any) -> list[float]:
    if cost is None:
        return [2.0, 0.0, 0.0, 2.0, 0.0, 0.0]
    if isinstance(cost, list):
        coefficients = [float(v) for v in cost]
        if not coefficients:
            raise InputError("A polynomial cost list cannot be empty.")
        return [2.0, 0.0, 0.0, float(len(coefficients)), *coefficients]
    if not isinstance(cost, dict):
        raise InputError("Resource cost must be an array or object.")
    model = str(cost.get("model", "polynomial")).lower()
    if model in {"polynomial", "poly"}:
        coefficients = [float(v) for v in cost.get("coefficients", [0.0, 0.0])]
        if not coefficients:
            raise InputError("Polynomial cost coefficients cannot be empty.")
        return [2.0, float(cost.get("startup", 0)), float(cost.get("shutdown", 0)), float(len(coefficients)), *coefficients]
    if model in {"piecewise_linear", "piecewise-linear", "pwl"}:
        points = cost.get("points", [])
        if len(points) < 2:
            raise InputError("Piecewise-linear cost requires at least two [MW, cost] points.")
        flat: list[float] = []
        previous_x = -math.inf
        for point in points:
            if not isinstance(point, list) or len(point) != 2:
                raise InputError("Each piecewise-linear cost point must be [MW, cost].")
            x, y = float(point[0]), float(point[1])
            if x <= previous_x:
                raise InputError("Piecewise-linear cost MW values must increase strictly.")
            previous_x = x
            flat.extend([x, y])
        return [1.0, float(cost.get("startup", 0)), float(cost.get("shutdown", 0)), float(len(points)), *flat]
    raise InputError(f"Unsupported resource cost model '{model}'.")


def _stack_cost_rows(rows: Iterable[Iterable[float]]) -> np.ndarray:
    values = [list(row) for row in rows]
    width = max(len(row) for row in values)
    return np.asarray([row + [0.0] * (width - len(row)) for row in values], dtype=float)


def add_resources(case: dict[str, Any], config: dict[str, Any]) -> list[dict[str, Any]]:
    resources = config.get("resources", [])
    if not resources:
        return []
    if not isinstance(resources, list):
        raise InputError("config.resources must be an array.")
    known_buses = set(bus_ids(case))
    original_ng = case["gen"].shape[0]
    gen_width = max(21, case["gen"].shape[1])
    new_gen_rows: list[list[float]] = []
    new_cost_rows: list[list[float]] = []
    metadata: list[dict[str, Any]] = []
    for offset, resource in enumerate(resources):
        bus = int(resource["bus"])
        if bus not in known_buses:
            raise InputError(f"Resource '{resource.get('name', offset + 1)}' references unknown bus {bus}.")
        pmin = float(resource.get("p_min_mw", 0.0))
        pmax = float(resource.get("p_max_mw", 0.0))
        qmin = float(resource.get("q_min_mvar", 0.0))
        qmax = float(resource.get("q_max_mvar", 0.0))
        if pmin > pmax or qmin > qmax:
            raise InputError(f"Resource '{resource.get('name', offset + 1)}' has invalid P/Q bounds.")
        row = [0.0] * gen_width
        row[GEN_BUS] = bus
        row[PG] = min(max(float(resource.get("p_initial_mw", 0.0)), pmin), pmax)
        row[QG] = min(max(float(resource.get("q_initial_mvar", 0.0)), qmin), qmax)
        row[QMAX] = qmax
        row[QMIN] = qmin
        row[VG] = float(resource.get("voltage_setpoint_pu", 1.0))
        row[MBASE] = float(resource.get("m_base_mva", case["baseMVA"]))
        row[GEN_STATUS] = int(resource.get("status", 1))
        row[PMAX] = pmax
        row[PMIN] = pmin
        # Sidecar P-Q capability limits are applied through the general A/l/u
        # interface. This supports both trapezoid orientations and fixed/minimum
        # power-factor constraints without abusing MATPOWER's PC/QC columns.
        row[APF] = float(resource.get("area_participation_factor", 0.0))
        if resource.get("enforce_voltage_setpoint", False):
            bus_index = _bus_row_map(case)[bus]
            voltage = float(resource.get("voltage_setpoint_pu", 1.0))
            case["bus"][bus_index, VMIN] = voltage
            case["bus"][bus_index, VMAX] = voltage
            if int(round(case["bus"][bus_index, BUS_TYPE])) not in {3, 4}:
                case["bus"][bus_index, BUS_TYPE] = 2
        new_gen_rows.append(row)
        new_cost_rows.append(_normalize_cost_row(resource.get("cost")))
        metadata.append(
            {
                "index": original_ng + offset + 1,
                "name": str(resource.get("name", f"resource-{offset + 1}")),
                "kind": str(resource.get("kind", "der")),
                "resource_type": str(resource.get("resource_type", resource.get("kind", "generic-pq"))),
                "original_type": str(resource.get("original_type", resource.get("kind", "generic-pq"))),
                "control_mode": str(resource.get("control_mode", "pq")),
                "representation": str(
                    resource_models.RESOURCE_CATALOG.get(
                        str(resource.get("resource_type", resource.get("kind", "generic-pq"))), {}
                    ).get("representation", "generator-pq")
                ),
                "s_rated_mva": resource.get("s_rated_mva"),
                "bus": bus,
            }
        )
    case["gen"] = np.vstack([_pad_columns(case["gen"], gen_width), np.asarray(new_gen_rows)])
    old_cost = case["gencost"]
    new_cost = _stack_cost_rows(new_cost_rows)
    width = max(old_cost.shape[1], new_cost.shape[1])
    old_cost = _pad_columns(old_cost, width)
    new_cost = _pad_columns(new_cost, width)
    if old_cost.shape[0] == original_ng:
        case["gencost"] = np.vstack([old_cost, new_cost])
    else:
        zero_q_rows = _stack_cost_rows([[2, 0, 0, 2, 0, 0] for _ in new_gen_rows])
        zero_q_rows = _pad_columns(zero_q_rows, width)
        case["gencost"] = np.vstack(
            [old_cost[:original_ng], new_cost, old_cost[original_ng:], zero_q_rows]
        )
    return metadata


def _bus_row_map(case: dict[str, Any]) -> dict[int, int]:
    return {int(round(row[BUS_I])): index for index, row in enumerate(case["bus"])}


def _area_scale_for_bus(bus: int, area_map: dict[int, str], value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if value is None:
        return 1.0
    if not isinstance(value, dict):
        raise InputError("load_scale must be a number or an object keyed by area/bus.")
    bus_key = str(bus)
    if bus_key in value:
        return float(value[bus_key])
    area = area_map.get(bus, "unassigned")
    if area in value:
        return float(value[area])
    return float(value.get("default", value.get("all", 1.0)))


def apply_load_scale(case: dict[str, Any], area_map: dict[int, str], value: Any) -> None:
    for row in case["bus"]:
        bus = int(round(row[BUS_I]))
        scale = _area_scale_for_bus(bus, area_map, value)
        if scale < 0:
            raise InputError(f"Load scale at bus {bus} cannot be negative.")
        row[PD] *= scale
        row[QD] *= scale


def _matching_branch_indices(case: dict[str, Any], spec: dict[str, Any]) -> list[int]:
    if "index" in spec:
        index = int(spec["index"]) - 1
        if not 0 <= index < case["branch"].shape[0]:
            raise InputError(f"Branch index {index + 1} is out of range.")
        return [index]
    if "from_bus" not in spec or "to_bus" not in spec:
        raise InputError("Branch override needs 1-based index or from_bus/to_bus.")
    fbus, tbus = int(spec["from_bus"]), int(spec["to_bus"])
    result = []
    for index, row in enumerate(case["branch"]):
        rf, rt = int(round(row[F_BUS])), int(round(row[T_BUS]))
        if (rf, rt) in {(fbus, tbus), (tbus, fbus)}:
            result.append(index)
    if not result:
        raise InputError(f"No branch connects buses {fbus}-{tbus}.")
    return result


def apply_overrides(
    case: dict[str, Any],
    area_map: dict[int, str],
    overrides: dict[str, Any],
    resource_metadata: list[dict[str, Any]],
) -> None:
    if not overrides:
        return
    if "load_scale" in overrides:
        apply_load_scale(case, area_map, overrides["load_scale"])
    for spec in overrides.get("branch_limits", []):
        rate = float(spec["rate_mva"])
        if rate < 0:
            raise InputError("Branch rate_mva cannot be negative; 0 means unconstrained.")
        for index in _matching_branch_indices(case, spec):
            case["branch"][index, RATE_A] = rate
    for spec in overrides.get("generator_bounds", []):
        index = int(spec["index"]) - 1
        if not 0 <= index < case["gen"].shape[0]:
            raise InputError(f"Generator index {index + 1} is out of range.")
        for key, column in {
            "p_min_mw": PMIN,
            "p_max_mw": PMAX,
            "q_min_mvar": QMIN,
            "q_max_mvar": QMAX,
        }.items():
            if key in spec:
                case["gen"][index, column] = float(spec[key])
        if "status" in spec:
            case["gen"][index, GEN_STATUS] = int(spec["status"])
    name_to_index = {item["name"]: item["index"] - 1 for item in resource_metadata}
    for name, factor in overrides.get("resource_pmax_scale", {}).items():
        if name not in name_to_index:
            raise InputError(f"resource_pmax_scale references unknown resource '{name}'.")
        factor = float(factor)
        if factor < 0:
            raise InputError("resource_pmax_scale values cannot be negative.")
        index = name_to_index[name]
        case["gen"][index, PMAX] *= factor
        if case["gen"][index, PG] > case["gen"][index, PMAX]:
            case["gen"][index, PG] = case["gen"][index, PMAX]
    for name, factor in overrides.get("resource_availability", {}).items():
        if name not in name_to_index:
            raise InputError(f"resource_availability references unknown resource '{name}'.")
        factor = float(factor)
        if factor < 0:
            raise InputError("resource_availability values cannot be negative.")
        index = name_to_index[name]
        case["gen"][index, PMIN] *= factor
        case["gen"][index, PMAX] *= factor
    for name, factor in overrides.get("resource_q_scale", {}).items():
        if name not in name_to_index:
            raise InputError(f"resource_q_scale references unknown resource '{name}'.")
        factor = float(factor)
        if factor < 0:
            raise InputError("resource_q_scale values cannot be negative.")
        index = name_to_index[name]
        case["gen"][index, QMIN] *= factor
        case["gen"][index, QMAX] *= factor
    for name, status in overrides.get("resource_status", {}).items():
        if name not in name_to_index:
            raise InputError(f"resource_status references unknown resource '{name}'.")
        case["gen"][name_to_index[name], GEN_STATUS] = int(status)
    bounds = overrides.get("resource_bounds", [])
    if isinstance(bounds, dict):
        bounds = [{"name": name, **values} for name, values in bounds.items()]
    for spec in bounds:
        name = str(spec["name"])
        if name not in name_to_index:
            raise InputError(f"resource_bounds references unknown resource '{name}'.")
        index = name_to_index[name]
        for key, column in {
            "p_min_mw": PMIN,
            "p_max_mw": PMAX,
            "q_min_mvar": QMIN,
            "q_max_mvar": QMAX,
        }.items():
            if key in spec:
                case["gen"][index, column] = float(spec[key])
    case["gen"][:, PG] = np.minimum(np.maximum(case["gen"][:, PG], case["gen"][:, PMIN]), case["gen"][:, PMAX])
    case["gen"][:, QG] = np.minimum(np.maximum(case["gen"][:, QG], case["gen"][:, QMIN]), case["gen"][:, QMAX])
    normalize_and_validate_case(case)


def build_generator_metadata(
    case: dict[str, Any], resource_metadata: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    added = {item["index"]: item for item in resource_metadata}
    result = []
    for index, row in enumerate(case["gen"], start=1):
        item = added.get(index, {})
        result.append(
            {
                "index": index,
                "name": item.get("name", f"gen-{index}"),
                "kind": item.get("kind", "conventional"),
                "resource_type": item.get("resource_type", "conventional-generator"),
                "original_type": item.get("original_type", "matpower-generator"),
                "control_mode": item.get("control_mode", "pq"),
                "representation": item.get("representation", "generator-pq"),
                "s_rated_mva": item.get("s_rated_mva"),
                "bus": int(round(row[GEN_BUS])),
            }
        )
    return result


def _solver_options(config: dict[str, Any], dc: bool) -> dict[str, Any]:
    solver = config.get("solver", {})
    options = ppoption(
        VERBOSE=int(solver.get("verbose", 0)),
        OUT_ALL=0,
        OPF_ALG=int(solver.get("opf_algorithm", 560)),
        OPF_VIOLATION=float(solver.get("violation_tolerance", 5e-6)),
        PDIPM_MAX_IT=int(solver.get("max_iterations", 150)),
        PF_DC=bool(dc),
    )
    return options


def solve_case(case: dict[str, Any], options: dict[str, Any], dc: bool) -> dict[str, Any]:
    return rundcopf(case, options) if dc else runopf(case, options)


def _safe_float(value: Any) -> float | None:
    result = float(value)
    return result if math.isfinite(result) else None


def _result_quality(result: dict[str, Any]) -> dict[str, Any]:
    output = result.get("raw", {}).get("output", {})
    history = output.get("hist") or []
    last = history[-1] if history else {}
    return {
        "success": bool(result.get("success", False)),
        "message": str(output.get("message", "")),
        "iterations": int(output.get("iterations", len(history))),
        "feasibility_condition": _safe_float(last.get("feascond", math.nan)),
        "gradient_condition": _safe_float(last.get("gradcond", math.nan)),
        "complementarity_condition": _safe_float(last.get("compcond", math.nan)),
        "elapsed_seconds": _safe_float(result.get("et", math.nan)),
    }


def generation_cost(result: dict[str, Any]) -> float:
    """Evaluate MATPOWER P (and optional Q) cost rows at the solved dispatch."""
    ng = result["gen"].shape[0]
    costs = result["gencost"]
    value = float(np.sum(totcost(costs[:ng], result["gen"][:, PG])))
    if costs.shape[0] == 2 * ng:
        value += float(np.sum(totcost(costs[ng:], result["gen"][:, QG])))
    return value


def _branch_loading(row: np.ndarray) -> tuple[float, float, float | None]:
    sf = math.hypot(float(row[PF]), float(row[QF]))
    st = math.hypot(float(row[PT]), float(row[QT]))
    rate = float(row[RATE_A])
    loading = 100.0 * max(sf, st) / rate if rate > 0 else None
    return sf, st, loading


def build_ties(
    result: dict[str, Any],
    area_map: dict[int, str],
    configured: list[dict[str, Any]],
    area_order: list[str] | None = None,
) -> list[dict[str, Any]]:
    branches = result["branch"]
    specs = configured or []
    if not specs:
        rank = {name: index for index, name in enumerate(area_order or [])}
        fallback_rank = len(rank)

        def ordered_pair(left: str, right: str) -> tuple[str, str]:
            left_key = (rank.get(left, fallback_rank), left)
            right_key = (rank.get(right, fallback_rank), right)
            return (left, right) if left_key <= right_key else (right, left)

        pairs: dict[tuple[str, str], list[int]] = {}
        for index, row in enumerate(branches):
            fa = area_map[int(round(row[F_BUS]))]
            ta = area_map[int(round(row[T_BUS]))]
            if fa != ta:
                key = ordered_pair(fa, ta)
                pairs.setdefault(key, []).append(index + 1)
        specs = [
            {"name": f"{left} -> {right}", "from_area": left, "to_area": right, "branch_indices": indices}
            for (left, right), indices in pairs.items()
        ]
    ties: list[dict[str, Any]] = []
    for spec in specs:
        from_area = str(spec["from_area"])
        to_area = str(spec["to_area"])
        raw_indices = spec.get("branch_indices")
        if raw_indices:
            indices = [int(v) - 1 for v in raw_indices]
        else:
            indices = []
            for idx, row in enumerate(branches):
                areas = {
                    area_map[int(round(row[F_BUS]))],
                    area_map[int(round(row[T_BUS]))],
                }
                if areas == {from_area, to_area}:
                    indices.append(idx)
        p, q = 0.0, 0.0
        used: list[int] = []
        for index in indices:
            if not 0 <= index < branches.shape[0]:
                raise InputError(f"Tie '{spec.get('name', '')}' has an out-of-range branch index {index + 1}.")
            row = branches[index]
            fa = area_map[int(round(row[F_BUS]))]
            ta = area_map[int(round(row[T_BUS]))]
            if fa == from_area and ta == to_area:
                p += float(row[PF])
                q += float(row[QF])
            elif ta == from_area and fa == to_area:
                p += float(row[PT])
                q += float(row[QT])
            else:
                raise InputError(
                    f"Branch {index + 1} does not connect tie areas '{from_area}' and '{to_area}'."
                )
            used.append(index + 1)
        ties.append(
            {
                "name": str(spec.get("name", f"{from_area} -> {to_area}")),
                "from_area": from_area,
                "to_area": to_area,
                "branch_indices": used,
                "p_mw": p,
                "q_mvar": q,
                "s_mva": math.hypot(p, q),
            }
        )
    return ties


def summarize_period(
    period: str,
    result: dict[str, Any],
    area_map: dict[int, str],
    ties: list[dict[str, Any]],
) -> dict[str, Any]:
    bus = result["bus"]
    gen = result["gen"]
    branch = result["branch"]
    active = gen[:, GEN_STATUS] > 0
    online_pg = float(np.sum(gen[active, PG]))
    online_qg = float(np.sum(gen[active, QG]))
    total_pd = float(np.sum(bus[:, PD]))
    total_qd = float(np.sum(bus[:, QD]))
    branch_p_loss = float(np.sum(branch[:, PF] + branch[:, PT]))
    branch_q_loss = float(np.sum(branch[:, QF] + branch[:, QT]))
    loadings = [_branch_loading(row)[2] for row in branch if row[BR_STATUS] > 0]
    finite_loadings = [value for value in loadings if value is not None]
    min_idx = int(np.argmin(bus[:, VM]))
    max_idx = int(np.argmax(bus[:, VM]))
    max_loading = max(finite_loadings) if finite_loadings else None
    areas: dict[str, dict[str, float]] = {}
    for row in bus:
        name = area_map[int(round(row[BUS_I]))]
        areas.setdefault(name, {"load_p_mw": 0.0, "load_q_mvar": 0.0, "generation_p_mw": 0.0, "generation_q_mvar": 0.0})
        areas[name]["load_p_mw"] += float(row[PD])
        areas[name]["load_q_mvar"] += float(row[QD])
    for row in gen:
        name = area_map[int(round(row[GEN_BUS]))]
        areas.setdefault(name, {"load_p_mw": 0.0, "load_q_mvar": 0.0, "generation_p_mw": 0.0, "generation_q_mvar": 0.0})
        if row[GEN_STATUS] > 0:
            areas[name]["generation_p_mw"] += float(row[PG])
            areas[name]["generation_q_mvar"] += float(row[QG])
    return {
        "period": period,
        "solver": _result_quality(result),
        "objective": generation_cost(result),
        "backend_objective": _safe_float(result.get("f", math.nan)),
        "total_load_p_mw": total_pd,
        "total_load_q_mvar": total_qd,
        "total_generation_p_mw": online_pg,
        "total_generation_q_mvar": online_qg,
        "branch_active_loss_mw": branch_p_loss,
        "branch_reactive_loss_mvar": branch_q_loss,
        "min_voltage_pu": float(bus[min_idx, VM]),
        "min_voltage_bus": int(round(bus[min_idx, BUS_I])),
        "max_voltage_pu": float(bus[max_idx, VM]),
        "max_voltage_bus": int(round(bus[max_idx, BUS_I])),
        "max_branch_loading_percent": max_loading,
        "areas": areas,
        "ties": ties,
    }


def _jsonable(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items() if key not in {"om"}}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def collect_rows(
    period: str,
    result: dict[str, Any],
    area_map: dict[int, str],
    generator_metadata: list[dict[str, Any]],
    ties: list[dict[str, Any]],
    dc: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    dispatch_rows: list[dict[str, Any]] = []
    for meta, row in zip(generator_metadata, result["gen"]):
        dispatch_rows.append(
            {
                "period": period,
                "generator_index": meta["index"],
                "name": meta["name"],
                "kind": meta["kind"],
                "resource_type": meta.get("resource_type", meta["kind"]),
                "original_type": meta.get("original_type", meta["kind"]),
                "control_mode": meta.get("control_mode", "pq"),
                "representation": meta.get("representation", "generator-pq"),
                "s_rated_mva": meta.get("s_rated_mva"),
                "bus": int(round(row[GEN_BUS])),
                "area": area_map[int(round(row[GEN_BUS]))],
                "status": int(round(row[GEN_STATUS])),
                "pg_mw": float(row[PG]),
                "qg_mvar": None if dc else float(row[QG]),
                "pmin_mw": float(row[PMIN]),
                "pmax_mw": float(row[PMAX]),
                "qmin_mvar": float(row[QMIN]),
                "qmax_mvar": float(row[QMAX]),
            }
        )
    bus_rows: list[dict[str, Any]] = []
    for row in result["bus"]:
        bus_rows.append(
            {
                "period": period,
                "bus": int(round(row[BUS_I])),
                "area": area_map[int(round(row[BUS_I]))],
                "vm_pu": float(row[VM]),
                "va_deg": float(row[VA]),
                "pd_mw": float(row[PD]),
                "qd_mvar": float(row[QD]),
                "lam_p_per_mw": float(row[LAM_P]) if row.shape[0] > LAM_P else None,
                "lam_q_per_mvar": None if dc or row.shape[0] <= LAM_Q else float(row[LAM_Q]),
                "vmin_pu": float(row[VMIN]),
                "vmax_pu": float(row[VMAX]),
            }
        )
    branch_rows: list[dict[str, Any]] = []
    for index, row in enumerate(result["branch"], start=1):
        sf, st, loading = _branch_loading(row)
        fbus, tbus = int(round(row[F_BUS])), int(round(row[T_BUS]))
        branch_rows.append(
            {
                "period": period,
                "branch_index": index,
                "from_bus": fbus,
                "to_bus": tbus,
                "from_area": area_map[fbus],
                "to_area": area_map[tbus],
                "status": int(round(row[BR_STATUS])),
                "rate_a_mva": float(row[RATE_A]),
                "pf_mw": float(row[PF]),
                "qf_mvar": None if dc else float(row[QF]),
                "pt_mw": float(row[PT]),
                "qt_mvar": None if dc else float(row[QT]),
                "p_loss_mw": float(row[PF] + row[PT]),
                "q_loss_mvar": None if dc else float(row[QF] + row[QT]),
                "s_from_mva": None if dc else sf,
                "s_to_mva": None if dc else st,
                "loading_percent": loading,
            }
        )
    tie_rows = [{"period": period, **tie} for tie in ties]
    return dispatch_rows, bus_rows, branch_rows, tie_rows


def _fmt(value: Any, digits: int = 4) -> str:
    if value is None:
        return "—"
    return f"{float(value):.{digits}f}"


def write_report(
    path: Path,
    case_path: Path,
    summaries: list[dict[str, Any]],
    dc: bool,
    config_used: bool,
) -> None:
    lines = [
        "# 主配微有功無功協同最佳化調度報告",
        "",
        f"- 算例：`{case_path.name}`",
        f"- 模型：{'DC-OPF（僅有功，診斷模式）' if dc else '集中式穩態 AC-OPF'}",
        f"- 主配微分區：{'使用 sidecar 設定' if config_used else '依 MATPOWER BUS_AREA 欄位分區'}",
        "- 正方向：聯絡線 P/Q 為 `from_area → to_area` 的送端功率；負值表示反向交換。",
        "",
    ]
    for summary in summaries:
        quality = summary["solver"]
        lines.extend(
            [
                f"## 時段 {summary['period']}",
                "",
                f"- 求解狀態：{'成功' if quality['success'] else '失敗'}；{quality['message']}",
                f"- 目標函數：{_fmt(summary['objective'], 6)}",
                f"- 負荷：P = {_fmt(summary['total_load_p_mw'])} MW，Q = {_fmt(summary['total_load_q_mvar'])} Mvar",
                f"- 發電：P = {_fmt(summary['total_generation_p_mw'])} MW，Q = {_fmt(summary['total_generation_q_mvar'])} Mvar",
                f"- 支路損耗：P = {_fmt(summary['branch_active_loss_mw'])} MW，Q = {_fmt(summary['branch_reactive_loss_mvar'])} Mvar",
                f"- 電壓範圍：{_fmt(summary['min_voltage_pu'])} pu（母線 {summary['min_voltage_bus']}）～ {_fmt(summary['max_voltage_pu'])} pu（母線 {summary['max_voltage_bus']}）",
                f"- 最大支路負載率：{_fmt(summary['max_branch_loading_percent'], 2)}%",
                f"- 可行性指標：{_fmt(quality['feasibility_condition'], 8)}；迭代 {quality['iterations']} 次",
                "",
                "### 分區功率",
                "",
                "| 分區 | 負荷 P (MW) | 負荷 Q (Mvar) | 發電 P (MW) | 發電 Q (Mvar) |",
                "|---|---:|---:|---:|---:|",
            ]
        )
        for name, area in sorted(summary["areas"].items()):
            lines.append(
                f"| {name} | {_fmt(area['load_p_mw'])} | {_fmt(area['load_q_mvar'])} | {_fmt(area['generation_p_mw'])} | {_fmt(area['generation_q_mvar'])} |"
            )
        lines.extend(["", "### 聯絡線交換", ""])
        if summary["ties"]:
            lines.extend(
                [
                    "| 聯絡線 | 方向 | P (MW) | Q (Mvar) | S (MVA) | 支路索引 |",
                    "|---|---|---:|---:|---:|---|",
                ]
            )
            for tie in summary["ties"]:
                lines.append(
                    f"| {tie['name']} | {tie['from_area']} → {tie['to_area']} | {_fmt(tie['p_mw'])} | {_fmt(tie['q_mvar'])} | {_fmt(tie['s_mva'])} | {', '.join(map(str, tie['branch_indices']))} |"
                )
        else:
            lines.append("未識別出跨區支路。")
        lines.append("")
    lines.extend(
        [
            "## 解讀與適用邊界",
            "",
            "本結果是平衡三相、正序、穩態集中式最佳潮流。標準支路 MVA 限額、母線電壓上下限、機組 P/Q 上下限均在模型內；sidecar 中的分區與聯絡線目前用於彙總，聯絡線容量應透過對應支路 `RATE_A` 或 `branch_limits` 設定。多時段 profiles 逐時獨立最佳化，不包含儲能 SOC、爬坡或啟停的跨時段耦合。非平衡三相、N-1、安全約束、離散變壓器分接頭與機組組合需要另建專用模型。",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8-sig")


def period_definitions(profile_data: dict[str, Any]) -> list[dict[str, Any]]:
    if not profile_data:
        return [{"name": "base"}]
    periods = profile_data.get("periods")
    if not isinstance(periods, list) or not periods:
        raise InputError("Profiles JSON must contain a non-empty 'periods' array.")
    names: set[str] = set()
    normalized = []
    for index, period in enumerate(periods, start=1):
        if not isinstance(period, dict):
            raise InputError("Each profile period must be an object.")
        name = str(period.get("name", index))
        if name in names:
            raise InputError(f"Duplicate profile period name '{name}'.")
        names.add(name)
        normalized.append({**period, "name": name})
    return normalized


def execute_solve(args: argparse.Namespace) -> int:
    case_path = args.case.resolve()
    config = load_optional_json(args.config.resolve() if args.config else None)
    profiles = load_optional_json(args.profiles.resolve() if args.profiles else None)
    base_case = load_power_case(case_path)
    config, static_resources = resource_models.prepare_config(base_case, config)
    area_map, _levels = build_area_map(base_case, config)
    resource_metadata = add_resources(base_case, config)
    generator_metadata = build_generator_metadata(base_case, resource_metadata)
    base_overrides = config.get("overrides", {})
    apply_overrides(base_case, area_map, base_overrides, generator_metadata)
    options = _solver_options(config, args.dc)

    output_dir = args.output.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    summaries: list[dict[str, Any]] = []
    serializable_results: list[dict[str, Any]] = []
    dispatch_rows: list[dict[str, Any]] = []
    bus_rows: list[dict[str, Any]] = []
    branch_rows: list[dict[str, Any]] = []
    tie_rows: list[dict[str, Any]] = []
    coupling_rows: list[dict[str, Any]] = []
    all_success = True
    configured_area_order = [str(area["name"]) for area in config.get("areas", [])]

    for period in period_definitions(profiles):
        period_case = copy.deepcopy(base_case)
        period_overrides = {
            key: period[key]
            for key in (
                "load_scale", "branch_limits", "generator_bounds", "resource_pmax_scale",
                "resource_availability", "resource_q_scale", "resource_status", "resource_bounds",
            )
            if key in period
        }
        apply_overrides(period_case, area_map, period_overrides, generator_metadata)
        configured_couplings = config.get("resource_constraints", []) + config.get("resource_couplings", [])
        applied_couplings = resource_models.apply_linear_couplings(
            period_case,
            generator_metadata,
            configured_couplings,
            args.dc,
        )
        result = solve_case(period_case, options, args.dc)
        success = bool(result.get("success", False))
        all_success = all_success and success
        ties = build_ties(
            result,
            area_map,
            config.get("ties", []),
            configured_area_order,
        )
        summary = summarize_period(period["name"], result, area_map, ties)
        coupling_audit = resource_models.evaluate_linear_couplings(
            result, generator_metadata, configured_couplings, period["name"]
        )
        coupling_rows.extend(coupling_audit)
        summary["applied_resource_couplings"] = applied_couplings
        summary["resource_couplings"] = coupling_audit
        summaries.append(summary)
        serializable_results.append(
            {
                "period": period["name"],
                "success": success,
                "objective": generation_cost(result),
                "backend_objective": _safe_float(result.get("f", math.nan)),
                "baseMVA": float(result["baseMVA"]),
                "bus": result["bus"],
                "gen": result["gen"],
                "branch": result["branch"],
                "gencost": result["gencost"],
                "solver": _result_quality(result),
            }
        )
        rows = collect_rows(
            period["name"], result, area_map, generator_metadata, ties, args.dc
        )
        dispatch_rows.extend(rows[0])
        bus_rows.extend(rows[1])
        branch_rows.extend(rows[2])
        tie_rows.extend(rows[3])

    (output_dir / "summary.json").write_text(
        json.dumps(_jsonable({"case": str(case_path), "periods": summaries}), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (output_dir / "results.json").write_text(
        json.dumps(_jsonable({"case": str(case_path), "dc": args.dc, "periods": serializable_results}), ensure_ascii=False),
        encoding="utf-8",
    )
    write_csv(
        output_dir / "dispatch.csv",
        dispatch_rows,
        ["period", "generator_index", "name", "kind", "resource_type", "original_type", "control_mode", "representation", "s_rated_mva", "bus", "area", "status", "pg_mw", "qg_mvar", "pmin_mw", "pmax_mw", "qmin_mvar", "qmax_mvar"],
    )
    write_csv(
        output_dir / "static_resources.csv",
        static_resources,
        ["name", "resource_type", "kind", "bus", "representation", "p_mw", "q_mvar", "g_mw_at_1pu", "b_mvar_at_1pu"],
    )
    write_csv(
        output_dir / "buses.csv",
        bus_rows,
        ["period", "bus", "area", "vm_pu", "va_deg", "pd_mw", "qd_mvar", "lam_p_per_mw", "lam_q_per_mvar", "vmin_pu", "vmax_pu"],
    )
    write_csv(
        output_dir / "branches.csv",
        branch_rows,
        ["period", "branch_index", "from_bus", "to_bus", "from_area", "to_area", "status", "rate_a_mva", "pf_mw", "qf_mvar", "pt_mw", "qt_mvar", "p_loss_mw", "q_loss_mvar", "s_from_mva", "s_to_mva", "loading_percent"],
    )
    write_csv(
        output_dir / "area_exchange.csv",
        tie_rows,
        ["period", "name", "from_area", "to_area", "p_mw", "q_mvar", "s_mva", "branch_indices"],
    )
    write_csv(
        output_dir / "resource_couplings.csv",
        coupling_rows,
        ["period", "name", "lhs", "lower", "upper", "equality_residual", "violation", "audit_tolerance", "satisfied"],
    )
    write_report(output_dir / "report.md", case_path, summaries, args.dc, bool(config.get("areas")))
    print(json.dumps(_jsonable({"success": all_success, "output": str(output_dir), "periods": summaries}), ensure_ascii=False, indent=2))
    return 0 if all_success else 3


def infer_area_groups(case: dict[str, Any]) -> list[dict[str, Any]]:
    groups: dict[str, list[int]] = {}
    for row in case["bus"]:
        bus = int(round(row[BUS_I]))
        kv = float(row[BASE_KV])
        if kv > 0:
            key = f"kv-{kv:g}"
        else:
            key = f"area-{int(round(row[BUS_AREA]))}"
        groups.setdefault(key, []).append(bus)
    ordered = sorted(groups.items(), key=lambda item: item[0])
    result = []
    for index, (name, buses) in enumerate(ordered):
        level = "transmission" if index == len(ordered) - 1 and name.startswith("kv-") else "unspecified"
        result.append({"name": name, "level": level, "buses": buses})
    return result


def execute_inspect(args: argparse.Namespace) -> int:
    case = load_power_case(args.case.resolve())
    areas = infer_area_groups(case)
    area_map, _ = build_area_map(case, {"areas": areas})
    cross = []
    for index, row in enumerate(case["branch"], start=1):
        fbus, tbus = int(round(row[F_BUS])), int(round(row[T_BUS]))
        if area_map[fbus] != area_map[tbus]:
            cross.append(
                {
                    "branch_index": index,
                    "from_bus": fbus,
                    "to_bus": tbus,
                    "from_area": area_map[fbus],
                    "to_area": area_map[tbus],
                    "rate_mva": float(row[RATE_A]),
                }
            )
    template = {
        "schema_version": 1,
        "areas": areas,
        "ties": [],
        "resources": [],
        "overrides": {"load_scale": 1.0, "branch_limits": [], "generator_bounds": []},
        "solver": {"opf_algorithm": 560, "violation_tolerance": 5e-6, "max_iterations": 150},
        "inspection": {
            "base_mva": float(case["baseMVA"]),
            "bus_count": int(case["bus"].shape[0]),
            "generator_count": int(case["gen"].shape[0]),
            "branch_count": int(case["branch"].shape[0]),
            "cross_area_candidates": cross,
            "note": "Review inferred areas; explicitly map buses to transmission, distribution, and microgrid before research use.",
        },
    }
    target = args.output.resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(template, ensure_ascii=False, indent=2), encoding="utf-8")
    print(str(target))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Solve coordinated transmission-distribution-microgrid active/reactive AC optimal power flow."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    inspect_parser = subparsers.add_parser("inspect", help="Inspect a case and generate an editable sidecar template.")
    inspect_parser.add_argument("case", type=Path)
    inspect_parser.add_argument("--output", type=Path, required=True)
    inspect_parser.set_defaults(func=execute_inspect)

    solve_parser = subparsers.add_parser("solve", help="Solve one or more AC-OPF snapshots.")
    solve_parser.add_argument("case", type=Path)
    solve_parser.add_argument("--config", type=Path, help="Optional main/distribution/microgrid sidecar JSON.")
    solve_parser.add_argument("--profiles", type=Path, help="Optional independent multi-period profile JSON.")
    solve_parser.add_argument("--output", type=Path, required=True)
    solve_parser.add_argument("--dc", action="store_true", help="Use DC-OPF for active-power diagnostics only.")
    solve_parser.set_defaults(func=execute_solve)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return int(args.func(args))
    except (InputError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        print(f"INPUT ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
