#!/usr/bin/env python3
"""Canonical active/reactive resource registry and adapters."""

from __future__ import annotations

import argparse
import copy
import json
import math
import sys
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
VENDOR_DIR = SCRIPT_DIR / "_vendor"
if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))


RESOURCE_CATALOG: dict[str, dict[str, Any]] = {
    "conventional-generator": {
        "representation": "generator-pq",
        "aliases": ["generator", "thermal", "coal", "gas", "diesel", "hydro", "nuclear", "microturbine", "chp", "dispatchable-der"],
        "description": "Dispatchable rotating or prime-mover generation; CHP covers electrical P/Q only unless another coupling is supplied.",
    },
    "renewable-generator": {
        "representation": "generator-pq",
        "aliases": ["renewable", "pv", "solar", "photovoltaic", "wind", "wind-turbine"],
        "description": "Curtailable renewable P with optional inverter P-Q capability and curtailment penalty.",
    },
    "inverter-der": {
        "representation": "generator-pq",
        "aliases": ["inverter", "smart-inverter", "grid-following-inverter", "grid-forming-inverter", "ibr", "fuel-cell"],
        "description": "Generic inverter-based P/Q resource with rating, power-factor, or two-point capability constraints.",
    },
    "storage": {
        "representation": "generator-pq+state",
        "aliases": ["battery", "bess", "pumped-storage", "flywheel", "supercapacitor", "caes"],
        "description": "Bidirectional storage; positive P discharges and negative P charges. Add storage data for SOC linkage.",
    },
    "ev-storage": {
        "representation": "generator-pq+state",
        "aliases": ["ev", "v2g", "electric-vehicle", "charging-station", "ev-aggregator"],
        "description": "EV/charging aggregation represented as bidirectional storage or charging-only flexible demand.",
    },
    "flexible-load": {
        "representation": "negative-generator-pq",
        "aliases": ["demand-response", "dr", "curtailable-load", "interruptible-load", "shiftable-load", "electrolyzer", "heat-pump", "thermostatic-load"],
        "description": "Controllable consumption represented by negative P/Q injection with optional discomfort and energy-budget data.",
    },
    "synchronous-condenser": {
        "representation": "q-only-generator",
        "aliases": ["sync-condenser", "syncon"],
        "description": "Rotating Q-only source/sink with P fixed at zero unless losses are supplied.",
    },
    "statcom": {
        "representation": "q-only-generator",
        "aliases": ["svg", "d-statcom", "dstatcom"],
        "description": "Continuous converter-based reactive source/sink, optionally with active losses.",
    },
    "svc": {
        "representation": "q-only-generator",
        "aliases": ["static-var-compensator"],
        "description": "Continuous reactive source/sink approximation for an SVC.",
    },
    "continuous-capacitor": {
        "representation": "q-only-generator",
        "aliases": ["continuous-capacitor-bank", "continuous-shunt-capacitor"],
        "description": "Continuous relaxation of capacitive Q injection.",
    },
    "continuous-reactor": {
        "representation": "q-only-generator",
        "aliases": ["continuous-shunt-reactor"],
        "description": "Continuous relaxation of inductive Q absorption.",
    },
    "fixed-capacitor": {
        "representation": "fixed-shunt",
        "aliases": ["shunt-capacitor", "fixed-capacitor-bank"],
        "description": "Fixed voltage-dependent capacitive injection through MATPOWER BS.",
    },
    "fixed-reactor": {
        "representation": "fixed-shunt",
        "aliases": ["shunt-reactor", "fixed-shunt-reactor"],
        "description": "Fixed voltage-dependent inductive absorption through MATPOWER BS.",
    },
    "fixed-shunt": {
        "representation": "fixed-shunt",
        "aliases": ["admittance-shunt"],
        "description": "Fixed MATPOWER GS/BS admittance at 1 pu.",
    },
    "fixed-load": {
        "representation": "bus-load",
        "aliases": ["load", "pq-load", "static-load"],
        "description": "Fixed constant-P/Q load added to MATPOWER PD/QD.",
    },
    "boundary-grid": {
        "representation": "generator-pq",
        "aliases": ["external-grid", "grid-import", "slack-equivalent"],
        "description": "External-grid import/export equivalent with signed P/Q bounds and price.",
    },
    "converter-ac-equivalent": {
        "representation": "generator-pq+coupling",
        "aliases": ["converter-terminal", "hvdc-ac-equivalent", "hvdc-terminal", "vsc-hvdc-terminal", "sop-terminal", "soft-open-point-terminal", "upfc-terminal"],
        "description": "AC-side P/Q equivalent only. Use resource_couplings for terminal active-power/loss balance; this does not model DC voltages or DC lines.",
    },
    "acdc-converter": {
        "representation": "requires-acdc-network-solver",
        "aliases": ["hvdc", "vsc-hvdc", "lcc-hvdc", "mtdc", "full-hvdc-converter", "full-vsc-hvdc-converter", "hybrid-acdc-converter"],
        "description": "Full converter with DC-bus voltage, DC-network balance, loss, rating, and control-mode equations. Rejected by the AC-only backend.",
    },
    "generic-pq": {
        "representation": "generator-pq",
        "aliases": ["der", "pq-resource", "generic-resource"],
        "description": "Extension interface for any device expressible by P/Q bounds, cost, rating, fixed PF, or a two-point capability curve.",
    },
}

ALIAS_TO_CANONICAL = {
    alias.lower(): canonical
    for canonical, item in RESOURCE_CATALOG.items()
    for alias in [canonical, *item["aliases"]]
}


class ResourceError(ValueError):
    """Raised when a resource cannot be represented safely."""


def canonical_type(value: Any) -> str | None:
    if value is None:
        return "generic-pq"
    return ALIAS_TO_CANONICAL.get(str(value).strip().lower())


def _bus_index(case: dict[str, Any], bus: int) -> int:
    for index, row in enumerate(case["bus"]):
        if int(round(row[0])) == bus:
            return index
    raise ResourceError(f"Resource references unknown bus {bus}.")


def _float(resource: dict[str, Any], key: str, default: float | None = None) -> float:
    if key in resource:
        return float(resource[key])
    if default is None:
        raise ResourceError(f"Resource '{resource.get('name', '')}' requires '{key}'.")
    return float(default)


def _infer_p_bounds(resource: dict[str, Any], resource_type: str) -> tuple[float, float, float]:
    if resource_type in {"synchronous-condenser", "statcom", "svc", "continuous-capacitor", "continuous-reactor"}:
        p_loss = float(resource.get("active_loss_mw", 0.0))
        return p_loss, p_loss, p_loss
    if resource_type == "flexible-load":
        baseline = _float(resource, "baseline_p_mw", float(resource.get("p_consumption_mw", 0.0)))
        min_consumption = float(resource.get("min_consumption_mw", baseline * (1.0 - float(resource.get("max_curtailment_fraction", 0.0)))))
        max_consumption = float(resource.get("max_consumption_mw", baseline))
        if min_consumption < 0 or max_consumption < min_consumption:
            raise ResourceError(f"Flexible load '{resource.get('name', '')}' has invalid consumption bounds.")
        return -max_consumption, -min_consumption, -baseline
    if resource_type in {"storage", "ev-storage"}:
        pmin = float(resource.get("p_min_mw", -float(resource.get("charge_max_mw", 0.0))))
        pmax = float(resource.get("p_max_mw", float(resource.get("discharge_max_mw", 0.0))))
        initial = float(resource.get("p_initial_mw", 0.0))
        return pmin, pmax, initial
    if resource_type == "renewable-generator":
        available = float(resource.get("available_p_mw", resource.get("p_max_mw", 0.0)))
        pmin = float(resource.get("p_min_mw", 0.0))
        return pmin, available, float(resource.get("p_initial_mw", available))
    pmin = float(resource.get("p_min_mw", resource.get("p_mw", 0.0)))
    pmax = float(resource.get("p_max_mw", resource.get("p_mw", 0.0)))
    return pmin, pmax, float(resource.get("p_initial_mw", resource.get("p_mw", 0.0)))


def _infer_q_bounds(
    resource: dict[str, Any], resource_type: str, pmin: float, pmax: float
) -> tuple[float, float, float]:
    if resource_type == "continuous-capacitor":
        qmax = float(resource.get("q_max_mvar", resource.get("q_rating_mvar", resource.get("q_mvar", 0.0))))
        return float(resource.get("q_min_mvar", 0.0)), qmax, float(resource.get("q_initial_mvar", 0.0))
    if resource_type == "continuous-reactor":
        rating = abs(float(resource.get("q_rating_mvar", resource.get("q_mvar", 0.0))))
        return float(resource.get("q_min_mvar", -rating)), float(resource.get("q_max_mvar", 0.0)), float(resource.get("q_initial_mvar", 0.0))
    if "q_min_mvar" in resource or "q_max_mvar" in resource:
        return (
            float(resource.get("q_min_mvar", 0.0)),
            float(resource.get("q_max_mvar", 0.0)),
            float(resource.get("q_initial_mvar", resource.get("q_mvar", 0.0))),
        )
    rating = resource.get("q_rating_mvar")
    if rating is not None:
        value = abs(float(rating))
        return -value, value, float(resource.get("q_initial_mvar", 0.0))
    s_rating = resource.get("s_rated_mva")
    if s_rating is not None:
        s = abs(float(s_rating))
        max_abs_p = max(abs(pmin), abs(pmax))
        if max_abs_p > s + 1e-9:
            raise ResourceError(f"Resource '{resource.get('name', '')}' has |P| greater than s_rated_mva.")
        q = math.sqrt(max(0.0, s * s - max_abs_p * max_abs_p))
        return -q, q, float(resource.get("q_initial_mvar", 0.0))
    if resource_type == "flexible-load" and resource.get("power_factor"):
        pf = abs(float(resource["power_factor"]))
        if not 0 < pf <= 1:
            raise ResourceError("power_factor must be in (0, 1].")
        slope = math.tan(math.acos(pf)) * float(resource.get("reactive_sign", 1.0))
        values = [slope * pmin, slope * pmax]
        return min(values), max(values), slope * float(resource.get("p_initial_mw", (pmin + pmax) / 2))
    return 0.0, 0.0, float(resource.get("q_initial_mvar", 0.0))


def _capability_curve(
    resource: dict[str, Any], pmin: float, pmax: float, qmin: float, qmax: float
) -> dict[str, float] | None:
    points = resource.get("pq_capability") or resource.get("capability_points")
    if points is not None:
        if not isinstance(points, list) or len(points) != 2:
            raise ResourceError("MATPOWER adapter requires exactly two P-Q capability points.")
        first, second = points
        p1, p2 = float(first["p_mw"]), float(second["p_mw"])
        if p1 >= p2:
            raise ResourceError("P-Q capability point P values must increase strictly.")
        return {
            "p1_mw": p1,
            "p2_mw": p2,
            "q1_min_mvar": float(first["q_min_mvar"]),
            "q1_max_mvar": float(first["q_max_mvar"]),
            "q2_min_mvar": float(second["q_min_mvar"]),
            "q2_max_mvar": float(second["q_max_mvar"]),
        }
    s_rating = resource.get("s_rated_mva")
    if s_rating is not None and pmax > pmin and (pmin >= 0 or pmax <= 0):
        s = abs(float(s_rating))
        q1 = math.sqrt(max(0.0, s * s - pmin * pmin))
        q2 = math.sqrt(max(0.0, s * s - pmax * pmax))
        return {
            "p1_mw": pmin,
            "p2_mw": pmax,
            "q1_min_mvar": max(qmin, -q1),
            "q1_max_mvar": min(qmax, q1),
            "q2_min_mvar": max(qmin, -q2),
            "q2_max_mvar": min(qmax, q2),
        }
    return None


def _linear_pq_constraints(resource: dict[str, Any], normalized: dict[str, Any]) -> list[dict[str, Any]]:
    """Build exact linear P-Q constraints for one sidecar resource.

    These use the generic OPF A/l/u interface instead of MATPOWER's generator
    capability columns, whose built-in validator only accepts one trapezoid
    orientation. The generic form also covers fixed power factor and minimum
    power factor without silently weakening the model.
    """
    name = str(normalized["name"])
    constraints: list[dict[str, Any]] = []
    if resource.get("power_factor") is not None:
        pf = abs(float(resource["power_factor"]))
        if not 0 < pf <= 1:
            raise ResourceError("power_factor must be in (0, 1].")
        slope = math.tan(math.acos(pf)) * float(resource.get("reactive_sign", 1.0))
        constraints.append(
            {
                "name": f"{name}:fixed-power-factor",
                "terms": [
                    {"resource": name, "quantity": "q", "coefficient": 1.0},
                    {"resource": name, "quantity": "p", "coefficient": -slope},
                ],
                "equal": 0.0,
            }
        )
    if resource.get("power_factor_min") is not None:
        pf = abs(float(resource["power_factor_min"]))
        if not 0 < pf <= 1:
            raise ResourceError("power_factor_min must be in (0, 1].")
        pmin = float(normalized["p_min_mw"])
        pmax = float(normalized["p_max_mw"])
        if pmin < 0 < pmax:
            raise ResourceError(
                f"Resource '{name}' has a cross-zero P range; minimum power factor is non-convex there. Split charge/discharge modes or omit power_factor_min."
            )
        sign = 1.0 if pmin >= 0 else -1.0
        slope = math.tan(math.acos(pf))
        # |Q| <= slope * |P|, with a known sign for P.
        for suffix, q_coefficient in (("upper", 1.0), ("lower", -1.0)):
            constraints.append(
                {
                    "name": f"{name}:minimum-power-factor-{suffix}",
                    "terms": [
                        {"resource": name, "quantity": "q", "coefficient": q_coefficient},
                        {"resource": name, "quantity": "p", "coefficient": -sign * slope},
                    ],
                    "upper": 0.0,
                }
            )
    curve = normalized.get("pq_capability")
    if isinstance(curve, dict):
        p1, p2 = float(curve["p1_mw"]), float(curve["p2_mw"])
        for suffix, q1_key, q2_key, bound in (
            ("upper", "q1_max_mvar", "q2_max_mvar", "upper"),
            ("lower", "q1_min_mvar", "q2_min_mvar", "lower"),
        ):
            q1, q2 = float(curve[q1_key]), float(curve[q2_key])
            slope = (q2 - q1) / (p2 - p1)
            intercept = q1 - slope * p1
            constraints.append(
                {
                    "name": f"{name}:pq-capability-{suffix}",
                    "terms": [
                        {"resource": name, "quantity": "q", "coefficient": 1.0},
                        {"resource": name, "quantity": "p", "coefficient": -slope},
                    ],
                    bound: intercept,
                }
            )
    return constraints


def _default_cost(resource: dict[str, Any], resource_type: str, p_initial: float) -> Any:
    if resource.get("cost") is not None:
        return resource["cost"]
    if resource_type == "renewable-generator" and resource.get("curtailment_penalty_per_mwh") is not None:
        return [-float(resource["curtailment_penalty_per_mwh"]), 0.0]
    if resource_type == "flexible-load":
        baseline = abs(float(resource.get("baseline_p_mw", -p_initial)))
        if resource.get("discomfort_quadratic_per_mw2") is not None:
            weight = float(resource["discomfort_quadratic_per_mw2"])
            return [weight, 2.0 * weight * baseline, weight * baseline * baseline]
        if resource.get("curtailment_penalty_per_mwh") is not None:
            return [float(resource["curtailment_penalty_per_mwh"]), 0.0]
    return [0.0, 0.0]


def normalize_dynamic_resource(resource: dict[str, Any], canonical: str) -> dict[str, Any]:
    normalized = copy.deepcopy(resource)
    normalized["original_type"] = str(resource.get("type", resource.get("kind", canonical)))
    normalized["resource_type"] = canonical
    normalized["kind"] = canonical
    pmin, pmax, p_initial = _infer_p_bounds(resource, canonical)
    qmin, qmax, q_initial = _infer_q_bounds(resource, canonical, pmin, pmax)
    control = str(resource.get("control_mode", "pq")).lower()
    if control in {"q-only", "reactive-only"}:
        pmin = pmax = p_initial = float(resource.get("active_loss_mw", 0.0))
    elif control in {"fixed-pq", "fixed"}:
        pmin = pmax = float(resource.get("p_mw", p_initial))
        qmin = qmax = float(resource.get("q_mvar", q_initial))
        p_initial, q_initial = pmin, qmin
    elif control == "fixed-q":
        qmin = qmax = float(resource.get("q_mvar", q_initial))
        q_initial = qmin
    elif control in {"volt-var", "droop"} and resource.get("approximation") != "continuous-q":
        raise ResourceError(
            f"Resource '{resource.get('name', '')}' requests {control}; set approximation='continuous-q' or use a dedicated nonlinear controller."
        )
    if pmin > pmax or qmin > qmax:
        raise ResourceError(f"Resource '{resource.get('name', '')}' has invalid P/Q bounds.")
    normalized.update(
        {
            "p_min_mw": pmin,
            "p_max_mw": pmax,
            "p_initial_mw": min(max(p_initial, pmin), pmax),
            "q_min_mvar": qmin,
            "q_max_mvar": qmax,
            "q_initial_mvar": min(max(q_initial, qmin), qmax),
            "control_mode": control,
            "cost": _default_cost(resource, canonical, p_initial),
        }
    )
    curve = _capability_curve(resource, pmin, pmax, qmin, qmax)
    if curve:
        normalized["pq_capability"] = curve
    return normalized


def apply_static_resource(case: dict[str, Any], resource: dict[str, Any], canonical: str) -> dict[str, Any]:
    bus = int(resource["bus"])
    index = _bus_index(case, bus)
    metadata = {
        "name": str(resource.get("name", f"{canonical}-{bus}")),
        "resource_type": canonical,
        "kind": canonical,
        "bus": bus,
        "representation": RESOURCE_CATALOG[canonical]["representation"],
    }
    if canonical == "fixed-load":
        p = float(resource.get("p_mw", resource.get("p_consumption_mw", 0.0)))
        q = float(resource.get("q_mvar", resource.get("q_consumption_mvar", 0.0)))
        case["bus"][index, 2] += p
        case["bus"][index, 3] += q
        metadata.update({"p_mw": p, "q_mvar": q})
    else:
        if canonical == "fixed-capacitor":
            b = abs(float(resource.get("b_mvar_at_1pu", resource.get("q_mvar", resource.get("q_rating_mvar", 0.0)))))
            g = float(resource.get("g_mw_at_1pu", 0.0))
        elif canonical == "fixed-reactor":
            b = -abs(float(resource.get("b_mvar_at_1pu", resource.get("q_mvar", resource.get("q_rating_mvar", 0.0)))))
            g = float(resource.get("g_mw_at_1pu", 0.0))
        else:
            b = float(resource.get("b_mvar_at_1pu", 0.0))
            g = float(resource.get("g_mw_at_1pu", 0.0))
        case["bus"][index, 4] += g
        case["bus"][index, 5] += b
        metadata.update({"g_mw_at_1pu": g, "b_mvar_at_1pu": b})
    return metadata


def prepare_config(case: dict[str, Any], config: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    prepared = copy.deepcopy(config)
    dc_network_keys = ("dc_networks", "dc_buses", "dc_branches", "busdc", "branchdc", "convdc")
    if any(prepared.get(key) is not None for key in dc_network_keys) or any(
        case.get(key) is not None for key in dc_network_keys
    ):
        raise ResourceError(
            "A full DC network was supplied, but this backend is AC-OPF. Use an explicit AC-side HVDC equivalent or a dedicated AC/DC coupled solver; DC states will not be ignored."
        )
    if prepared.get("dcline") is not None or case.get("dcline") is not None:
        raise ResourceError(
            "A MATPOWER/PYPOWER dcline extension was supplied. Convert it explicitly to two converter-ac-equivalent terminals plus a resource_coupling, or use a solver that natively supports dcline; it will not be ignored."
        )
    dynamic: list[dict[str, Any]] = []
    static: list[dict[str, Any]] = []
    automatic_constraints: list[dict[str, Any]] = []
    names: set[str] = set()
    for position, resource in enumerate(prepared.get("resources", []), start=1):
        if not isinstance(resource, dict):
            raise ResourceError("Each resource must be an object.")
        name = str(resource.get("name", f"resource-{position}"))
        if name in names:
            raise ResourceError(f"Duplicate resource name '{name}'.")
        names.add(name)
        resource["name"] = name
        raw_type = resource.get("type", resource.get("kind", "generic-pq"))
        canonical = canonical_type(raw_type)
        if canonical is None:
            explicit = all(key in resource for key in ("p_min_mw", "p_max_mw", "q_min_mvar", "q_max_mvar"))
            if not explicit:
                raise ResourceError(
                    f"Unknown resource type '{raw_type}' for '{name}'. Supply explicit P/Q bounds to use the generic-pq adapter."
                )
            canonical = "generic-pq"
            resource["unregistered_type"] = str(raw_type)
        representation = RESOURCE_CATALOG[canonical]["representation"]
        if representation == "requires-acdc-network-solver":
            raise ResourceError(
                f"Resource '{name}' requires a full AC/DC coupled solver. The current backend only supports converter-ac-equivalent."
            )
        if representation in {"fixed-shunt", "bus-load"}:
            static.append(apply_static_resource(case, resource, canonical))
        else:
            normalized = normalize_dynamic_resource(resource, canonical)
            dynamic.append(normalized)
            automatic_constraints.extend(_linear_pq_constraints(resource, normalized))
    prepared["resources"] = dynamic
    prepared["static_resources"] = static
    prepared["resource_constraints"] = automatic_constraints
    return prepared, static


def apply_linear_couplings(
    case: dict[str, Any],
    metadata: list[dict[str, Any]],
    couplings: list[dict[str, Any]],
    dc: bool = False,
) -> list[str]:
    if not couplings:
        return []
    import numpy as np
    from scipy.sparse import csr_matrix, vstack

    nb, ng = case["bus"].shape[0], case["gen"].shape[0]
    nx = nb + ng if dc else 2 * nb + 2 * ng
    name_to_index = {str(item["name"]): index for index, item in enumerate(metadata)}
    rows, lower, upper, applied = [], [], [], []
    base = float(case["baseMVA"])
    for coupling in couplings:
        terms = coupling.get("terms", [])
        mentioned = [str(term["resource"]) for term in terms]
        present = [name in name_to_index for name in mentioned]
        if not any(present):
            continue
        if not all(present):
            missing = [name for name, exists in zip(mentioned, present) if not exists]
            if coupling.get("allow_partial_scope", False):
                continue
            raise ResourceError(
                f"Coupling '{coupling.get('name', '')}' is split by the selected scope; missing resources: {', '.join(missing)}."
            )
        row = np.zeros(nx)
        for term in terms:
            quantity = str(term.get("quantity", "p")).lower()
            index = name_to_index[str(term["resource"])]
            coefficient = float(term.get("coefficient", 1.0))
            if quantity == "p":
                column = nb + index if dc else 2 * nb + index
            elif quantity == "q":
                if dc:
                    raise ResourceError("Reactive-power coupling is unavailable in DC mode.")
                column = 2 * nb + ng + index
            else:
                raise ResourceError("Coupling quantity must be 'p' or 'q'.")
            row[column] += coefficient
        if "equal" in coupling:
            lo = hi = float(coupling["equal"])
        else:
            lo = float(coupling.get("lower", -math.inf))
            hi = float(coupling.get("upper", math.inf))
        rows.append(row)
        lower.append(lo / base if math.isfinite(lo) else lo)
        upper.append(hi / base if math.isfinite(hi) else hi)
        applied.append(str(coupling.get("name", f"coupling-{len(applied) + 1}")))
    if not rows:
        return []
    new_a = csr_matrix(np.asarray(rows))
    if "A" in case and getattr(case["A"], "shape", (0, 0))[0] > 0:
        if case["A"].shape[1] != nx:
            raise ResourceError("Existing case A matrix width does not match the current OPF variable count.")
        case["A"] = vstack([case["A"], new_a]).tocsr()
        case["l"] = np.r_[case["l"], np.asarray(lower)]
        case["u"] = np.r_[case["u"], np.asarray(upper)]
    else:
        case["A"] = new_a
        case["l"] = np.asarray(lower)
        case["u"] = np.asarray(upper)
    return applied


def evaluate_linear_couplings(
    result: dict[str, Any],
    metadata: list[dict[str, Any]],
    couplings: list[dict[str, Any]],
    period: str,
) -> list[dict[str, Any]]:
    """Evaluate configured P/Q couplings in external generator order."""
    name_to_index = {str(item["name"]): index for index, item in enumerate(metadata)}
    rows: list[dict[str, Any]] = []
    for coupling in couplings:
        terms = coupling.get("terms", [])
        mentioned = [str(term["resource"]) for term in terms]
        present = [name in name_to_index for name in mentioned]
        if not any(present) or not all(present):
            continue
        lhs = 0.0
        for term in terms:
            index = name_to_index[str(term["resource"])]
            quantity = str(term.get("quantity", "p")).lower()
            column = 1 if quantity == "p" else 2
            lhs += float(term.get("coefficient", 1.0)) * float(result["gen"][index, column])
        if "equal" in coupling:
            lower = upper = float(coupling["equal"])
            equality_residual = lhs - lower
        else:
            lower = float(coupling.get("lower", -math.inf))
            upper = float(coupling.get("upper", math.inf))
            equality_residual = None
        violation = max(lower - lhs if math.isfinite(lower) else 0.0, lhs - upper if math.isfinite(upper) else 0.0, 0.0)
        tolerance = abs(float(coupling.get("audit_tolerance", 1e-5)))
        rows.append(
            {
                "period": period,
                "name": str(coupling.get("name", f"coupling-{len(rows) + 1}")),
                "lhs": lhs,
                "lower": lower if math.isfinite(lower) else None,
                "upper": upper if math.isfinite(upper) else None,
                "equality_residual": equality_residual,
                "violation": violation,
                "audit_tolerance": tolerance,
                "satisfied": violation <= tolerance,
            }
        )
    return rows


def execute_catalog(_args: argparse.Namespace) -> int:
    print(json.dumps({"resource_types": RESOURCE_CATALOG}, ensure_ascii=False, indent=2))
    return 0


def execute_validate(args: argparse.Namespace) -> int:
    import tdmg_opf as core

    case = core.load_power_case(args.case.resolve())
    config = json.loads(args.sidecar.resolve().read_text(encoding="utf-8-sig"))
    prepared, static = prepare_config(case, config)
    added = core.add_resources(case, prepared)
    metadata = core.build_generator_metadata(case, added)
    print(
        json.dumps(
            {
                "valid": True,
                "dynamic_resources": metadata[-len(added) :] if added else [],
                "static_resources": static,
                "resource_couplings": len(prepared.get("resource_couplings", [])),
                "automatic_resource_constraints": len(prepared.get("resource_constraints", [])),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="List and validate canonical active/reactive resource models.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    catalog = subparsers.add_parser("catalog")
    catalog.set_defaults(func=execute_catalog)
    validate = subparsers.add_parser("validate")
    validate.add_argument("case", type=Path)
    validate.add_argument("sidecar", type=Path)
    validate.set_defaults(func=execute_validate)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return int(args.func(args))
    except (ResourceError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        print(f"RESOURCE ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
