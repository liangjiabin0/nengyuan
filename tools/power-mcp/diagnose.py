"""Import only known data formats; preserve originals and conversion diagnostics."""

import argparse
import contextlib
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys


def diagnose(directory, engine):
    manifest = json.loads((directory / "sources.json").read_text())
    files = [directory / name for name in manifest]
    if any(f.resolve().parent != directory.resolve() for f in files):
        raise ValueError("算例路径无效")
    source = files[0]
    if source.suffix.lower() == ".xlsx":
        from import_limits import check_workbook

        check_workbook(source)
    ext = source.suffix.lower()
    notes = []
    originals = [
        dict(name=manifest[f.name], sha256=hashlib.sha256(f.read_bytes()).hexdigest())
        for f in files
    ]
    counts = {}
    base = None
    unit = "MW / Mvar / kV / p.u."
    allowed = None
    if engine == "pandapower" and ext in [".csv", ".xlsx"]:
        from tabular import read_template

        network = read_template(source)
        normalized = directory / "normalized.json"
        normalized.write_text(json.dumps(network, allow_nan=False))
        counts = dict(
            buses=len(network["buses"]),
            lines=len(network["lines"]),
            transformers=0,
            generators=1,
            loads=len(network["loads"]),
            dynamicModels=0,
        )
        base = network["baseMva"]
        via = "table-template"
        allowed = ["ac_flow", "dc_flow", "n_minus_1", "n_minus_2"]
        notes.append(
            dict(
                severity="info",
                message="使用明确字段的网络模板；仅包含线路、负荷与平衡电源，不自动补造成本、变压器或动态模型。",
            )
        )
    elif engine == "pypsa":
        if ext != ".nc":
            raise ValueError(
                "规划模型上传支持 PyPSA NetCDF；时序与资源也可直接在页面配置"
            )
        from native_planning import inspect_network

        network, allowed = inspect_network(source)
        counts = dict(
            buses=len(network.buses),
            lines=len(network.lines),
            transformers=len(network.transformers),
            generators=len(network.generators),
            loads=len(network.loads),
            storage=len(network.storage_units) + len(network.stores),
            dynamicModels=0,
            snapshots=len(network.snapshots),
        )
        base = None
        unit = "MW / MWh；货币及时间权重沿用原模型"
        normalized = directory / "normalized.nc"
        network.export_to_netcdf(normalized)
        via = "pypsa-native"
        notes.append(
            dict(
                severity="info",
                message="保留导入网络的设备、时间序列、成本与约束。页面示例参数不覆盖本模型。",
            )
        )
    elif engine == "andes":
        import andes
        import andes.io.xlsx

        kwargs = dict(
            setup=True,
            no_output=True,
            pycode_path=str(
                Path(__file__).resolve().parents[2] / "storage/power-cache/andes-pycode"
            ),
        )
        if ext == ".raw":
            dyr = next((f for f in files if f.suffix.lower() == ".dyr"), None)
            if dyr is None:
                raise ValueError("RAW 仅包含静态网络；动态分析必须同时提供匹配的 DYR")
            kwargs["addfile"] = str(dyr)
        elif ext != ".xlsx":
            raise ValueError("动态分析支持 ANDES XLSX 或已验证的 RAW+DYR 配对")
        system = andes.load(str(source), **kwargs)
        if system is None or not system.is_setup:
            raise ValueError("动态模型无法完成结构检查，请核对未支持的设备或模型参数")
        dynamic = sum(m.n for m in system.SynGen.models.values())
        if not dynamic:
            raise ValueError("缺少有效的同步机动态模型，不能启动动态分析")
        counts = dict(
            buses=system.Bus.n,
            lines=system.Line.n,
            generators=system.PV.n + system.Slack.n,
            loads=system.PQ.n,
            dynamicModels=dynamic,
        )
        base = float(system.config.mva)
        andes.io.xlsx.write(system, str(directory / "normalized.xlsx"), overwrite=True)
        notes.append(
            dict(
                severity="info",
                code="dynamic_scope",
                message="已检查模型结构；提交时仍须通过潮流与动态初始化，未支持的模型不能自动补造。",
            )
        )
        normalized = directory / "normalized.xlsx"
        via = "andes-native"
    else:
        import powerio
        import pandapower as pp

        if ext not in [".m", ".raw", ".json"]:
            raise ValueError(
                "当前静态导入已验证 MATPOWER .m、RAW 及 PowerIO IR JSON；Excel/CSV 请使用明确字段模板"
            )
        if ext == ".json":
            data = json.loads(source.read_text())
            if data.get("schema") != "pio-ir":
                raise ValueError("该 JSON 不是已验证的 PowerIO IR 格式")
            module = powerio.deserialize(source)
        else:
            module = powerio.parse(source, format="matpower" if ext == ".m" else "psse")
        notes += powerio.diagnostic_records(module.diagnostics)
        ir = powerio.serialize(module)
        (directory / "model.pio.json").write_bytes(ir.artifacts[0].data)
        converted = powerio.emit(module, "pandapower")
        notes += powerio.diagnostic_records(converted.diagnostics)
        if any(str(n.get("severity", "")).lower() in ["error", "fatal"] for n in notes):
            raise ValueError(
                "算例转换含阻断错误："
                + "；".join(str(n.get("message", n.get("code"))) for n in notes)
            )
        normalized = directory / "normalized.json"
        normalized.write_bytes(converted.artifacts[0].data)
        net = pp.from_json(str(normalized), convert=False)
        aliases = [
            old
            for old, new in [
                ("const_i_percent", "const_i_p_percent"),
                ("const_z_percent", "const_z_p_percent"),
            ]
            if old in net.load and new in net.load
        ]
        if aliases:
            for old in aliases:
                stem = "const_i" if old.startswith("const_i") else "const_z"
                if (
                    not (
                        (net.load[old] - net.load[stem + "_p_percent"]).abs() < 1e-9
                    ).all()
                    or not (
                        (net.load[old] - net.load[stem + "_q_percent"]).abs() < 1e-9
                    ).all()
                ):
                    raise ValueError("新旧负荷阻抗参数冲突，不能无损转换")
            net.load.drop(columns=aliases, inplace=True)
            notes.append(
                dict(
                    severity="info",
                    code="pp35_alias",
                    message="已去除数值一致的旧版负荷字段别名，保留有功/无功字段并执行 pandapower 格式升级。",
                )
            )
        pp.convert_format(net)
        pp.to_json(net, str(normalized))
        counts = {
            label: len(net[name])
            for label, name in [
                ("buses", "bus"),
                ("lines", "line"),
                ("transformers", "trafo"),
                ("generators", "gen"),
                ("loads", "load"),
            ]
        }
        counts["generators"] += len(net.ext_grid)
        counts["dynamicModels"] = 0
        base = float(net.sn_mva)
        via = "powerio"
        if counts["buses"] > 500 or counts["lines"] + counts["transformers"] > 2000:
            raise ValueError("算例超过当前已验收的规模范围")
        if not len(net.ext_grid) and not ("slack" in net.gen and net.gen.slack.any()):
            raise ValueError("缺少平衡电源，不能启动潮流")
        allowed = ["ac_flow", "dc_flow", "n_minus_1", "n_minus_2"]
        if not net.poly_cost.empty or not net.pwl_cost.empty:
            allowed += ["ac_opf", "dc_opf"]
        else:
            notes.append(
                dict(
                    severity="info",
                    code="missing_cost",
                    message="未包含发电成本，暂不能用于最优潮流；可运行潮流与安全校核。",
                )
            )
        notes.append(
            dict(
                severity="info",
                code="no_dynamics",
                message="静态模型不包含动态设备参数，不能直接用于动态稳定分析。",
            )
        )
    return dict(
        format=ext[1:],
        loader=via,
        loaderVersion="1.0"
        if via == "table-template"
        else importlib.metadata.version(
            "powerio"
            if via == "powerio"
            else "pypsa"
            if via == "pypsa-native"
            else "andes"
        ),
        counts=counts,
        baseMva=base,
        units=unit,
        source="user",
        originals=originals,
        diagnostics=notes,
        normalizedHash=hashlib.sha256(normalized.read_bytes()).hexdigest(),
        allowedAnalyses=allowed
        or (
            ["time_domain", "small_signal"]
            if engine == "andes"
            else ["ac_flow", "dc_flow", "ac_opf", "dc_opf", "n_minus_1", "n_minus_2"]
        ),
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("directory")
    p.add_argument("engine")
    a = p.parse_args()
    directory = Path(a.directory).resolve()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = diagnose(directory, a.engine)
        (directory / "diagnosis.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)
        )
        print(json.dumps({"ok": True}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)
