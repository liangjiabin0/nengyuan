"""Use an uploaded PyPSA network without silently changing its model or time weights."""

import math
from pathlib import Path
from result_tables import export_table

from analysis import contained_file, create_optimization_model, failure


def check_container(filename):
    """Bound HDF5 expansion and reject external/virtual datasets before loading."""
    with open(filename, "rb") as stream:
        magic = stream.read(8)
    if not magic.startswith(b"\x89HDF"):
        if not magic.startswith(b"CDF"):
            raise ValueError("文件不是 NetCDF 数据")
        return
    import h5py

    budget = 0
    visited = set()
    with h5py.File(filename, "r") as file:

        def visit(group):
            nonlocal budget
            address = h5py.h5o.get_info(group.id).addr
            if address in visited:
                return
            visited.add(address)
            if len(visited) > 10000:
                raise ValueError("NetCDF 对象数量超过限制")
            for name in group:
                link = group.get(name, getlink=True)
                if isinstance(link, (h5py.ExternalLink, h5py.SoftLink)):
                    raise ValueError("NetCDF 不允许外部或符号链接")
                item = group[name]
                if isinstance(item, h5py.Group):
                    visit(item)
                else:
                    if item.is_virtual:
                        raise ValueError("不允许引用其他文件的虚拟数据集")
                    budget += item.size * max(item.dtype.itemsize, 8)
                    if budget > 128 * 1024 * 1024:
                        raise ValueError("NetCDF 展开数据超过 128 MB")

        visit(file)


def inspect_network(filename):
    import pypsa
    import pandas as pd

    check_container(filename)
    network = pypsa.Network(filename)
    if isinstance(network.snapshots, pd.MultiIndex):
        raise ValueError("当前入口支持单规划期；多投资期模型需要独立验收")
    if not 2 <= len(network.snapshots) <= 8760 or len(network.buses) > 500:
        raise ValueError("模型须包含 2—8760 个时段且不超过 500 条母线")
    if not network.snapshots.is_unique or not network.snapshots.is_monotonic_increasing:
        raise ValueError("时序必须严格递增且不能重复")
    for group in ["generators", "loads", "storage_units", "stores", "links"]:
        table = getattr(network, group)
        if len(table) > 2000:
            raise ValueError("设备数量超过当前验收范围")
        for column in ["bus", "bus0", "bus1"]:
            if column in table and not table[column].isin(network.buses.index).all():
                raise ValueError("设备引用未知母线")
    if network.loads.empty or network.generators.empty:
        raise ValueError("模型必须包含负荷与电源")
    extendable = any(
        bool(table[field].any())
        for group, field in [
            ("generators", "p_nom_extendable"),
            ("storage_units", "p_nom_extendable"),
            ("stores", "e_nom_extendable"),
            ("lines", "s_nom_extendable"),
            ("links", "p_nom_extendable"),
        ]
        if (table := getattr(network, group)) is not None and field in table
    )
    committed = bool(network.generators.committable.any()) or bool(
        network.links.committable.any()
    )
    allowed = []
    if extendable:
        allowed.append("capacity_expansion")
    elif committed:
        allowed.append("unit_commitment")
    else:
        allowed.append("economic_dispatch")
        if not network.storage_units.empty or not network.stores.empty:
            allowed.append("storage_dispatch")
    return network, allowed


def optimize_native(filename, parameters):
    network, allowed = inspect_network(contained_file(filename))
    if parameters["analysis"] not in allowed:
        raise ValueError("算例已有的启停或扩建决策与实验类型不符，请按导入诊断选择任务")
    create_optimization_model(network)
    status, termination = network.optimize.solve_model(
        solver_name="highs",
        solver_options={"threads": 1},
        log_to_console=False,
    )
    if status != "ok" or termination != "optimal":
        return failure(
            "infeasible"
            if str(termination) == "infeasible"
            else "timed_out"
            if str(termination) == "time_limit"
            else "solver_error",
            "优化未获得可行最优解：" + str(termination),
        )
    network.export_to_netcdf(filename)
    investment = 0
    capacities = []
    for group, nominal in [
        ("generators", "p_nom"),
        ("storage_units", "p_nom"),
        ("stores", "e_nom"),
        ("lines", "s_nom"),
        ("links", "p_nom"),
    ]:
        for name, row in getattr(network, group).iterrows():
            optimized = float(row[nominal + "_opt"])
            added = (
                max(0, optimized - float(row[nominal]))
                if row[nominal + "_extendable"]
                else 0
            )
            if row[nominal + "_extendable"]:
                investment += (optimized - float(row[nominal])) * float(
                    row.capital_cost
                )
            capacities.append(
                dict(
                    device=str(name),
                    component=group,
                    nominal=optimized,
                    added=added,
                    unit="MWh"
                    if nominal == "e_nom"
                    else "MVA"
                    if nominal == "s_nom"
                    else "MW",
                )
            )
    series = []
    dispatch_frames = []
    start = network.snapshots[0]
    hours = [
        (t - start).total_seconds() / 3600
        if hasattr(t - start, "total_seconds")
        else float(i)
        for i, t in enumerate(network.snapshots)
    ]
    for group, label in [
        ("generators", "发电"),
        ("loads", "负荷"),
        ("storage_units", "储能净出力"),
        ("stores", "能量存储净出力"),
    ]:
        frame = getattr(network, group + "_t").p
        if frame.empty:
            continue
        totals = frame.sum(axis=1).tolist()
        if len(totals) != len(hours) or not all(math.isfinite(v) for v in totals):
            raise ValueError("原生网络结果不完整或包含非有限值")
        series.append(
            dict(
                label=label,
                unit="MW",
                xUnit="h",
                points=list(map(list, zip(hours, totals))),
            )
        )
        dispatch_frames.append((group, frame))

    def dispatch_rows():
        for group, frame in dispatch_frames:
            for column in frame:
                for i, value in enumerate(frame[column]):
                    yield dict(
                        hour=hours[i],
                        component=group,
                        device=str(column),
                        powerMw=float(value),
                    )

    def storage_rows():
        for name in network.storage_units_t.state_of_charge:
            for t, value in zip(hours, network.storage_units_t.state_of_charge[name]):
                yield dict(hour=t, device=str(name), energyMwh=float(value))

    def link_rows():
        for port, frame in network.links_t.items():
            if not port.startswith("p") or not port[1:].isdigit():
                continue
            for name in frame:
                for i, value in enumerate(frame[name]):
                    yield dict(
                        hour=hours[i], device=str(name), port=port, powerMw=float(value)
                    )

    for name in network.storage_units_t.state_of_charge:
        capacity = float(network.storage_units.at[name, "p_nom_opt"]) * float(
            network.storage_units.at[name, "max_hours"]
        )
        if capacity > 0:
            values = network.storage_units_t.state_of_charge[name].tolist()
            series.append(
                dict(
                    label=str(name) + " SOC",
                    unit="%",
                    xUnit="h",
                    points=[[t, v / capacity * 100] for t, v in zip(hours, values)],
                )
            )
    tables = {}
    counts = {}
    directory = Path(filename).parent
    for name, rows in [
        ("capacities", iter(capacities)),
        ("dispatch", dispatch_rows()),
        ("storage", storage_rows()),
        ("links", link_rows()),
    ]:
        tables[name], counts[name] = export_table(directory, name, rows)
    return dict(
        solverStatus="optimal",
        criteriaStatus="not_evaluated",
        metrics=dict(
            objective=float(network.objective),
            investmentCost=investment,
            operatingCost=float(network.objective) - investment,
            snapshotCount=len(hours),
        ),
        series=series,
        tables=tables,
        tableCounts=counts,
        warnings=[
            "保留导入模型的设备、成本、时序、权重与约束；页面示例参数不覆盖原生模型。",
            "金额单位与年化口径沿用原模型；未自行假定人民币或全年成本。最优解不代表已通过交流安全校核。",
        ],
    )
