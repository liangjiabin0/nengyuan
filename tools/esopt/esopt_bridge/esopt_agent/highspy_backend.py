from __future__ import annotations

import json
import re
import tempfile
from pathlib import Path
from typing import Any

_HIGHS_STATUS = {
    7: "Optimal",
    8: "Infeasible",
    9: "Unbounded or infeasible",
    10: "Unbounded",
    13: "Time limit",
    14: "Iteration limit",
}


def _col_name(highs: Any, index: int) -> str:
    try:
        raw = highs.getColName(index)
    except Exception:
        return f"x{index}"
    if isinstance(raw, (tuple, list)):
        raw = raw[-1] if raw else None
    name = str(raw or "").strip()
    return name or f"x{index}"


def highspy_available() -> bool:
    try:
        import highspy  # noqa: F401

        return True
    except Exception:
        return False


def _safe_name(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_]", "_", str(name) or "x")
    if not cleaned or cleaned[0].isdigit():
        cleaned = f"v_{cleaned}"
    return cleaned


def _bound(value: Any, default: float) -> float:
    if value is None or value == "":
        return default
    if isinstance(value, str) and value.lower() in {"inf", "+inf", "infinity"}:
        return 1e30
    if isinstance(value, str) and value.lower() in {"-inf", "-infinity"}:
        return -1e30
    return float(value)


def _write_lp(
    dest: Path,
    *,
    sense: str,
    objective: list[tuple[str, float]],
    quadratic: list[tuple[str, float]],
    offset: float,
    columns: list[dict[str, Any]],
    rows: list[dict[str, Any]],
) -> None:
    lines: list[str] = ["\\ ESOPT highspy fallback"]
    lines.append("Minimize" if str(sense).lower().startswith("min") else "Maximize")
    obj_parts: list[str] = []
    for name, coef in objective:
        if abs(coef) < 1e-15:
            continue
        obj_parts.append(f"{coef:.12g} {name}")
    if quadratic:
        quad = " ".join(f"{coef:.12g} {name} ^ 2" for name, coef in quadratic if abs(coef) > 1e-15)
        if quad:
            obj_parts.append(f"[ {quad} ] / 2")
    if abs(offset) > 1e-12:
        obj_parts.append(f"{offset:.12g}")
    lines.append(" obj: " + (" ".join(obj_parts) if obj_parts else "0"))
    lines.append("Subject To")
    if not rows:
        lines.append(" dummy: 0 = 0")
    for index, row in enumerate(rows):
        name = _safe_name(str(row.get("name") or f"c{index + 1}"))
        terms = [f"{float(coef):.12g} {var}" for var, coef in row["terms"] if abs(float(coef)) > 1e-15]
        if not terms:
            continue
        sense_sym = str(row.get("sense") or "=")
        rhs = float(row.get("rhs") or 0)
        if sense_sym in {"<=", "=<", "le"}:
            op = "<="
        elif sense_sym in {">=", "=>", "ge"}:
            op = ">="
        else:
            op = "="
        lines.append(f" {name}: {' '.join(terms)} {op} {rhs:.12g}")
    lines.append("Bounds")
    binaries: list[str] = []
    generals: list[str] = []
    for col in columns:
        name = col["name"]
        domain = str(col.get("domain") or "continuous").lower()
        lb = _bound(col.get("lb"), -1e30)
        ub = _bound(col.get("ub"), 1e30)
        if domain in {"binary", "bin", "bool"}:
            binaries.append(name)
            continue
        if domain in {"integer", "int", "integ"}:
            generals.append(name)
        if lb <= -1e20 and ub >= 1e20:
            lines.append(f" {name} free")
        elif lb <= -1e20:
            lines.append(f" -inf <= {name} <= {ub:.12g}")
        elif ub >= 1e20:
            lines.append(f" {lb:.12g} <= {name}")
        else:
            lines.append(f" {lb:.12g} <= {name} <= {ub:.12g}")
    if generals:
        lines.append("General")
        lines.extend(f" {name}" for name in generals)
    if binaries:
        lines.append("Binary")
        lines.extend(f" {name}" for name in binaries)
    lines.append("End")
    dest.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _pack_highs_result(
    *,
    status: int,
    objective: float,
    n_col: int,
    n_row: int,
    values: dict[str, float],
    backend: str,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = {
        "ok": status == 7,
        "success": status == 7,
        "engine": "esopt",
        "solver": "ESOPT / HiGHS",
        "backend": backend,
        "termination_status": status,
        "status": _HIGHS_STATUS.get(status, f"status_{status}"),
        "objective": objective,
        "n_variables": n_col,
        "n_constraints": n_row,
        "values": values,
        "command": "model",
    }
    if extra:
        payload.update(extra)
    return payload


def solve_lp_file(path: Path, timeout: int = 120) -> dict[str, Any]:
    import highspy

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
    values: dict[str, float] = {}
    for index, raw in enumerate(col_value):
        if abs(raw) <= 1e-10:
            continue
        values[_col_name(highs, index)] = float(raw)
    return _pack_highs_result(
        status=status,
        objective=objective,
        n_col=n_col,
        n_row=n_row,
        values=values,
        backend="highspy",
        extra={"modelFile": path.name, "mode": path.suffix.lower().lstrip(".") or "lp"},
    )


def solve_linear_spec(spec: dict[str, Any], timeout: int = 120) -> dict[str, Any]:
    if not highspy_available():
        raise RuntimeError("highspy 不可用，且本机没有 esoptc。")
    variables = list(spec.get("variables") or [])
    if not variables:
        raise RuntimeError("模型文件缺少 variables 数组。")
    obj = dict(spec.get("objective") or {})
    obj_terms = obj.get("terms") or []
    if not obj_terms:
        raise RuntimeError("模型文件缺少 objective。")
    name_map = {str(item["name"]): _safe_name(str(item["name"])) for item in variables}
    columns = []
    for item in variables:
        columns.append(
            {
                "name": name_map[str(item["name"])],
                "lb": item.get("lb"),
                "ub": item.get("ub"),
                "domain": item.get("domain") or item.get("type") or "continuous",
            }
        )
    rows = []
    for index, con in enumerate(spec.get("constraints") or []):
        terms = []
        for term in con.get("terms") or []:
            raw = str(term.get("var") or term.get("name") or "")
            if raw not in name_map:
                raise RuntimeError(f"constraint uses unknown variable {raw}")
            terms.append((name_map[raw], float(term.get("coef") or term.get("coefficient") or 0)))
        rhs = float(con.get("rhs") or 0) - float(con.get("constant") or 0)
        rows.append(
            {
                "name": con.get("name") or f"c{index + 1}",
                "terms": terms,
                "sense": con.get("sense") or "=",
                "rhs": rhs,
            }
        )
    objective = []
    for term in obj_terms:
        raw = str(term.get("var") or term.get("name") or "")
        if raw not in name_map:
            raise RuntimeError(f"objective uses unknown variable {raw}")
        objective.append((name_map[raw], float(term.get("coef") or term.get("coefficient") or 0)))
    with tempfile.TemporaryDirectory(prefix="esopt-highspy-") as tmp:
        lp_path = Path(tmp) / "model.lp"
        _write_lp(
            lp_path,
            sense=str(obj.get("sense") or "minimize"),
            objective=objective,
            quadratic=[],
            offset=float(obj.get("constant") or 0),
            columns=columns,
            rows=rows,
        )
        result = solve_lp_file(lp_path, timeout=timeout)
    result["command"] = "model"
    result["backend"] = "highspy"
    restored = {}
    reverse = {lp_name: raw for raw, lp_name in name_map.items()}
    for name, value in (result.get("values") or {}).items():
        restored[reverse.get(name, name)] = value
    result["values"] = restored
    return result


def solve_dcopf_case(case_path: Path, timeout: int = 600) -> dict[str, Any]:
    """Build the same DCOPF as native esoptc.cpp (arc flows, -b, linear cost2+cost3)."""
    if not highspy_available():
        raise RuntimeError("highspy 不可用，且本机没有 esoptc。")
    data = json.loads(Path(case_path).read_text(encoding="utf-8"))
    buses = list(data.get("bus") or [])
    gens = list(data.get("gen") or [])
    branches = list(data.get("branch") or [])
    arcs = list(data.get("arc") or [])
    if not buses or not gens:
        raise RuntimeError(f"算例缺少 bus/gen：{case_path.name}")
    pmin = [float(x) for x in data.get("pmin", [])]
    pmax = [float(x) for x in data.get("pmax", [])]
    rate_a = [float(x) for x in data.get("rate_a", [])]
    bus_ids = [int(item.get("i", index + 1)) for index, item in enumerate(buses)]
    bus_index = {bus_id: index for index, bus_id in enumerate(bus_ids)}
    pd = [float(item.get("pd") or 0) for item in buses]
    ref = [int(x) for x in data.get("ref_buses") or ([bus_ids[0]] if bus_ids else [])]

    columns: list[dict[str, Any]] = []
    va_names: list[str] = []
    for bus_id in bus_ids:
        name = f"va_{bus_id}"
        va_names.append(name)
        columns.append({"name": name, "lb": -1e30, "ub": 1e30, "domain": "continuous"})

    pg_names: list[str] = []
    objective: list[tuple[str, float]] = []
    cost3_offset = 0.0
    for index, gen in enumerate(gens):
        name = f"pg_{index + 1}"
        pg_names.append(name)
        lb = pmin[index] if index < len(pmin) else 0.0
        ub = pmax[index] if index < len(pmax) else 1e30
        columns.append({"name": name, "lb": lb, "ub": ub, "domain": "continuous"})
        objective.append((name, float(gen.get("cost2") or 0)))
        cost3_offset += float(gen.get("cost3") or 0)

    if not arcs:
        # Synthesize directed arcs when the JSON only has undirected branches.
        for index, branch in enumerate(branches):
            f_bus = int(branch.get("f_bus") or 0)
            t_bus = int(branch.get("t_bus") or 0)
            rate = rate_a[index] if index < len(rate_a) else float(branch.get("rate_a") or 1e6)
            arcs.append({"i": len(arcs) + 1, "rate_a": rate, "bus": f_bus})
            branch["f_idx"] = len(arcs)
            arcs.append({"i": len(arcs) + 1, "rate_a": rate, "bus": t_bus})
            branch["t_idx"] = len(arcs)

    p_names: list[str] = []
    for index, arc in enumerate(arcs):
        name = f"p_{index + 1}"
        p_names.append(name)
        rate = float(arc.get("rate_a") or 1e6)
        columns.append({"name": name, "lb": -rate, "ub": rate, "domain": "continuous"})

    rows: list[dict[str, Any]] = []
    for bus_num in ref:
        if bus_num not in bus_index:
            continue
        rows.append(
            {
                "name": f"ref_{bus_num}",
                "terms": [(va_names[bus_index[bus_num]], 1.0)],
                "sense": "=",
                "rhs": 0.0,
            }
        )

    for index, branch in enumerate(branches):
        f_bus = int(branch.get("f_bus") or 0)
        t_bus = int(branch.get("t_bus") or 0)
        if f_bus not in bus_index or t_bus not in bus_index:
            continue
        f_idx = int(branch.get("f_idx") or 0) - 1
        t_idx = int(branch.get("t_idx") or 0) - 1
        b_sus = -float(branch.get("b") or 0.0)
        va_f = va_names[bus_index[f_bus]]
        va_t = va_names[bus_index[t_bus]]
        if 0 <= f_idx < len(p_names):
            rows.append(
                {
                    "name": f"flow_f_{index + 1}",
                    "terms": [(p_names[f_idx], 1.0), (va_f, -b_sus), (va_t, b_sus)],
                    "sense": "=",
                    "rhs": 0.0,
                }
            )
        if 0 <= t_idx < len(p_names):
            rows.append(
                {
                    "name": f"flow_t_{index + 1}",
                    "terms": [(p_names[t_idx], 1.0), (va_t, -b_sus), (va_f, b_sus)],
                    "sense": "=",
                    "rhs": 0.0,
                }
            )

    gens_at: list[list[int]] = [[] for _ in buses]
    for gi, gen in enumerate(gens):
        bus_id = int(gen.get("bus") or 0)
        if bus_id in bus_index:
            gens_at[bus_index[bus_id]].append(gi)
    arcs_at: list[list[int]] = [[] for _ in buses]
    for ai, arc in enumerate(arcs):
        bus_id = int(arc.get("bus") or 0)
        if bus_id in bus_index:
            arcs_at[bus_index[bus_id]].append(ai)

    for bi, bus_id in enumerate(bus_ids):
        terms: list[tuple[str, float]] = []
        for gi in gens_at[bi]:
            terms.append((pg_names[gi], 1.0))
        for ai in arcs_at[bi]:
            terms.append((p_names[ai], -1.0))
        rows.append({"name": f"pb_{bus_id}", "terms": terms, "sense": "=", "rhs": pd[bi]})

    with tempfile.TemporaryDirectory(prefix="esopt-dcopf-") as tmp:
        lp_path = Path(tmp) / "dcopf.lp"
        _write_lp(
            lp_path,
            sense="minimize",
            objective=objective,
            quadratic=[],
            offset=cost3_offset,
            columns=columns,
            rows=rows,
        )
        result = solve_lp_file(lp_path, timeout=timeout)

    values = dict(result.get("values") or {})
    pg_values = {name: float(values.get(name, 0.0)) for name in pg_names}
    total_generation = sum(pg_values.values())
    total_load = sum(pd)
    generator_outputs = []
    for index, gen in enumerate(gens):
        generator_outputs.append(
            {
                "i": int(gen.get("i") or index + 1),
                "bus": int(gen.get("bus") or 0),
                "pg": pg_values.get(pg_names[index], 0.0),
                "pmin": pmin[index] if index < len(pmin) else None,
                "pmax": pmax[index] if index < len(pmax) else None,
                "cost2": float(gen.get("cost2") or 0),
                "cost3": float(gen.get("cost3") or 0),
            }
        )
    result["command"] = "dcopf"
    result["case_name"] = Path(case_path).stem
    result["backend"] = "highspy"
    result["mode"] = "dcopf"
    result["pg"] = pg_values
    result["generator_outputs"] = generator_outputs
    result["n_buses"] = len(buses)
    result["n_generators"] = len(gens)
    result["n_branches"] = len(branches)
    result["n_arcs"] = len(arcs)
    result["total_generation"] = total_generation
    result["total_load"] = total_load
    result["power_balance_error"] = total_generation - total_load
    result["optimal"] = bool(result.get("ok"))
    result["note"] = "Linux highspy DC OPF，公式对齐原生 esoptc（无 esoptc 可执行文件）"
    return result
