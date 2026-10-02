#!/usr/bin/env python3
"""Composable spatial and multi-timescale AC-OPF scenario orchestrator."""

from __future__ import annotations

import argparse
import copy
import csv
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

import tdmg_opf as core


np = core.np

MODULE_CATALOG = {
    "ac-opf": "Balanced steady-state active/reactive AC optimal power flow.",
    "dc-opf-diagnostic": "Active-power-only DC diagnostic; mutually exclusive with ac-opf.",
    "area-exchange": "Aggregate oriented internal cross-area P/Q exchanges.",
    "boundary-equivalent": "Represent removed neighboring areas with configurable boundary resources.",
    "loss-penalty": "Add a linear price to total active generation, equivalent to a loss penalty up to a load constant.",
    "warm-start": "Initialize each period from the previous or parent-stage solution.",
    "ramp-link": "Narrow generator P bounds from the previous period using configured ramp rates.",
    "storage-soc": "Carry storage energy state sequentially and enforce energy-feasible P bounds.",
    "flexible-load-energy": "Carry an energy requirement/budget for shiftable loads or scheduled production.",
    "parent-tracking": "Penalize child-stage active-power deviation from a parent-stage plan.",
    "resource-coupling": "Enforce configured linear P/Q equalities or inequalities among resource terminals.",
}

PRESET_LEVELS = {
    "tdm": ["transmission", "distribution", "microgrid"],
    "td": ["transmission", "distribution"],
    "dm": ["distribution", "microgrid"],
    "t": ["transmission"],
    "d": ["distribution"],
    "m": ["microgrid"],
    "all": [],
}

DISPATCH_FIELDS = [
    "period", "generator_index", "name", "kind", "resource_type", "original_type",
    "control_mode", "representation", "s_rated_mva", "bus", "area", "status",
    "pg_mw", "qg_mvar", "pmin_mw", "pmax_mw", "qmin_mvar", "qmax_mvar",
]
BUS_FIELDS = [
    "period", "bus", "area", "vm_pu", "va_deg", "pd_mw", "qd_mvar",
    "lam_p_per_mw", "lam_q_per_mvar", "vmin_pu", "vmax_pu",
]
BRANCH_FIELDS = [
    "period", "branch_index", "from_bus", "to_bus", "from_area", "to_area",
    "status", "rate_a_mva", "pf_mw", "qf_mvar", "pt_mw", "qt_mvar",
    "p_loss_mw", "q_loss_mvar", "s_from_mva", "s_to_mva", "loading_percent",
]
TIE_FIELDS = [
    "period", "name", "from_area", "to_area", "p_mw", "q_mvar", "s_mva", "branch_indices",
]


def safe_name(value: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-.")
    return name or "unnamed"


def resolve_path(base_dir: Path, value: str | Path) -> Path:
    path = Path(value)
    return (base_dir / path).resolve() if not path.is_absolute() else path.resolve()


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise core.InputError(f"JSON file does not exist: {path}")
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise core.InputError(f"Top-level JSON value must be an object: {path}")
    return data


def unique_modules(*groups: Any) -> list[str]:
    result: list[str] = []
    for group in groups:
        for value in group or []:
            name = str(value)
            if name not in result:
                result.append(name)
    if "ac-opf" not in result and "dc-opf-diagnostic" not in result:
        result.insert(0, "ac-opf")
    if "area-exchange" not in result:
        result.append("area-exchange")
    return result


def merged_module_config(study: dict[str, Any], scale: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(study.get("module_config", {}))
    for key, value in scale.get("module_config", {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key].update(value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def validate_modules(modules: list[str], scale: dict[str, Any], module_config: dict[str, Any]) -> None:
    unknown = [name for name in modules if name not in MODULE_CATALOG]
    if unknown:
        raise core.InputError(f"Unknown modules: {', '.join(unknown)}")
    if "ac-opf" in modules and "dc-opf-diagnostic" in modules:
        raise core.InputError("Choose exactly one of ac-opf and dc-opf-diagnostic.")
    if "dc-opf-diagnostic" in modules and "storage-soc" in modules:
        raise core.InputError("storage-soc is not supported with dc-opf-diagnostic in this skill.")
    if "parent-tracking" in modules and not scale.get("parent"):
        raise core.InputError("parent-tracking requires time_scales[].parent.")
    if "loss-penalty" in modules:
        price = float(module_config.get("loss-penalty", {}).get("price_per_mwh", 0.0))
        if price < 0:
            raise core.InputError("loss-penalty.price_per_mwh cannot be negative.")
    if "parent-tracking" in modules:
        weight = float(module_config.get("parent-tracking", {}).get("weight_per_mw2", 0.0))
        if weight <= 0:
            raise core.InputError("parent-tracking.weight_per_mw2 must be positive.")


def load_sidecar(base_dir: Path, value: Any) -> tuple[dict[str, Any], Path | None]:
    if value is None:
        return {}, None
    if isinstance(value, dict):
        return copy.deepcopy(value), None
    path = resolve_path(base_dir, str(value))
    return read_json(path), path


def resolve_scope(
    case: dict[str, Any],
    sidecar: dict[str, Any],
    area_map: dict[int, str],
    scope_value: Any,
) -> tuple[set[str], dict[str, Any]]:
    all_areas = set(area_map.values())
    levels: dict[str, set[str]] = {}
    for area in sidecar.get("areas", []):
        levels.setdefault(str(area.get("level", "unspecified")).lower(), set()).add(str(area["name"]))
    if scope_value is None:
        scope_value = "all"
    if isinstance(scope_value, str):
        scope = {"preset": scope_value}
    elif isinstance(scope_value, dict):
        scope = copy.deepcopy(scope_value)
    else:
        raise core.InputError("study.scope must be a preset string or object.")
    preset = str(scope.get("preset", "")).lower()
    selected: set[str] = set()
    if preset:
        if preset not in PRESET_LEVELS:
            raise core.InputError(f"Unknown scope preset '{preset}'. Use tdm, td, dm, t, d, m, or all.")
        if preset == "all":
            selected = set(all_areas)
        else:
            for level in PRESET_LEVELS[preset]:
                selected.update(levels.get(level, set()))
            if not selected:
                raise core.InputError(
                    f"Scope preset '{preset}' matched no areas. Define sidecar areas with level metadata."
                )
    for name in scope.get("areas", []):
        selected.add(str(name))
    for level in scope.get("levels", []):
        selected.update(levels.get(str(level).lower(), set()))
    unknown = selected - all_areas
    if unknown:
        raise core.InputError(f"Scope references unknown areas: {', '.join(sorted(unknown))}")
    if not selected:
        raise core.InputError("Scope selected no areas.")
    return selected, scope


def subset_costs(costs: np.ndarray, selected_gen_indices: list[int], original_ng: int) -> np.ndarray:
    active = costs[selected_gen_indices]
    if costs.shape[0] == original_ng:
        return active.copy()
    reactive = costs[[original_ng + index for index in selected_gen_indices]]
    return np.vstack([active, reactive])


def branch_boundary_override(boundary: dict[str, Any], branch_index: int) -> dict[str, Any]:
    for item in boundary.get("branches", []):
        if int(item["branch_index"]) == branch_index:
            return item
    return {}


def connected_components(case: dict[str, Any]) -> list[set[int]]:
    buses = set(core.bus_ids(case))
    adjacency = {bus: set() for bus in buses}
    for row in case["branch"]:
        if row[core.BR_STATUS] <= 0:
            continue
        left, right = int(round(row[core.F_BUS])), int(round(row[core.T_BUS]))
        adjacency[left].add(right)
        adjacency[right].add(left)
    components: list[set[int]] = []
    remaining = set(buses)
    while remaining:
        root = next(iter(remaining))
        stack = [root]
        component: set[int] = set()
        while stack:
            bus = stack.pop()
            if bus in component:
                continue
            component.add(bus)
            stack.extend(adjacency[bus] - component)
        remaining -= component
        components.append(component)
    return components


def ensure_component_references(case: dict[str, Any]) -> None:
    bus_row = core._bus_row_map(case)
    for component in connected_components(case):
        refs = [bus for bus in component if int(round(case["bus"][bus_row[bus], core.BUS_TYPE])) == 3]
        gens = [
            int(round(row[core.GEN_BUS]))
            for row in case["gen"]
            if row[core.GEN_STATUS] > 0 and int(round(row[core.GEN_BUS])) in component
        ]
        if not gens:
            raise core.InputError(f"Selected electrical island {sorted(component)} has no online generator or boundary resource.")
        if not refs:
            case["bus"][bus_row[gens[0]], core.BUS_TYPE] = 3


def make_boundary_resource(
    case: dict[str, Any],
    row: np.ndarray,
    branch_index: int,
    inside_bus: int,
    outside_bus: int,
    boundary: dict[str, Any],
) -> dict[str, Any]:
    override = branch_boundary_override(boundary, branch_index)
    mode = str(boundary.get("mode", "equivalent-grid")).lower()
    if mode == "fixed-exchange":
        if "p_mw" not in override or "q_mvar" not in override:
            raise core.InputError(
                f"fixed-exchange boundary branch {branch_index} requires p_mw and q_mvar. Positive means import into the selected scope."
            )
        pmin = pmax = float(override["p_mw"])
        qmin = qmax = float(override["q_mvar"])
    else:
        branch_rate = float(row[core.RATE_A])
        default_limit = boundary.get("default_limit_mva")
        limit = float(override.get("limit_mva", branch_rate if branch_rate > 0 else default_limit or 0.0))
        if limit <= 0:
            raise core.InputError(
                f"Cut branch {branch_index} has RATE_A=0. Supply scope.boundary.default_limit_mva or a branch override."
            )
        pmax = float(override.get("p_import_max_mw", boundary.get("p_import_max_mw", limit)))
        pmin = -float(override.get("p_export_max_mw", boundary.get("p_export_max_mw", limit)))
        qmax = float(override.get("q_import_max_mvar", boundary.get("q_import_max_mvar", limit)))
        qmin = -float(override.get("q_export_max_mvar", boundary.get("q_export_max_mvar", limit)))
    price = float(override.get("energy_price_per_mwh", boundary.get("energy_price_per_mwh", 0.0)))
    return {
        "name": str(override.get("name", f"boundary-branch-{branch_index}")),
        "kind": "boundary-grid",
        "bus": inside_bus,
        "outside_bus": outside_bus,
        "source_branch_index": branch_index,
        "p_min_mw": pmin,
        "p_max_mw": pmax,
        "q_min_mvar": qmin,
        "q_max_mvar": qmax,
        "voltage_setpoint_pu": float(case["bus"][core._bus_row_map(case)[inside_bus], core.VM]),
        "cost": {"model": "polynomial", "coefficients": [price, 0.0]},
    }


def extract_scope(
    case: dict[str, Any],
    area_map: dict[int, str],
    generator_metadata: list[dict[str, Any]],
    selected_areas: set[str],
    scope: dict[str, Any],
) -> tuple[dict[str, Any], dict[int, str], list[dict[str, Any]], list[dict[str, Any]]]:
    selected_buses = {bus for bus, area in area_map.items() if area in selected_areas}
    if not selected_buses:
        raise core.InputError("Selected scope contains no buses.")
    bus_mask = [int(round(row[core.BUS_I])) in selected_buses for row in case["bus"]]
    branch_mask = [
        int(round(row[core.F_BUS])) in selected_buses and int(round(row[core.T_BUS])) in selected_buses
        for row in case["branch"]
    ]
    selected_gen_indices = [
        index for index, row in enumerate(case["gen"]) if int(round(row[core.GEN_BUS])) in selected_buses
    ]
    original_ng = case["gen"].shape[0]
    subcase = {
        "version": case["version"],
        "baseMVA": case["baseMVA"],
        "bus": case["bus"][bus_mask].copy(),
        "branch": case["branch"][branch_mask].copy(),
        "gen": case["gen"][selected_gen_indices].copy(),
        "gencost": subset_costs(case["gencost"], selected_gen_indices, original_ng),
    }
    metadata: list[dict[str, Any]] = []
    for new_index, old_index in enumerate(selected_gen_indices, start=1):
        item = copy.deepcopy(generator_metadata[old_index])
        item["original_index"] = item["index"]
        item["index"] = new_index
        metadata.append(item)
    cut_branches: list[tuple[int, np.ndarray, int, int]] = []
    for index, row in enumerate(case["branch"], start=1):
        fbus, tbus = int(round(row[core.F_BUS])), int(round(row[core.T_BUS]))
        f_inside, t_inside = fbus in selected_buses, tbus in selected_buses
        if f_inside != t_inside and row[core.BR_STATUS] > 0:
            cut_branches.append((index, row, fbus if f_inside else tbus, tbus if f_inside else fbus))
    boundary = copy.deepcopy(scope.get("boundary", {}))
    mode = str(boundary.get("mode", "equivalent-grid" if cut_branches else "none")).lower()
    if mode not in {"none", "islanded", "equivalent-grid", "fixed-exchange"}:
        raise core.InputError("scope.boundary.mode must be none, islanded, equivalent-grid, or fixed-exchange.")
    boundary_metadata: list[dict[str, Any]] = []
    if cut_branches and mode in {"equivalent-grid", "fixed-exchange"}:
        resources = [
            make_boundary_resource(subcase, row, index, inside, outside, {**boundary, "mode": mode})
            for index, row, inside, outside in cut_branches
        ]
        added = core.add_resources(subcase, {"resources": resources})
        for item, spec in zip(added, resources):
            item.update(
                {
                    "outside_bus": spec["outside_bus"],
                    "source_branch_index": spec["source_branch_index"],
                }
            )
            metadata.append(item)
            boundary_metadata.append(item)
    ensure_component_references(subcase)
    core.normalize_and_validate_case(subcase)
    sub_area_map = {bus: area_map[bus] for bus in selected_buses}
    return subcase, sub_area_map, metadata, boundary_metadata


def cost_rows(costs: np.ndarray) -> list[list[float]]:
    rows: list[list[float]] = []
    for row in costs:
        model, count = int(round(row[0])), int(round(row[3]))
        width = 4 + (count if model == 2 else 2 * count)
        rows.append([float(v) for v in row[:width]])
    return rows


def add_loss_penalty(case: dict[str, Any], price: float) -> None:
    if price == 0:
        return
    ng = case["gen"].shape[0]
    rows = cost_rows(case["gencost"])
    for index in range(ng):
        row = rows[index]
        model, count = int(round(row[0])), int(round(row[3]))
        if model == 2:
            coefficients = row[4 : 4 + count]
            if len(coefficients) == 1:
                coefficients = [price, coefficients[0]]
            else:
                coefficients[-2] += price
            rows[index] = row[:3] + [float(len(coefficients)), *coefficients]
        elif model == 1:
            for point in range(count):
                x_index, y_index = 4 + 2 * point, 5 + 2 * point
                row[y_index] += price * row[x_index]
        else:
            raise core.InputError(f"Unsupported gencost model {model} for loss-penalty.")
    case["gencost"] = core._stack_cost_rows(rows)


def add_tracking_penalty(
    case: dict[str, Any],
    metadata: list[dict[str, Any]],
    targets: dict[str, float],
    weight: float,
    selected_names: set[str] | None,
) -> None:
    rows = cost_rows(case["gencost"])
    for index, meta in enumerate(metadata):
        name = meta["name"]
        if name not in targets or (selected_names is not None and name not in selected_names):
            continue
        row = rows[index]
        model, count = int(round(row[0])), int(round(row[3]))
        if model != 2:
            raise core.InputError(f"parent-tracking requires polynomial cost for generator '{name}'.")
        coefficients = row[4 : 4 + count]
        while len(coefficients) < 3:
            coefficients.insert(0, 0.0)
        target = float(targets[name])
        coefficients[-3] += weight
        coefficients[-2] -= 2.0 * weight * target
        coefficients[-1] += weight * target * target
        rows[index] = row[:3] + [float(len(coefficients)), *coefficients]
    case["gencost"] = core._stack_cost_rows(rows)


def load_periods(base_dir: Path, scale: dict[str, Any]) -> list[dict[str, Any]]:
    profiles = scale.get("profiles")
    if profiles is None:
        return [{"name": "base"}]
    if isinstance(profiles, str):
        data = read_json(resolve_path(base_dir, profiles))
    elif isinstance(profiles, dict):
        data = profiles
    elif isinstance(profiles, list):
        data = {"periods": profiles}
    else:
        raise core.InputError("time_scales[].profiles must be a path, object, or period array.")
    return core.period_definitions(data)


def generator_dynamics(
    sidecar: dict[str, Any], study: dict[str, Any], scale: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for resource in sidecar.get("resources", []):
        if resource.get("ramp"):
            result[str(resource.get("name"))] = copy.deepcopy(resource["ramp"])
    for source in (study.get("generator_dynamics", []), scale.get("generator_dynamics", [])):
        for item in source:
            name = str(item["generator"])
            result.setdefault(name, {}).update({k: v for k, v in item.items() if k != "generator"})
    return result


def apply_ramp_bounds(
    case: dict[str, Any],
    metadata: list[dict[str, Any]],
    dynamics: dict[str, dict[str, Any]],
    previous_result: dict[str, Any] | None,
    step_minutes: float,
) -> None:
    if previous_result is None:
        return
    for index, meta in enumerate(metadata):
        spec = dynamics.get(meta["name"])
        if not spec:
            continue
        previous = float(previous_result["gen"][index, core.PG])
        if "up_mw_per_min" in spec:
            up = float(spec["up_mw_per_min"]) * step_minutes
        else:
            up = float(spec.get("up_mw_per_hour", math.inf)) * step_minutes / 60.0
        if "down_mw_per_min" in spec:
            down = float(spec["down_mw_per_min"]) * step_minutes
        else:
            down = float(spec.get("down_mw_per_hour", math.inf)) * step_minutes / 60.0
        case["gen"][index, core.PMAX] = min(case["gen"][index, core.PMAX], previous + up)
        case["gen"][index, core.PMIN] = max(case["gen"][index, core.PMIN], previous - down)
        if case["gen"][index, core.PMIN] > case["gen"][index, core.PMAX] + 1e-9:
            raise core.InputError(f"Ramp bounds are inconsistent for generator '{meta['name']}'.")


def storage_specs(sidecar: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result = {}
    for resource in sidecar.get("resources", []):
        if resource.get("storage"):
            result[str(resource.get("name"))] = copy.deepcopy(resource["storage"])
    return result


def energy_budget_specs(sidecar: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result = {}
    for resource in sidecar.get("resources", []):
        if resource.get("energy_budget"):
            result[str(resource.get("name"))] = copy.deepcopy(resource["energy_budget"])
    return result


def initialize_energy_budgets(specs: dict[str, dict[str, Any]]) -> dict[str, float]:
    states: dict[str, float] = {}
    for name, spec in specs.items():
        target = float(spec["target_mwh"])
        remaining = float(spec.get("initial_remaining_mwh", target))
        if target < 0 or remaining < 0:
            raise core.InputError(f"Energy budget for '{name}' cannot be negative.")
        states[name] = remaining
    return states


def apply_energy_budget_bounds(
    case: dict[str, Any],
    metadata: list[dict[str, Any]],
    specs: dict[str, dict[str, Any]],
    states: dict[str, float],
    step_hours: float,
    final_period: bool,
) -> dict[str, dict[str, Any]]:
    before: dict[str, dict[str, Any]] = {}
    for index, meta in enumerate(metadata):
        name = meta["name"]
        if name not in specs:
            continue
        spec = specs[name]
        direction = str(spec.get("direction", "consumption")).lower()
        sign = -1.0 if direction == "consumption" else 1.0
        remaining = states[name]
        if direction not in {"consumption", "generation"}:
            raise core.InputError(f"Energy budget direction for '{name}' must be consumption or generation.")
        if sign < 0:
            maximum_rate = max(0.0, -float(case["gen"][index, core.PMIN]))
            case["gen"][index, core.PMIN] = max(
                case["gen"][index, core.PMIN], -remaining / step_hours
            )
        else:
            maximum_rate = max(0.0, float(case["gen"][index, core.PMAX]))
            case["gen"][index, core.PMAX] = min(
                case["gen"][index, core.PMAX], remaining / step_hours
            )
        if final_period and bool(spec.get("enforce_terminal", True)):
            required_p = sign * remaining / step_hours
            if required_p < case["gen"][index, core.PMIN] - 1e-8 or required_p > case["gen"][index, core.PMAX] + 1e-8:
                raise core.InputError(f"Energy budget for '{name}' is unreachable in the final period.")
            case["gen"][index, core.PMIN] = required_p
            case["gen"][index, core.PMAX] = required_p
        before[name] = {
            "generator_index": index,
            "remaining_before_mwh": remaining,
            "direction": direction,
            "sign": sign,
            "maximum_rate_mw": maximum_rate,
        }
    return before


def update_energy_budgets(
    period: str,
    result: dict[str, Any],
    before: dict[str, dict[str, Any]],
    states: dict[str, float],
    step_hours: float,
) -> list[dict[str, Any]]:
    rows = []
    for name, item in before.items():
        pg = float(result["gen"][item["generator_index"], core.PG])
        delivered = max(0.0, item["sign"] * pg) * step_hours
        remaining = max(0.0, item["remaining_before_mwh"] - delivered)
        states[name] = remaining
        rows.append(
            {
                "period": period,
                "resource": name,
                "direction": item["direction"],
                "pg_mw": pg,
                "energy_this_period_mwh": delivered,
                "remaining_before_mwh": item["remaining_before_mwh"],
                "remaining_after_mwh": remaining,
            }
        )
    return rows


def initialize_storage_states(specs: dict[str, dict[str, Any]]) -> dict[str, float]:
    states: dict[str, float] = {}
    for name, spec in specs.items():
        capacity = float(spec["energy_capacity_mwh"])
        soc = float(spec["initial_soc"])
        soc_min, soc_max = float(spec.get("soc_min", 0.0)), float(spec.get("soc_max", 1.0))
        if capacity <= 0 or not 0 <= soc_min <= soc <= soc_max <= 1:
            raise core.InputError(f"Invalid storage capacity/SOC limits for '{name}'.")
        states[name] = capacity * soc
    return states


def apply_storage_bounds(
    case: dict[str, Any],
    metadata: list[dict[str, Any]],
    specs: dict[str, dict[str, Any]],
    states: dict[str, float],
    step_hours: float,
    final_period: bool,
) -> dict[str, dict[str, float]]:
    before: dict[str, dict[str, float]] = {}
    for index, meta in enumerate(metadata):
        name = meta["name"]
        if name not in specs:
            continue
        spec = specs[name]
        capacity = float(spec["energy_capacity_mwh"])
        energy = states[name]
        emin = capacity * float(spec.get("soc_min", 0.0))
        emax = capacity * float(spec.get("soc_max", 1.0))
        eta_c = float(spec.get("charge_efficiency", 1.0))
        eta_d = float(spec.get("discharge_efficiency", 1.0))
        if not 0 < eta_c <= 1 or not 0 < eta_d <= 1:
            raise core.InputError(f"Storage efficiencies for '{name}' must be in (0, 1].")
        max_discharge = max(0.0, (energy - emin) * eta_d / step_hours)
        max_charge = max(0.0, (emax - energy) / (eta_c * step_hours))
        case["gen"][index, core.PMAX] = min(case["gen"][index, core.PMAX], max_discharge)
        case["gen"][index, core.PMIN] = max(case["gen"][index, core.PMIN], -max_charge)
        if final_period and spec.get("enforce_terminal_soc", False):
            target = capacity * float(spec["terminal_soc_target"])
            required_p = (energy - target) * eta_d / step_hours if target <= energy else -(target - energy) / (eta_c * step_hours)
            if required_p < case["gen"][index, core.PMIN] - 1e-8 or required_p > case["gen"][index, core.PMAX] + 1e-8:
                raise core.InputError(f"Terminal SOC target for '{name}' is unreachable in the final period.")
            case["gen"][index, core.PMIN] = required_p
            case["gen"][index, core.PMAX] = required_p
        before[name] = {
            "energy_before_mwh": energy,
            "soc_before": energy / capacity,
            "charge_efficiency": eta_c,
            "discharge_efficiency": eta_d,
            "capacity_mwh": capacity,
            "generator_index": index,
        }
    return before


def update_storage_states(
    period: str,
    result: dict[str, Any],
    before: dict[str, dict[str, float]],
    states: dict[str, float],
    step_hours: float,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for name, item in before.items():
        pg = float(result["gen"][item["generator_index"], core.PG])
        if pg >= 0:
            after = item["energy_before_mwh"] - pg * step_hours / item["discharge_efficiency"]
            mode = "discharge"
        else:
            after = item["energy_before_mwh"] + (-pg) * step_hours * item["charge_efficiency"]
            mode = "charge"
        after = min(max(after, 0.0), item["capacity_mwh"])
        states[name] = after
        rows.append(
            {
                "period": period,
                "storage": name,
                "mode": mode,
                "pg_mw": pg,
                "energy_before_mwh": item["energy_before_mwh"],
                "energy_after_mwh": after,
                "soc_before": item["soc_before"],
                "soc_after": after / item["capacity_mwh"],
            }
        )
    return rows


def warm_start(case: dict[str, Any], source: dict[str, Any] | None) -> None:
    if source is None:
        return
    if source["bus"].shape[0] == case["bus"].shape[0]:
        case["bus"][:, core.VM] = source["bus"][:, core.VM]
        case["bus"][:, core.VA] = source["bus"][:, core.VA]
    if source["gen"].shape[0] == case["gen"].shape[0]:
        case["gen"][:, core.PG] = np.minimum(
            np.maximum(source["gen"][:, core.PG], case["gen"][:, core.PMIN]), case["gen"][:, core.PMAX]
        )
        case["gen"][:, core.QG] = np.minimum(
            np.maximum(source["gen"][:, core.QG], case["gen"][:, core.QMIN]), case["gen"][:, core.QMAX]
        )


def parent_result_for_period(
    period_index: int,
    period: dict[str, Any],
    child_count: int,
    parent_records: list[dict[str, Any]],
) -> dict[str, Any]:
    if "parent_period" in period:
        target = str(period["parent_period"])
        for record in parent_records:
            if record["period"] == target:
                return record["result"]
        raise core.InputError(f"Unknown parent_period '{target}'.")
    parent_index = min(int(period_index * len(parent_records) / child_count), len(parent_records) - 1)
    return parent_records[parent_index]["result"]


def boundary_rows(
    period: str,
    result: dict[str, Any],
    area_map: dict[int, str],
    boundary_metadata: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    rows = []
    for meta in boundary_metadata:
        row = result["gen"][meta["index"] - 1]
        bus = int(round(row[core.GEN_BUS]))
        rows.append(
            {
                "period": period,
                "name": meta["name"],
                "inside_bus": bus,
                "outside_bus": meta["outside_bus"],
                "area": area_map[bus],
                "source_branch_index": meta["source_branch_index"],
                "p_import_mw": float(row[core.PG]),
                "q_import_mvar": float(row[core.QG]),
                "s_import_mva": math.hypot(float(row[core.PG]), float(row[core.QG])),
            }
        )
    return rows


def write_stage_report(
    path: Path,
    study_name: str,
    scale_name: str,
    selected_areas: set[str],
    modules: list[str],
    summaries: list[dict[str, Any]],
) -> None:
    lines = [
        "# 模組化主配微調度報告",
        "",
        f"- 研究場景：`{study_name}`",
        f"- 時間尺度：`{scale_name}`",
        f"- 計算範圍：{', '.join(sorted(selected_areas))}",
        f"- 啟用模組：{', '.join(modules)}",
        "",
        "| 時段 | 狀態 | 目標函數 | 負荷P (MW) | 發電P (MW) | 最低電壓 (pu) | 最大負載率 |",
        "|---|---|---:|---:|---:|---:|---:|",
    ]
    for item in summaries:
        lines.append(
            f"| {item['period']} | {'成功' if item['solver']['success'] else '失敗'} | {core._fmt(item['objective'], 4)} | {core._fmt(item['total_load_p_mw'], 4)} | {core._fmt(item['total_generation_p_mw'], 4)} | {core._fmt(item['min_voltage_pu'], 4)} | {core._fmt(item['max_branch_loading_percent'], 2)}% |"
        )
    lines.extend(
        [
            "",
            "邊界等值電源 P/Q 為正表示由外部系統注入本計算範圍，負值表示本範圍向外送電。`storage-soc` 與 `ramp-link` 採逐時狀態傳遞；`parent-tracking` 採父級計畫二次偏差懲罰。這是分層滾動 AC-OPF，不等同於一次性全時域隨機/魯棒全局最優。",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8-sig")


def run_scale(
    scenario_dir: Path,
    output_dir: Path,
    study_name: str,
    scale: dict[str, Any],
    study: dict[str, Any],
    base_case: dict[str, Any],
    sidecar: dict[str, Any],
    area_map: dict[int, str],
    metadata: list[dict[str, Any]],
    boundary_metadata: list[dict[str, Any]],
    static_resources: list[dict[str, Any]],
    selected_areas: set[str],
    completed_stages: dict[str, list[dict[str, Any]]],
) -> tuple[bool, list[dict[str, Any]]]:
    scale_name = str(scale.get("name", "base"))
    modules = unique_modules(study.get("modules"), scale.get("modules"))
    module_config = merged_module_config(study, scale)
    validate_modules(modules, scale, module_config)
    periods = load_periods(scenario_dir, scale)
    step_minutes = float(scale.get("step_minutes", 60.0))
    if step_minutes <= 0:
        raise core.InputError("time_scales[].step_minutes must be positive.")
    step_hours = step_minutes / 60.0
    dc = "dc-opf-diagnostic" in modules
    solver_cfg = copy.deepcopy(sidecar.get("solver", {}))
    solver_cfg.update(study.get("solver", {}))
    solver_cfg.update(scale.get("solver", {}))
    options = core._solver_options({"solver": solver_cfg}, dc)
    stage_case = copy.deepcopy(base_case)
    if "loss-penalty" in modules:
        add_loss_penalty(stage_case, float(module_config.get("loss-penalty", {}).get("price_per_mwh", 0.0)))
    dynamics = generator_dynamics(sidecar, study, scale)
    stores = storage_specs(sidecar)
    selected_store_names = {item["name"] for item in metadata if item["name"] in stores}
    stores = {name: spec for name, spec in stores.items() if name in selected_store_names}
    if "storage-soc" in modules and not stores:
        raise core.InputError(f"Study '{study_name}' enables storage-soc but its scope contains no configured storage.")
    states = initialize_storage_states(stores) if "storage-soc" in modules else {}
    budgets = energy_budget_specs(sidecar)
    selected_budget_names = {item["name"] for item in metadata if item["name"] in budgets}
    budgets = {name: spec for name, spec in budgets.items() if name in selected_budget_names}
    if "flexible-load-energy" in modules and not budgets:
        raise core.InputError(
            f"Study '{study_name}' enables flexible-load-energy but its scope contains no configured energy_budget."
        )
    budget_states = initialize_energy_budgets(budgets) if "flexible-load-energy" in modules else {}
    automatic_constraints = sidecar.get("resource_constraints", [])
    couplings = sidecar.get("resource_couplings", [])
    if couplings and "resource-coupling" not in modules:
        raise core.InputError(
            f"Study '{study_name}' contains resource_couplings but does not enable resource-coupling."
        )
    if "resource-coupling" in modules and not couplings:
        raise core.InputError(f"Study '{study_name}' enables resource-coupling but defines no resource_couplings.")
    parent_records: list[dict[str, Any]] = []
    if scale.get("parent"):
        parent_name = str(scale["parent"])
        if parent_name not in completed_stages:
            raise core.InputError(f"Time scale '{scale_name}' references incomplete parent '{parent_name}'.")
        parent_records = completed_stages[parent_name]

    stage_dir = output_dir / safe_name(scale_name)
    stage_dir.mkdir(parents=True, exist_ok=True)
    summaries: list[dict[str, Any]] = []
    serializable_results: list[dict[str, Any]] = []
    records: list[dict[str, Any]] = []
    dispatch_data: list[dict[str, Any]] = []
    bus_data: list[dict[str, Any]] = []
    branch_data: list[dict[str, Any]] = []
    tie_data: list[dict[str, Any]] = []
    boundary_data: list[dict[str, Any]] = []
    state_data: list[dict[str, Any]] = []
    budget_data: list[dict[str, Any]] = []
    coupling_data: list[dict[str, Any]] = []
    previous_result: dict[str, Any] | None = None
    all_success = True

    for period_index, period in enumerate(periods):
        period_case = copy.deepcopy(stage_case)
        period_overrides = {
            key: period[key]
            for key in (
                "load_scale", "branch_limits", "generator_bounds", "resource_pmax_scale",
                "resource_availability", "resource_q_scale", "resource_status", "resource_bounds",
            )
            if key in period
        }
        core.apply_overrides(period_case, area_map, period_overrides, metadata)
        parent_result = (
            parent_result_for_period(period_index, period, len(periods), parent_records)
            if parent_records
            else None
        )
        if "parent-tracking" in modules:
            tracking = module_config["parent-tracking"]
            targets = {
                item["name"]: float(parent_result["gen"][index, core.PG])
                for index, item in enumerate(metadata)
            }
            selected_names = set(map(str, tracking.get("generators", []))) or None
            add_tracking_penalty(
                period_case,
                metadata,
                targets,
                float(tracking["weight_per_mw2"]),
                selected_names,
            )
        if "ramp-link" in modules:
            apply_ramp_bounds(period_case, metadata, dynamics, previous_result, step_minutes)
        storage_before = (
            apply_storage_bounds(
                period_case,
                metadata,
                stores,
                states,
                step_hours,
                period_index == len(periods) - 1,
            )
            if "storage-soc" in modules
            else {}
        )
        budget_before = (
            apply_energy_budget_bounds(
                period_case,
                metadata,
                budgets,
                budget_states,
                step_hours,
                period_index == len(periods) - 1,
            )
            if "flexible-load-energy" in modules
            else {}
        )
        constraints = automatic_constraints + (couplings if "resource-coupling" in modules else [])
        applied_couplings = core.resource_models.apply_linear_couplings(
            period_case, metadata, constraints, dc
        )
        if "warm-start" in modules:
            warm_start(period_case, previous_result or parent_result)
        result = core.solve_case(period_case, options, dc)
        success = bool(result.get("success", False))
        all_success = all_success and success
        ties = (
            core.build_ties(
                result,
                area_map,
                [],
                [str(area["name"]) for area in sidecar.get("areas", []) if str(area["name"]) in selected_areas],
            )
            if "area-exchange" in modules
            else []
        )
        summary = core.summarize_period(period["name"], result, area_map, ties)
        parent_deviation = None
        if parent_result is not None:
            deviations = [
                float(result["gen"][index, core.PG] - parent_result["gen"][index, core.PG])
                for index in range(result["gen"].shape[0])
            ]
            parent_deviation = math.sqrt(sum(value * value for value in deviations) / len(deviations))
            summary["parent_tracking_rmse_mw"] = parent_deviation
        period_boundary_rows = boundary_rows(period["name"], result, area_map, boundary_metadata)
        summary["boundary_exchanges"] = period_boundary_rows
        coupling_audit = core.resource_models.evaluate_linear_couplings(
            result, metadata, constraints, period["name"]
        )
        coupling_data.extend(coupling_audit)
        summary["applied_resource_couplings"] = applied_couplings
        summary["resource_couplings"] = coupling_audit
        if storage_before and success:
            states_rows = update_storage_states(period["name"], result, storage_before, states, step_hours)
            state_data.extend(states_rows)
            summary["storage_states"] = states_rows
        if budget_before and success:
            energy_rows = update_energy_budgets(
                period["name"], result, budget_before, budget_states, step_hours
            )
            budget_data.extend(energy_rows)
            summary["energy_budgets"] = energy_rows
        summaries.append(summary)
        serializable_results.append(
            {
                "period": period["name"],
                "success": success,
                "objective": core.generation_cost(result),
                "backend_objective": core._safe_float(result.get("f", math.nan)),
                "baseMVA": float(result["baseMVA"]),
                "bus": result["bus"],
                "gen": result["gen"],
                "branch": result["branch"],
                "gencost": result["gencost"],
                "solver": core._result_quality(result),
            }
        )
        rows = core.collect_rows(period["name"], result, area_map, metadata, ties, dc)
        dispatch_data.extend(rows[0])
        bus_data.extend(rows[1])
        branch_data.extend(rows[2])
        tie_data.extend(rows[3])
        boundary_data.extend(period_boundary_rows)
        records.append({"period": period["name"], "result": result})
        if success:
            previous_result = result
        elif "ramp-link" in modules or "storage-soc" in modules:
            break

    core.write_csv(stage_dir / "dispatch.csv", dispatch_data, DISPATCH_FIELDS)
    core.write_csv(stage_dir / "buses.csv", bus_data, BUS_FIELDS)
    core.write_csv(stage_dir / "branches.csv", branch_data, BRANCH_FIELDS)
    core.write_csv(stage_dir / "area_exchange.csv", tie_data, TIE_FIELDS)
    core.write_csv(
        stage_dir / "boundary_exchange.csv",
        boundary_data,
        ["period", "name", "inside_bus", "outside_bus", "area", "source_branch_index", "p_import_mw", "q_import_mvar", "s_import_mva"],
    )
    core.write_csv(
        stage_dir / "states.csv",
        state_data,
        ["period", "storage", "mode", "pg_mw", "energy_before_mwh", "energy_after_mwh", "soc_before", "soc_after"],
    )
    core.write_csv(
        stage_dir / "energy_budget.csv",
        budget_data,
        ["period", "resource", "direction", "pg_mw", "energy_this_period_mwh", "remaining_before_mwh", "remaining_after_mwh"],
    )
    core.write_csv(
        stage_dir / "static_resources.csv",
        static_resources,
        ["name", "resource_type", "kind", "bus", "representation", "p_mw", "q_mvar", "g_mw_at_1pu", "b_mvar_at_1pu"],
    )
    core.write_csv(
        stage_dir / "resource_couplings.csv",
        coupling_data,
        ["period", "name", "lhs", "lower", "upper", "equality_residual", "violation", "audit_tolerance", "satisfied"],
    )
    (stage_dir / "summary.json").write_text(
        json.dumps(
            core._jsonable(
                {
                    "study": study_name,
                    "time_scale": scale_name,
                    "scope_areas": sorted(selected_areas),
                    "modules": modules,
                    "success": all_success,
                    "periods": summaries,
                }
            ),
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    (stage_dir / "results.json").write_text(
        json.dumps(core._jsonable({"periods": serializable_results}), ensure_ascii=False), encoding="utf-8"
    )
    write_stage_report(stage_dir / "report.md", study_name, scale_name, selected_areas, modules, summaries)
    return all_success, records


def load_study_system(
    scenario_dir: Path, root_system: dict[str, Any], study: dict[str, Any]
) -> tuple[Path, dict[str, Any], dict[str, Any], dict[int, str], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], set[str], dict[str, Any]]:
    system = copy.deepcopy(root_system)
    system.update(study.get("system", {}))
    if "case" not in system:
        raise core.InputError("scenario.system.case or study.system.case is required.")
    case_path = resolve_path(scenario_dir, system["case"])
    sidecar, _ = load_sidecar(scenario_dir, system.get("sidecar"))
    case = core.load_power_case(case_path)
    sidecar, static_resources = core.resource_models.prepare_config(case, sidecar)
    area_map, _ = core.build_area_map(case, sidecar)
    added_resources = core.add_resources(case, sidecar)
    generator_metadata = core.build_generator_metadata(case, added_resources)
    core.apply_overrides(case, area_map, sidecar.get("overrides", {}), generator_metadata)
    selected_areas, scope = resolve_scope(case, sidecar, area_map, study.get("scope", "all"))
    subcase, sub_area_map, metadata, boundary_metadata = extract_scope(
        case, area_map, generator_metadata, selected_areas, scope
    )
    core.apply_overrides(subcase, sub_area_map, study.get("overrides", {}), metadata)
    selected_static = [item for item in static_resources if area_map.get(int(item["bus"])) in selected_areas]
    return case_path, sidecar, subcase, sub_area_map, metadata, boundary_metadata, selected_static, selected_areas, scope


def validate_scenario_shape(scenario: dict[str, Any]) -> list[dict[str, Any]]:
    if int(scenario.get("schema_version", 2)) != 2:
        raise core.InputError("Modular scenario schema_version must be 2.")
    studies = scenario.get("studies")
    if not isinstance(studies, list) or not studies:
        raise core.InputError("Scenario must contain a non-empty studies array.")
    names: set[str] = set()
    for index, study in enumerate(studies, start=1):
        if not isinstance(study, dict):
            raise core.InputError("Each study must be an object.")
        name = str(study.get("name", index))
        if name in names:
            raise core.InputError(f"Duplicate study name '{name}'.")
        names.add(name)
        study["name"] = name
        scales = study.get("time_scales", [{"name": "base", "step_minutes": 60}])
        if not isinstance(scales, list) or not scales:
            raise core.InputError(f"Study '{name}' time_scales must be a non-empty array.")
        scale_names: set[str] = set()
        for scale in scales:
            scale_name = str(scale.get("name", "base"))
            if scale_name in scale_names:
                raise core.InputError(f"Study '{name}' has duplicate time scale '{scale_name}'.")
            if scale.get("parent") and str(scale["parent"]) not in scale_names:
                raise core.InputError(
                    f"Study '{name}' parent scale '{scale['parent']}' must appear earlier in time_scales."
                )
            scale_names.add(scale_name)
            scale["name"] = scale_name
        study["time_scales"] = scales
    return studies


def execute_run(args: argparse.Namespace) -> int:
    scenario_path = args.scenario.resolve()
    scenario = read_json(scenario_path)
    scenario_dir = scenario_path.parent
    studies = validate_scenario_shape(scenario)
    output_dir = (
        args.output.resolve()
        if args.output
        else resolve_path(scenario_dir, scenario.get("output", f"{scenario_path.stem}-results"))
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    portfolio: list[dict[str, Any]] = []
    overall_success = True
    for study in studies:
        name = study["name"]
        study_dir = output_dir / safe_name(name)
        study_dir.mkdir(parents=True, exist_ok=True)
        (
            case_path,
            sidecar,
            subcase,
            area_map,
            metadata,
            boundary_metadata,
            static_resources,
            selected_areas,
            scope,
        ) = load_study_system(scenario_dir, scenario.get("system", {}), study)
        completed: dict[str, list[dict[str, Any]]] = {}
        stage_summaries: list[dict[str, Any]] = []
        study_success = True
        for scale in study["time_scales"]:
            success, records = run_scale(
                scenario_dir,
                study_dir,
                name,
                scale,
                study,
                subcase,
                sidecar,
                area_map,
                metadata,
                boundary_metadata,
                static_resources,
                selected_areas,
                completed,
            )
            completed[scale["name"]] = records
            study_success = study_success and success
            stage_summaries.append(
                {
                    "name": scale["name"],
                    "success": success,
                    "periods_solved": len(records),
                    "output": str((study_dir / safe_name(scale["name"])).resolve()),
                }
            )
            if not success and bool(study.get("stop_on_failure", True)):
                break
        portfolio.append(
            {
                "name": name,
                "case": str(case_path),
                "scope": scope,
                "areas": sorted(selected_areas),
                "success": study_success,
                "time_scales": stage_summaries,
            }
        )
        overall_success = overall_success and study_success
    summary = {
        "scenario": str(scenario_path),
        "success": overall_success,
        "studies": portfolio,
    }
    (output_dir / "portfolio_summary.json").write_text(
        json.dumps(core._jsonable(summary), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    lines = [
        "# 主配微模組化協同調度總覽",
        "",
        "| 場景 | 範圍 | 狀態 | 時間尺度 |",
        "|---|---|---|---|",
    ]
    for item in portfolio:
        lines.append(
            f"| {item['name']} | {', '.join(item['areas'])} | {'成功' if item['success'] else '失敗'} | {', '.join(stage['name'] for stage in item['time_scales'])} |"
        )
    lines.extend(["", "每個場景/時間尺度子目錄包含報告、完整矩陣與 CSV 校核結果。", ""])
    (output_dir / "portfolio_report.md").write_text("\n".join(lines), encoding="utf-8-sig")
    (output_dir / "scenario_used.json").write_text(
        json.dumps(scenario, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(core._jsonable(summary), ensure_ascii=False, indent=2))
    return 0 if overall_success else 3


def execute_validate(args: argparse.Namespace) -> int:
    scenario_path = args.scenario.resolve()
    scenario = read_json(scenario_path)
    studies = validate_scenario_shape(scenario)
    for study in studies:
        (
            _case_path,
            sidecar,
            _subcase,
            _area_map,
            metadata,
            _boundary_metadata,
            _static_resources,
            _selected_areas,
            _scope,
        ) = load_study_system(scenario_path.parent, scenario.get("system", {}), study)
        for scale in study["time_scales"]:
            modules = unique_modules(study.get("modules"), scale.get("modules"))
            config = merged_module_config(study, scale)
            validate_modules(modules, scale, config)
            periods = load_periods(scenario_path.parent, scale)
            if "storage-soc" in modules:
                names = {item["name"] for item in metadata}
                available = set(storage_specs(sidecar)) & names
                if not available:
                    raise core.InputError(f"Study '{study['name']}' enables storage-soc without storage in scope.")
            if "flexible-load-energy" in modules:
                names = {item["name"] for item in metadata}
                available = set(energy_budget_specs(sidecar)) & names
                if not available:
                    raise core.InputError(
                        f"Study '{study['name']}' enables flexible-load-energy without energy_budget in scope."
                    )
            if sidecar.get("resource_couplings") and "resource-coupling" not in modules:
                raise core.InputError(
                    f"Study '{study['name']}' defines resource_couplings but does not enable resource-coupling."
                )
            if ("ramp-link" in modules or "storage-soc" in modules or "flexible-load-energy" in modules) and len(periods) < 2:
                raise core.InputError(
                    f"Study '{study['name']}' scale '{scale['name']}' enables a temporal-link module but has fewer than two periods."
                )
    print(json.dumps({"valid": True, "studies": [study["name"] for study in studies]}, ensure_ascii=False))
    return 0


def execute_catalog(_args: argparse.Namespace) -> int:
    print(json.dumps({"modules": MODULE_CATALOG, "scope_presets": PRESET_LEVELS}, ensure_ascii=False, indent=2))
    return 0


def execute_template(args: argparse.Namespace) -> int:
    target = args.output.resolve()
    case_value = str(args.case)
    sidecar_value = str(args.sidecar) if args.sidecar else None
    system: dict[str, Any] = {"case": case_value}
    if sidecar_value:
        system["sidecar"] = sidecar_value
    studies: list[dict[str, Any]] = [
        {
            "name": "all-network",
            "scope": "all",
            "modules": ["ac-opf", "area-exchange", "warm-start"],
            "time_scales": [{"name": "base", "step_minutes": 60}],
        }
    ]
    if args.sidecar:
        sidecar_data = read_json(args.sidecar.resolve())
        levels = {str(area.get("level", "")).lower() for area in sidecar_data.get("areas", [])}
        if {"transmission", "distribution", "microgrid"}.issubset(levels):
            studies = [
                {
                    "name": "tdm-joint",
                    "scope": "tdm",
                    "modules": ["ac-opf", "area-exchange", "warm-start"],
                    "time_scales": [{"name": "base", "step_minutes": 60}],
                },
                {
                    "name": "distribution-only",
                    "scope": {
                        "preset": "d",
                        "boundary": {
                            "mode": "equivalent-grid",
                            "default_limit_mva": 100,
                            "energy_price_per_mwh": 50,
                        },
                    },
                    "modules": ["ac-opf", "boundary-equivalent"],
                    "time_scales": [{"name": "base", "step_minutes": 60}],
                },
            ]
    template = {
        "schema_version": 2,
        "system": system,
        "output": "modular-results",
        "studies": studies,
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(template, ensure_ascii=False, indent=2), encoding="utf-8")
    print(str(target))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Compose spatial scopes and temporal modules for T-D-M AC-OPF studies.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    catalog = subparsers.add_parser("catalog", help="List composable modules and scope presets.")
    catalog.set_defaults(func=execute_catalog)
    template = subparsers.add_parser("template", help="Create an editable schema-v2 scenario template.")
    template.add_argument("case", type=Path)
    template.add_argument("--sidecar", type=Path)
    template.add_argument("--output", type=Path, required=True)
    template.set_defaults(func=execute_template)
    validate = subparsers.add_parser("validate", help="Validate scenario composition without solving.")
    validate.add_argument("scenario", type=Path)
    validate.set_defaults(func=execute_validate)
    run = subparsers.add_parser("run", help="Run all configured studies and time scales.")
    run.add_argument("scenario", type=Path)
    run.add_argument("--output", type=Path)
    run.set_defaults(func=execute_run)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return int(args.func(args))
    except (core.InputError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        print(f"INPUT ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
