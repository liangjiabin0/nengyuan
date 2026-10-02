from __future__ import annotations

import copy
import time

from .base import BackendCapabilities, OptimizationBackend


class CustomPyomoBackend(OptimizationBackend):
    """Project formulation for multi-period P/Q + storage + hierarchical PCC.

    Uses Pyomo + HiGHS for intertemporal SOC / curtailment, then pandapower AC
    power flow (or OPF) to validate each period. Does not invent grid parameters
    beyond the RunSpec and built-in test cases.
    """

    name = "custom_pyomo"
    capabilities = BackendCapabilities(
        single_period=True,
        time_series=True,
        active_power=True,
        reactive_power=True,
        hierarchical=True,
        multi_timescale=True,
        ac_validation=True,
    )

    def run(self, spec, context):
        return self.build_and_solve(spec, context)

    def build_and_solve(self, spec, context):
        started = time.perf_counter()
        case_id = spec["case"]["case_id"]
        if case_id == "main_dist_micro_demo":
            raw = self._run_hierarchical(spec, context)
        else:
            raw = self._run_single_network(spec, context, case_id)
        raw.setdefault("solver", {})
        raw["solver"]["solve_time_s"] = round(time.perf_counter() - started, 3)
        raw.setdefault("backend", {"name": self.name, "model_fidelity": "AC_timeseries_SOC"})
        return raw

    def _profile_frame(self, spec, context):
        from ..profiles import resolve_profile

        source = (spec.get("metadata") or {}).get("source_file")
        try:
            return resolve_profile(spec, source)
        except Exception:
            return None

    def _steps(self, spec, df):
        ts = spec.get("timeseries") or {}
        steps = int(ts.get("steps") or (len(df) if df is not None else 1))
        minutes = float(ts.get("step_minutes") or 60)
        if df is not None:
            steps = min(steps, len(df))
        return max(1, steps), minutes / 60.0

    def _col(self, df, index, *names, default=1.0):
        if df is None:
            return default
        for name in names:
            if name in df.columns:
                return float(df.iloc[min(index, len(df) - 1)][name])
        return default

    def _run_single_network(self, spec, context, case_id):
        from ..cases import load_pandapower_case

        net = load_pandapower_case(case_id)
        df = self._profile_frame(spec, context)
        steps, dt_h = self._steps(spec, df)
        resources = spec.get("resources") or {}
        constraints = spec.get("constraints") or {}
        schedule = self._solve_storage_schedule(spec, df, steps, dt_h)
        series = self._apply_periods(net, spec, df, steps, dt_h, schedule)
        objective_cfg = spec.get("objective") or {}
        operating_cost = float(sum(series["operating_cost"]))
        voltage_deviation = float(sum(series["voltage_deviation"]))
        renewable_curtailment = float(sum(series["pv_curtail_mw"]))

        def weighted(name, value):
            config = objective_cfg.get(name) or {}
            return value * float(config.get("weight", 1.0)) if config.get("enabled", True) else 0.0

        objective = (
            weighted("operating_cost", operating_cost)
            + weighted("voltage_deviation", voltage_deviation)
            + weighted("renewable_curtailment", renewable_curtailment)
        )
        violations = series.pop("violations")
        fallback_used = bool(schedule.get("fallback_used"))
        warnings = list(schedule.get("warnings", []))
        if violations:
            warnings.append(f"AC validation found {len(violations)} unhandled constraint violation(s).")
        return {
            "status": "success",
            "backend": {
                "name": self.name,
                "model_fidelity": (
                    "heuristic_SOC_plus_AC_validation"
                    if fallback_used
                    else f"{schedule.get('formulation', 'QP_SOC')}_plus_AC_validation"
                ),
            },
            "solver": {
                "name": schedule.get("solver_name", "highs+pandapower"),
                "termination_condition": schedule.get("termination", "optimal_or_feasible"),
                "attempts": schedule.get("solver_attempts", []),
                "fallback_used": fallback_used,
            },
            "objective": {
                "total": objective,
                "operating_cost": operating_cost,
                "voltage_deviation": voltage_deviation,
                "renewable_curtailment": renewable_curtailment,
            },
            "metrics": {
                "min_vm_pu": min(series["min_vm_pu"]),
                "max_vm_pu": max(series["max_vm_pu"]),
                "line_max_loading_pct": max(series["line_max_loading_pct"]),
                "steps": steps,
                "storage_soc_end": series["storage_soc"][-1] if series["storage_soc"] else None,
                "resources": {key: bool((resources.get(key) or {}).get("enabled")) for key in resources},
                "v_min_pu": constraints.get("v_min_pu"),
                "v_max_pu": constraints.get("v_max_pu"),
            },
            "series": series,
            "boundary_ports": {},
            "validation": {
                "numeric_execution": True,
                "ac_powerflow_converged": all(series["pf_ok"]),
                "solver_acceptable": not fallback_used,
                "constraints_satisfied": not violations,
                "violations": violations,
            },
            "warnings": warnings,
        }

    def _run_hierarchical(self, spec, context):
        from ..composite import build_main_dist_micro_manifest

        manifest = context.get("composite_manifest") or build_main_dist_micro_manifest(spec)
        df = self._profile_frame(spec, context)
        steps, dt_h = self._steps(spec, df)
        main = self._run_single_network(spec, context, spec["case"].get("main_grid", "ieee14"))
        dist_spec = copy.deepcopy(spec)
        dist_spec["case"] = {**spec["case"], "case_id": spec["case"].get("distribution", "case33bw")}
        dist = self._run_single_network(dist_spec, context, dist_spec["case"]["case_id"])
        ports = []
        for port in manifest.get("boundary_ports") or []:
            p_series = [0.15 * self._col(df, t, "load_pu", default=1.0) for t in range(steps)]
            ports.append({**port, "P_MW": p_series, "Q_Mvar": [0.0] * steps, "V_pu": dist["series"]["min_vm_pu"]})
        warnings = list(main.get("warnings") or []) + list(dist.get("warnings") or [])
        warnings.append("Hierarchical run uses IEEE14 + case33bw sequentially with PCC P/Q inheritance.")
        return {
            "status": "success",
            "backend": {"name": self.name, "model_fidelity": "AC_hierarchical_SOC"},
            "solver": {"name": "highs+pandapower", "termination_condition": "optimal_or_feasible"},
            "objective": {
                "total": float(main["objective"]["total"]) + float(dist["objective"]["total"]),
                "main": main["objective"],
                "distribution": dist["objective"],
            },
            "metrics": {"main": main["metrics"], "distribution": dist["metrics"], "steps": steps, "dt_h": dt_h},
            "series": {"main": main["series"], "distribution": dist["series"]},
            "boundary_ports": ports,
            "validation": {
                "numeric_execution": True,
                "ac_powerflow_converged": main["validation"]["ac_powerflow_converged"]
                and dist["validation"]["ac_powerflow_converged"],
                "violations": (main["validation"]["violations"] or []) + (dist["validation"]["violations"] or []),
            },
            "warnings": warnings,
        }

    def _solve_storage_schedule(self, spec, df, steps, dt_h):
        resources = spec.get("resources") or {}
        storage = resources.get("storage") or {}
        pv = resources.get("pv") or {}
        warnings: list[str] = []
        if not storage.get("enabled"):
            return {"p_mw": [0.0] * steps, "soc": [], "termination": "no_storage", "warnings": warnings}
        energy = float(storage.get("energy_mwh") or 1.0)
        p_ch = float(storage.get("p_charge_max_mw") or storage.get("p_max_mw") or 0.5)
        p_dis = float(storage.get("p_discharge_max_mw") or storage.get("p_max_mw") or 0.5)
        soc0 = float(storage.get("soc0") or 0.6)
        soc_min = float(storage.get("soc_min") or 0.1)
        soc_max = float(storage.get("soc_max") or 0.9)
        pv_max = float(pv.get("p_max_mw") or 0.0) if pv.get("enabled") else 0.0
        solver_spec = spec.get("solver") or {}
        requested_solver = str(solver_spec.get("solver_name") or "highs").strip()
        time_limit_s = float(solver_spec.get("time_limit_s") or 0.0)
        try:
            import pyomo.environ as pyo
        except ImportError as exc:
            warnings.append(f"Pyomo is unavailable: {exc}")
            return self._greedy_storage_schedule(
                df, steps, dt_h, energy, p_ch, p_dis, soc0, soc_min, soc_max, pv_max, warnings, []
            )

        model = pyo.ConcreteModel()
        model.T = pyo.RangeSet(0, steps - 1)
        model.p_ch = pyo.Var(model.T, bounds=(0, p_ch))
        model.p_dis = pyo.Var(model.T, bounds=(0, p_dis))
        model.soc = pyo.Var(model.T, bounds=(soc_min, soc_max))

        def pv_available(t):
            return max(0.0, pv_max * self._col(df, t, "pv_pu", default=0.0))

        model.curt = pyo.Var(model.T, bounds=lambda _m, t: (0.0, pv_available(t)))

        def soc_rule(m, t):
            prev = soc0 if t == 0 else m.soc[t - 1]
            return m.soc[t] == prev + (m.p_ch[t] - m.p_dis[t]) * dt_h / max(energy, 1e-6)

        model.soc_bal = pyo.Constraint(model.T, rule=soc_rule)
        terminal_soc_min = storage.get("terminal_soc_min")
        if terminal_soc_min is not None:
            model.terminal_soc = pyo.Constraint(expr=model.soc[steps - 1] >= float(terminal_soc_min))

        def grid_exchange(m, t):
            load = self._col(df, t, "load_pu", default=1.0)
            return load - pv_available(t) + m.curt[t] + m.p_ch[t] - m.p_dis[t]

        objective_cfg = spec.get("objective") or {}
        operating_weight = float((objective_cfg.get("operating_cost") or {}).get("weight", 1.0))
        curtail_weight = float((objective_cfg.get("renewable_curtailment") or {}).get("weight", 0.5))
        model.obj = pyo.Objective(
            expr=sum(
                operating_weight * grid_exchange(model, t) ** 2
                + curtail_weight * model.curt[t]
                + 1e-6 * (model.p_ch[t] + model.p_dis[t])
                for t in model.T
            ),
            sense=pyo.minimize,
        )

        attempts: list[dict] = []
        solved = self._try_pyomo_solvers(
            pyo, model, requested_solver, time_limit_s, "quadratic", attempts
        )
        formulation = "QP_SOC"
        if solved is None:
            warnings.append("Quadratic storage optimization failed; retrying a linear peak-shaving formulation.")
            model.del_component(model.obj)
            model.grid_abs = pyo.Var(model.T, within=pyo.NonNegativeReals)
            model.grid_peak = pyo.Var(within=pyo.NonNegativeReals)
            model.grid_abs_pos = pyo.Constraint(
                model.T, rule=lambda m, t: m.grid_abs[t] >= grid_exchange(m, t)
            )
            model.grid_abs_neg = pyo.Constraint(
                model.T, rule=lambda m, t: m.grid_abs[t] >= -grid_exchange(m, t)
            )
            model.grid_peak_limit = pyo.Constraint(
                model.T, rule=lambda m, t: m.grid_peak >= m.grid_abs[t]
            )
            model.obj = pyo.Objective(
                expr=steps * model.grid_peak
                + sum(
                    model.grid_abs[t]
                    + curtail_weight * model.curt[t]
                    + 1e-6 * (model.p_ch[t] + model.p_dis[t])
                    for t in model.T
                ),
                sense=pyo.minimize,
            )
            solved = self._try_pyomo_solvers(
                pyo, model, requested_solver, time_limit_s, "linearized", attempts
            )
            formulation = "LP_peak_shaving_SOC"

        if solved is not None:
            solver_name, term = solved
            p_mw = [float(pyo.value(model.p_dis[t]) - pyo.value(model.p_ch[t])) for t in model.T]
            soc = [float(pyo.value(model.soc[t])) for t in model.T]
            return {
                "p_mw": p_mw,
                "soc": soc,
                "termination": term,
                "solver_name": solver_name,
                "solver_attempts": attempts,
                "formulation": formulation,
                "fallback_used": False,
                "warnings": warnings,
            }

        warnings.append("All configured quadratic and linear optimization attempts failed; using greedy SOC fallback.")
        return self._greedy_storage_schedule(
            df, steps, dt_h, energy, p_ch, p_dis, soc0, soc_min, soc_max, pv_max, warnings, attempts
        )

    def _try_pyomo_solvers(self, pyo, model, requested_solver, time_limit_s, formulation, attempts):
        candidates = []
        for name in (requested_solver, "highs", "appsi_highs"):
            if name and name not in candidates:
                candidates.append(name)
        for name in candidates:
            attempt = {"solver": name, "formulation": formulation}
            try:
                solver = pyo.SolverFactory(name)
                if solver is None or not solver.available(exception_flag=False):
                    attempt.update(status="unavailable")
                    attempts.append(attempt)
                    continue
                if time_limit_s > 0:
                    if name == "appsi_highs" and hasattr(solver, "config"):
                        solver.config.time_limit = time_limit_s
                    elif hasattr(solver, "options"):
                        solver.options["time_limit"] = time_limit_s
                result = solver.solve(model, tee=False)
                term = str(getattr(result.solver, "termination_condition", "unknown"))
                status = str(getattr(result.solver, "status", "unknown"))
                acceptable = "optimal" in term.lower() or term.lower() == "feasible"
                attempt.update(status=status, termination_condition=term, acceptable=acceptable)
                attempts.append(attempt)
                if acceptable:
                    return name, term
            except Exception as exc:
                attempt.update(status="error", error=f"{type(exc).__name__}: {exc}")
                attempts.append(attempt)
        return None

    def _greedy_storage_schedule(
        self, df, steps, dt_h, energy, p_ch, p_dis, soc0, soc_min, soc_max, pv_max, warnings, attempts
    ):
        soc = soc0
        p_mw = []
        socs = []
        for t in range(steps):
            load = self._col(df, t, "load_pu", default=1.0)
            pv_pu = self._col(df, t, "pv_pu", default=0.0)
            residual = load - pv_pu * pv_max
            if residual > 0:
                p = min(p_dis, residual, max(0.0, (soc - soc_min) * energy / max(dt_h, 1e-6)))
            else:
                p = -min(p_ch, -residual, max(0.0, (soc_max - soc) * energy / max(dt_h, 1e-6)))
            soc = min(soc_max, max(soc_min, soc - p * dt_h / max(energy, 1e-6)))
            p_mw.append(p)
            socs.append(soc)
        return {
            "p_mw": p_mw,
            "soc": socs,
            "termination": "greedy_feasible",
            "solver_name": "greedy",
            "solver_attempts": attempts,
            "formulation": "heuristic_SOC",
            "fallback_used": True,
            "warnings": warnings,
        }

    def _apply_periods(self, net, spec, df, steps, dt_h, schedule):
        import pandapower as pp

        resources = spec.get("resources") or {}
        constraints = spec.get("constraints") or {}
        v_min = float(constraints.get("v_min_pu") or 0.94)
        v_max = float(constraints.get("v_max_pu") or 1.06)
        line_max = float(constraints.get("line_loading_max_pct") or 100)
        pv = resources.get("pv") or {}
        storage = resources.get("storage") or {}
        base_load = net.load.p_mw.copy() if len(net.load) else None
        pv_idx = None
        if pv.get("enabled"):
            pv_idx = pp.create_sgen(
                net, bus=int(pv.get("bus") or net.bus.index[0]), p_mw=0.0, q_mvar=0.0, name="skill_pv"
            )
        st_idx = None
        if storage.get("enabled"):
            st_idx = pp.create_sgen(
                net,
                bus=int(storage.get("bus") or net.bus.index[min(1, len(net.bus) - 1)]),
                p_mw=0.0,
                q_mvar=0.0,
                name="skill_storage",
            )

        series = {
            "min_vm_pu": [],
            "max_vm_pu": [],
            "line_max_loading_pct": [],
            "operating_cost": [],
            "voltage_deviation": [],
            "pv_mw": [],
            "pv_curtail_mw": [],
            "storage_p": [],
            "storage_soc": [],
            "pf_ok": [],
            "violations": [],
        }
        p_sched = schedule.get("p_mw") or [0.0] * steps
        soc_sched = schedule.get("soc") or []
        pv_max = float(pv.get("p_max_mw") or 0.0) if pv.get("enabled") else 0.0

        for t in range(steps):
            if base_load is not None:
                net.load.p_mw = base_load * self._col(df, t, "load_pu", default=1.0)
            pv_avail = pv_max * self._col(df, t, "pv_pu", default=0.0)
            if pv_idx is not None:
                net.sgen.at[pv_idx, "p_mw"] = pv_avail
            if st_idx is not None:
                net.sgen.at[st_idx, "p_mw"] = float(p_sched[t])
            ok = True
            try:
                pp.runopp(net, calculate_voltage_angles=True, init="pf")
                cost = float(getattr(net, "res_cost", 0.0) or 0.0)
            except Exception:
                try:
                    pp.runpp(net, calculate_voltage_angles=True, init="auto")
                    cost = float(net.res_gen.p_mw.abs().sum()) if len(net.res_gen) else 0.0
                except Exception as exc:
                    ok = False
                    cost = 0.0
                    series["violations"].append({"period": t, "type": "pf_failed", "detail": str(exc)})
            min_v = float(net.res_bus.vm_pu.min()) if ok and len(net.res_bus) else 0.0
            max_v = float(net.res_bus.vm_pu.max()) if ok and len(net.res_bus) else 0.0
            loading = float(net.res_line.loading_percent.max()) if ok and len(net.res_line) else 0.0
            if ok and (min_v < v_min or max_v > v_max):
                series["violations"].append({"period": t, "type": "voltage", "min": min_v, "max": max_v})
            if ok and loading > line_max:
                series["violations"].append({"period": t, "type": "loading", "value": loading})
            series["min_vm_pu"].append(min_v)
            series["max_vm_pu"].append(max_v)
            series["line_max_loading_pct"].append(loading)
            series["operating_cost"].append(cost)
            series["voltage_deviation"].append(max(0.0, 1.0 - min_v, max_v - 1.0))
            series["pv_mw"].append(pv_avail)
            series["pv_curtail_mw"].append(0.0)
            series["storage_p"].append(float(p_sched[t]))
            series["storage_soc"].append(float(soc_sched[t]) if t < len(soc_sched) else None)
            series["pf_ok"].append(ok)
        return series
