"""Task adapters. All values below come from the native engine, never canned results."""

from itertools import combinations
from pathlib import Path
import math
import os


def contained_file(filename):
    root = Path(os.environ["POWERIO_MCP_ALLOWED_ROOTS"]).resolve()
    source = Path(filename).resolve(strict=True)
    if not source.is_relative_to(root) or not source.is_file():
        raise ValueError("模型文件不在当前任务目录")
    return source


def failure(status, message):
    return dict(
        solverStatus=status,
        criteriaStatus="not_evaluated",
        message=message,
        series=[],
        tables={},
        metrics={},
    )


def static_analysis(filename, config):
    import pandapower as pp
    import numpy as np

    network = pp.from_json(str(contained_file(filename)))
    analysis = config.get("analysis", "ac_flow")
    if analysis in ["ac_opf", "dc_opf"]:
        network.ext_grid["controllable"] = True
        for name in ["gen", "ext_grid"]:
            network[name]["min_vm_pu"] = config["voltageMinPu"]
            network[name]["max_vm_pu"] = config["voltageMaxPu"]
    network.bus["min_vm_pu"] = config["voltageMinPu"]
    network.bus["max_vm_pu"] = config["voltageMaxPu"]
    for name in ["line", "trafo"]:
        network[name]["max_loading_percent"] = config["loadingMaxPercent"]

    def solve():
        if analysis == "dc_flow":
            pp.rundcpp(
                network, calculate_voltage_angles=config.get("calculateAngles", True)
            )
        elif analysis in ["ac_opf", "dc_opf"]:
            if network.poly_cost.empty and network.pwl_cost.empty:
                raise ValueError("最优潮流需要算例中提供发电成本，系统不自动编造成本")
            (pp.runopp if analysis == "ac_opf" else pp.rundcopp)(network, verbose=False)
        else:
            pp.runpp(
                network,
                algorithm=config.get("algorithm", "nr"),
                max_iteration=config.get("maxIterations", 30),
                tolerance_mva=config["toleranceMva"],
                calculate_voltage_angles=config.get("calculateAngles", True),
            )
        if not np.isfinite(network.res_bus.vm_pu.to_numpy()).all():
            raise pp.LoadflowNotConverged("退出场景形成孤岛或存在未供电母线")

    def summary():
        buses = [
            dict(
                id=str(idx),
                voltagePu=float(row.vm_pu),
                angleDegree=float(row.va_degree),
            )
            for idx, row in network.res_bus.iterrows()
        ]
        branches = []
        for name in ["line", "trafo"]:
            for idx, row in network["res_" + name].iterrows():
                if math.isfinite(row.loading_percent):
                    branches.append(
                        dict(
                            id=name + ":" + str(idx),
                            loadingPercent=float(row.loading_percent),
                        )
                    )
        violations = []
        if analysis not in ["dc_flow", "dc_opf"]:
            violations += [
                dict(object="bus:" + b["id"], metric="voltagePu", value=b["voltagePu"])
                for b in buses
                if not config["voltageMinPu"]
                <= b["voltagePu"]
                <= config["voltageMaxPu"]
            ]
        violations += [
            dict(object=b["id"], metric="loadingPercent", value=b["loadingPercent"])
            for b in branches
            if b["loadingPercent"] > config["loadingMaxPercent"]
        ]
        metrics = dict(
            minVoltagePu=min(b["voltagePu"] for b in buses),
            maxVoltagePu=max(b["voltagePu"] for b in buses),
            maxLoadingPercent=max((b["loadingPercent"] for b in branches), default=0),
            lossMw=float(
                sum(network["res_" + name].pl_mw.sum() for name in ["line", "trafo"])
            ),
            violationCount=len(violations),
        )
        if analysis in ["ac_opf", "dc_opf"]:
            metrics["objective"] = float(network.res_cost)
        return buses, branches, violations, metrics

    try:
        solve()
        buses, branches, violations, metrics = summary()
    except pp.OPFNotConverged:
        return failure(
            "diverged",
            "最优潮流未收敛；请检查约束、成本和初始模型，不能据此断言数学不可行",
        )
    except pp.LoadflowNotConverged:
        return failure("diverged", "潮流未收敛；请检查孤岛、负荷、算法、容差和迭代次数")
    scenarios = []
    if analysis in ["n_minus_1", "n_minus_2"]:
        available = {
            kind + ":" + str(i): (kind, i)
            for kind in ["line", "trafo"]
            for i in network[kind].index[network[kind].in_service]
        }
        requested = config.get("contingencyElements") or list(available)
        if len(set(requested)) != len(requested) or any(
            key not in available for key in requested
        ):
            raise ValueError("故障设备不存在、已停运或重复")
        size = 1 if analysis == "n_minus_1" else 2
        if len(requested) < size:
            raise ValueError("故障设备数量不足")
        count = math.comb(len(requested), size)
        if count > 5000:
            raise ValueError("故障组合超过 5000 项，请明确缩小设备集后运行")
        for outage in combinations(requested, size):
            for key in outage:
                name, index = available[key]
                network[name].at[index, "in_service"] = False
            try:
                solve()
                _, _, errors, m = summary()
                scenarios.append(
                    dict(
                        outage=",".join(outage),
                        status="converged",
                        violations=len(errors),
                        minVoltagePu=m["minVoltagePu"],
                        maxLoadingPercent=m["maxLoadingPercent"],
                    )
                )
            except pp.LoadflowNotConverged:
                scenarios.append(
                    dict(
                        outage=",".join(outage),
                        status="nonconverged_or_island",
                        violations=0,
                        minVoltagePu="",
                        maxLoadingPercent="",
                    )
                )
            finally:
                for key in outage:
                    name, index = available[key]
                    network[name].at[index, "in_service"] = True
        metrics.update(
            scenarioCount=len(scenarios),
            failedScenarios=sum(s["status"] != "converged" for s in scenarios),
            violatedScenarios=sum(s["violations"] > 0 for s in scenarios),
        )
    warnings = ["限值来自本次任务；设备 ID 以本次算例为准。"]
    if analysis in ["dc_flow", "dc_opf"]:
        warnings.append(
            "DC 为线性近似，不提供交流电压或无功合格结论；电压字段为模型占位值。"
        )
    if analysis in ["dc_flow", "dc_opf"]:
        metrics.pop("minVoltagePu", None)
        metrics.pop("maxVoltagePu", None)
        metrics["lossMw"] = None
        for bus in buses:
            bus.pop("voltagePu", None)
    if scenarios:
        warnings.append(
            "逐场景使用 AC 潮流；孤岛和不收敛场景单独列出，未当作安全通过。主图为基态。"
        )
    if scenarios:
        solve()
    pp.to_json(network, str(contained_file(filename)))
    result = dict(
        solverStatus="optimal" if analysis in ["ac_opf", "dc_opf"] else "converged",
        criteriaStatus="violation"
        if violations
        or any(s["status"] != "converged" or s["violations"] for s in scenarios)
        else "pass",
        metrics=metrics,
        tables=dict(
            buses=buses, branches=branches, violations=violations, scenarios=scenarios
        ),
        series=[
            dict(
                label="节点相角" if analysis in ["dc_flow", "dc_opf"] else "节点电压",
                unit="degree" if analysis in ["dc_flow", "dc_opf"] else "p.u.",
                xUnit="bus",
                points=[
                    [
                        i,
                        b["angleDegree"]
                        if analysis in ["dc_flow", "dc_opf"]
                        else b["voltagePu"],
                    ]
                    for i, b in enumerate(buses)
                ],
            )
        ],
        warnings=warnings,
    )
    return result


def small_signal(system):
    import numpy as np

    if not system.EIG.run():
        return failure("diverged", "动态初始化或特征值分析失败，请检查模型完整性")
    eigen = system.EIG
    modes, factors = [], []
    names = list(system.dae.x_name)
    for i, value in enumerate(eigen.mu):
        re, im = float(value.real), float(value.imag)
        oscillatory = abs(im) > 1e-7
        modes.append(
            dict(
                mode=i + 1,
                real=re,
                imaginary=im,
                frequencyHz=abs(im) / (2 * math.pi),
                dampingPercent=-re / abs(value) * 100 if oscillatory else "",
                kind="oscillatory" if oscillatory else "non_oscillatory",
            )
        )
        column = np.asarray(eigen.pfactors)[:, i]
        for index in np.argsort(column)[-5:][::-1]:
            factors.append(
                dict(
                    mode=i + 1,
                    state=names[index] if index < len(names) else str(index),
                    factor=float(column[index]),
                )
            )
    unstable = sum(row["real"] > 1e-6 for row in modes)
    damping = [row["dampingPercent"] for row in modes if row["kind"] == "oscillatory"]
    return dict(
        solverStatus="completed",
        criteriaStatus="violation" if unstable else "pass",
        metrics=dict(
            modeCount=len(modes),
            unstableModes=unstable,
            minDampingPercent=min(damping) if damping else None,
        ),
        series=[],
        tables=dict(modes=modes, participation=factors),
        warnings=[
            "线性化工作点的小信号分析；非振荡模态不使用阻尼比评价。近零模态与参与因子需结合模型解释。",
            "参与因子使用 ANDES 的逐模态归一化输出，每个模态展示最大的五项。",
        ],
    )


def planning_network(spec, directory):
    import pandas as pd
    import pypsa

    if spec["modelId"] == "uploaded":
        dest = directory / "network.nc"
        dest.write_bytes((directory / "source.nc").read_bytes())
        return dest
    c = spec["parameters"]
    analysis = c.get("analysis", "storage_dispatch")
    step = c.get("stepMinutes", 60) / 60
    n = pypsa.Network()
    snapshots = pd.date_range(
        c["date"], periods=len(c["loadsKw"]), freq=pd.Timedelta(hours=step)
    )
    n.set_snapshots(snapshots)
    n.snapshot_weightings.loc[:, :] = step
    expansion = analysis == "capacity_expansion"
    if expansion:
        n.snapshot_weightings["objective"] = 8760 / len(snapshots)
    for carrier in ["AC", "grid", "solar", "wind", "gas", "battery"]:
        n.add("Carrier", carrier)
    n.add("Bus", "park", carrier="AC")
    n.add(
        "Generator",
        "grid",
        bus="park",
        carrier="grid",
        p_nom=c["gridLimitKw"] / 1000,
        marginal_cost=pd.Series([v * 1000 for v in c["prices"]], index=snapshots),
    )
    n.add(
        "Load",
        "demand",
        bus="park",
        p_set=pd.Series([v / 1000 for v in c["loadsKw"]], index=snapshots),
    )
    for kind in ["solar", "wind"]:
        cap = c.get(kind + "Kw", 0)
        maximum = c.get(kind + "MaxKw", 0)
        if cap or (expansion and maximum):
            profile = c.get(kind + "Profile")
            if profile is None or len(profile) != len(snapshots):
                raise ValueError("风光出力系数必须与时间序列对齐")
            n.add(
                "Generator",
                kind,
                bus="park",
                carrier=kind,
                p_nom=cap / 1000,
                p_nom_extendable=expansion,
                p_nom_min=cap / 1000,
                p_nom_max=(cap + maximum) / 1000,
                capital_cost=c.get(kind + "AnnualCost", 0) * 1000,
                p_max_pu=pd.Series(profile, index=snapshots),
                marginal_cost=0,
            )
    if c.get("generatorKw", 0) > 0:
        committed = analysis == "unit_commitment"
        n.add(
            "Generator",
            "thermal",
            bus="park",
            carrier="gas",
            p_nom=c["generatorKw"] / 1000,
            marginal_cost=c.get("generatorCost", 0.8) * 1000,
            committable=committed,
            p_min_pu=0.2 if committed else 0,
            start_up_cost=c.get("startupCost", 50) if committed else 0,
            min_up_time=c.get("minUpSteps", 2) if committed else 0,
            min_down_time=c.get("minDownSteps", 1) if committed else 0,
            up_time_before=0,
            down_time_before=c.get("minDownSteps", 1),
            ramp_limit_up=c.get("rampPerStep", 0.5),
            ramp_limit_down=c.get("rampPerStep", 0.5),
        )
    if analysis != "economic_dispatch" and analysis != "unit_commitment":
        capacity = c["capacityKwh"] / 1000
        usable = capacity * (c["socMax"] - c["socMin"])
        energy = pd.Series(float("nan"), index=snapshots)
        if not expansion:
            energy.iloc[-1] = capacity * (c["terminalSoc"] - c["socMin"])
        n.add(
            "StorageUnit",
            "battery",
            bus="park",
            carrier="battery",
            p_nom=c["powerKw"] / 1000,
            p_nom_extendable=expansion,
            p_nom_min=c["powerKw"] / 1000,
            p_nom_max=(c["powerKw"] + c.get("storageMaxKw", 0)) / 1000,
            capital_cost=c.get("storageAnnualCost", 0) * 1000,
            max_hours=usable / (c["powerKw"] / 1000),
            efficiency_store=c["efficiencyCharge"],
            efficiency_dispatch=c["efficiencyDischarge"],
            state_of_charge_initial=0
            if expansion
            else capacity * (c["initialSoc"] - c["socMin"]),
            state_of_charge_set=energy,
            cyclic_state_of_charge=False,
        )
    dest = directory / "network.nc"
    n.export_to_netcdf(dest)
    return dest


def planning_result(spec, raw):
    if raw.get("status") != "ok" or raw.get("termination_condition") != "optimal":
        return failure(
            "infeasible"
            if str(raw.get("termination_condition")) == "infeasible"
            else "timed_out"
            if str(raw.get("termination_condition")) == "time_limit"
            else "solver_error",
            "优化问题不可行，请检查供电能力和约束"
            if "infeasible" in str(raw.get("termination_condition"))
            else str(raw.get("termination_condition")),
        )
    c = spec["parameters"]
    step = c.get("stepMinutes", 60) / 60
    rows = raw["dispatch"]
    n = len(c["loadsKw"])
    if len(rows) != n:
        raise ValueError("调度结果时段不完整")
    for i, row in enumerate(rows):
        supply = sum(
            row.get(k, 0)
            for k in ["gridKw", "solarKw", "windKw", "thermalKw", "dischargeKw"]
        ) - row.get("chargeKw", 0)
        if abs(supply - c["loadsKw"][i]) > 1e-4:
            raise ValueError("调度功率平衡检查失败")
    expansion = c.get("analysis") == "capacity_expansion"
    metrics = dict(
        costCny=float(raw["objective"]),
        operatingCostCny=float(raw["operatingCost"]),
        investmentCostCny=float(raw["investmentCost"]),
        curtailedKwh=float(raw["curtailedKwh"]),
        unservedKwh=0,
    )
    metrics.update(raw["capacities"])
    if not expansion:
        baseline = sum(a * b * step for a, b in zip(c["loadsKw"], c["prices"]))
        metrics.update(
            baselineCny=baseline, savingCny=baseline - float(raw["objective"])
        )
    series = [
        dict(
            label="购电功率",
            unit="kW",
            xUnit="h",
            points=[[i * step, r["gridKw"]] for i, r in enumerate(rows)],
        )
    ]
    if "soc" in rows[0]:
        series.append(
            dict(
                label="储能 SOC",
                unit="%",
                xUnit="h",
                points=[[i * step, r["soc"] * 100] for i, r in enumerate(rows)],
            )
        )
        metrics["finalSoc"] = rows[-1]["soc"]
    return dict(
        solverStatus="optimal",
        criteriaStatus="pass",
        metrics=metrics,
        series=series,
        tables=dict(dispatch=rows, capacities=raw["capacityRows"]),
        warnings=[
            "单母线有功模型；不评估交流电压、无功、电池衰减或系统整体稳定。",
            "容量扩展以所给时段为等权代表时段，投资与运行成本统一为年化；新增储能采用固定功率/可用能量比例，初末 SOC 随优化容量约束。"
            if expansion
            else "成本按所给时段与步长累计；启动费用按事件计费。零/负电价或无损储能启用充放电互斥；未启用缺供松弛变量。",
        ],
    )


def create_optimization_model(network):
    """Allow a genuine zero-cost feasibility problem without inventing costs."""
    try:
        return network.optimize.create_model(include_objective_constant=True)
    except ValueError as error:
        # In the pinned PyPSA version this error is raised only after all
        # variables and constraints have been built, before setting an objective.
        if str(error) != (
            "Objective function could not be created. "
            "Please make sure the components have assigned costs."
        ):
            raise
        model = network.model
        zero = model.add_variables(lower=0, upper=0, name="zero_cost_objective")
        model.add_objective(zero)
        return model


def optimize_planning(filename, c):
    import pypsa

    n = pypsa.Network(contained_file(filename))
    expansion = c.get("analysis") == "capacity_expansion"
    mutually_exclusive = (
        any(p <= 0 for p in c["prices"])
        or c["efficiencyCharge"] * c["efficiencyDischarge"] >= 1 - 1e-12
    )
    model = create_optimization_model(n)
    if "battery" in n.storage_units.index and (expansion or mutually_exclusive):
        if expansion:
            import xarray as xr

            nominal = model.variables["StorageUnit-p_nom"].sel(name="battery")
            energy = model.variables["StorageUnit-state_of_charge"]
            initial_ratio = (c["initialSoc"] - c["socMin"]) / (
                c["socMax"] - c["socMin"]
            )
            terminal_ratio = (c["terminalSoc"] - c["socMin"]) / (
                c["socMax"] - c["socMin"]
            )
            hours = float(n.storage_units.at["battery", "max_hours"])
            first = xr.DataArray(
                [1] + [0] * (len(n.snapshots) - 1),
                dims=["snapshot"],
                coords={"snapshot": n.snapshots},
            )
            balance = model.constraints["StorageUnit-energy_balance"]
            lhs = balance.lhs + nominal * hours * initial_ratio * first
            rhs = balance.rhs
            model.remove_constraints("StorageUnit-energy_balance")
            model.add_constraints(lhs, "=", rhs, name="StorageUnit-energy_balance")
            model.add_constraints(
                energy.sel(snapshot=n.snapshots[-1], name="battery")
                == nominal * hours * terminal_ratio,
                name="StorageUnit-terminal-fraction",
            )
        if mutually_exclusive:
            mode = model.add_variables(
                binary=True, coords=[n.snapshots], name="StorageUnit-charge-mode"
            )
            maximum = (
                c["powerKw"] + (c.get("storageMaxKw", 0) if expansion else 0)
            ) / 1000
            model.add_constraints(
                model.variables["StorageUnit-p_store"].sel(name="battery")
                <= maximum * mode,
                name="StorageUnit-charge-exclusive",
            )
            model.add_constraints(
                model.variables["StorageUnit-p_dispatch"].sel(name="battery")
                <= maximum * (1 - mode),
                name="StorageUnit-discharge-exclusive",
            )
    status, termination = n.optimize.solve_model(
        solver_name="highs", solver_options={"threads": 1}, log_to_console=False
    )
    result = dict(status=str(status), termination_condition=str(termination))
    if status != "ok" or termination != "optimal":
        return result
    n.export_to_netcdf(filename)

    def values(frame, column):
        return frame[column].tolist() if column in frame else [0] * len(n.snapshots)

    flows = {
        kind: values(n.generators_t.p, kind)
        for kind in ["grid", "solar", "wind", "thermal"]
    }
    charge = values(n.storage_units_t.p_store, "battery")
    discharge = values(n.storage_units_t.p_dispatch, "battery")
    energy = values(n.storage_units_t.state_of_charge, "battery")
    rows = []
    capacity = c.get("capacityKwh", 0)
    step = c.get("stepMinutes", 60) / 60
    if "battery" in n.storage_units.index:
        capacity = (
            float(n.storage_units.at["battery", "p_nom_opt"])
            * 1000
            * float(n.storage_units.at["battery", "max_hours"])
            / (c["socMax"] - c["socMin"])
        )
    previous = capacity * c["initialSoc"]
    expansion = c.get("analysis") == "capacity_expansion"
    factor = 8760 / len(n.snapshots) if expansion else step
    operating = sum(
        sum(
            flows[k][i]
            * 1000
            * (
                c["prices"][i]
                if k == "grid"
                else c.get("generatorCost", 0.8)
                if k == "thermal"
                else 0
            )
            for k in flows
        )
        * factor
        for i in range(len(n.snapshots))
    )
    if "thermal" in n.generators.index and bool(
        n.generators.at["thermal", "committable"]
    ):
        operating += float(n.generators_t.start_up["thermal"].sum()) * c.get(
            "startupCost", 50
        )
    capacities = {}
    capacity_rows = []
    investment = 0
    for group in ["generators", "storage_units"]:
        for key, row in getattr(n, group).iterrows():
            if key == "grid":
                continue
            total = float(row.p_nom_opt) * 1000
            added = (
                max(0, total - float(row.p_nom) * 1000) if row.p_nom_extendable else 0
            )
            if expansion and row.p_nom_extendable:
                investment += added * float(row.capital_cost) / 1000
            capacities[key + "CapacityKw"] = total
            capacity_rows.append(dict(device=key, capacityKw=total, addedKw=added))
    curtailed = 0
    for i in range(len(n.snapshots)):
        row = dict(
            hour=i * step,
            **{k + "Kw": flows[k][i] * 1000 for k in flows},
            chargeKw=charge[i] * 1000,
            dischargeKw=discharge[i] * 1000,
        )
        if "battery" in n.storage_units.index:
            total_energy = energy[i] * 1000 + c["socMin"] * capacity
            row["soc"] = total_energy / capacity
            if not c["socMin"] - 1e-7 <= row["soc"] <= c["socMax"] + 1e-7:
                raise ValueError("SOC 超过约束范围")
            if (
                abs(
                    total_energy
                    - previous
                    - charge[i] * 1000 * c["efficiencyCharge"] * step
                    + discharge[i] * 1000 / c["efficiencyDischarge"] * step
                )
                > 1e-4
            ):
                raise ValueError("储能能量守恒失败")
            if min(charge[i], discharge[i]) > 1e-7:
                raise ValueError("不接受同时充放电的结果")
            previous = total_energy
        if "thermal" in n.generators_t.status:
            row["thermalStatus"] = float(n.generators_t.status["thermal"].iloc[i])
        for kind in ["solar", "wind"]:
            if kind in n.generators.index:
                curtailed += (
                    max(
                        0,
                        capacities[kind + "CapacityKw"] * c[kind + "Profile"][i]
                        - row[kind + "Kw"],
                    )
                    * step
                )
        rows.append(row)
    if (
        "battery" in n.storage_units.index
        and abs(previous - capacity * c["terminalSoc"]) > 1e-4
    ):
        raise ValueError("末时段电量约束未满足")
    if abs(float(n.objective) - investment - operating) > max(
        1e-3, abs(float(n.objective)) * 1e-7
    ):
        raise ValueError("总成本与投资、运行成本不一致")
    result.update(
        objective=float(n.objective),
        operatingCost=operating,
        investmentCost=investment,
        dispatch=rows,
        capacities=capacities,
        capacityRows=capacity_rows,
        curtailedKwh=curtailed,
    )
    return result
