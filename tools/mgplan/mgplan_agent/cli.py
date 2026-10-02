from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

CASE = "sSEP"
FORBIDDEN_OPTIONS = ("ThermalPlanning", "AmmoniaPlanning", "DCPlanning", "DataCenterPlanning")
REQUIRED_INPUTS = (
    f"oT_Data_Option_{CASE}.csv",
    f"oT_Data_Parameter_{CASE}.csv",
    f"oT_Data_Demand_{CASE}.csv",
    f"oT_Data_ElectricityPrice_{CASE}.csv",
    f"oT_Data_Generation_{CASE}.csv",
    f"oT_Data_VariableMaxGeneration_{CASE}.csv",
    f"oT_Data_NodeLocation_{CASE}.csv",
    f"oT_Data_Network_{CASE}.csv",
    f"oT_Dict_LoadLevel_{CASE}.csv",
)


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=_json_default) + "\n")
    sys.stdout.flush()


def _json_default(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _read_csv(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _num(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(str(value).replace(",", "").strip())
    except ValueError:
        return None


def _available_cases() -> list[str]:
    config = ROOT / "config"
    names = []
    for path in sorted(config.glob("oT_Data_Option_*.csv")):
        names.append(path.stem.replace("oT_Data_Option_", ""))
    return names or [CASE]


def _capabilities() -> dict[str, Any]:
    health = _health()
    return {
        "ok": True,
        "type": "result",
        "engine": "openTEPES",
        "case": CASE,
        "availableCases": _available_cases(),
        "solver": "gurobi",
        "gurobi": bool(health.get("gurobi")),
        "forbiddenOptions": list(FORBIDDEN_OPTIONS),
        "note": "v1 只开放 sSEP + Gurobi。热电/合成氨/直流/数据中心 Option 需要额外数据文件，本包未提供，不能改求解器冒充。",
    }


def _health() -> dict[str, Any]:
    info: dict[str, Any] = {
        "ok": True,
        "type": "result",
        "python": sys.version.split()[0],
        "engine": False,
        "gurobi": False,
        "gurobiFullLicense": False,
        "root": str(ROOT),
    }
    try:
        import openTEPES  # noqa: F401

        info["engine"] = True
    except Exception as exc:
        info["engineError"] = str(exc).split("license")[0].strip() or "openTEPES 不可导入"
    try:
        import gurobipy as gp

        env = gp.Env(empty=True)
        env.setParam("OutputFlag", 0)
        env.start()
        model = gp.Model(env=env)
        license_id = int(model.Params.LicenseID)
        explicit_isv = all(
            os.environ.get(name, "").strip()
            for name in ("MGPLAN_GUROBI_ISV_NAME", "MGPLAN_GUROBI_ISV_APP", "MGPLAN_GUROBI_ISV_KEY")
        )
        explicit_wls = bool(os.environ.get("WLSACCESSID") and os.environ.get("WLSSECRET"))
        explicit_file = bool(os.environ.get("GRB_LICENSE_FILE"))
        info["gurobi"] = True
        info["gurobiLicenseId"] = license_id
        info["gurobiLicense"] = "configured" if license_id > 0 or explicit_isv or explicit_wls or explicit_file else "restricted"
        info["gurobiFullLicense"] = info["gurobiLicense"] == "configured"
        model.dispose()
        env.dispose()
    except Exception as exc:
        info["gurobi"] = False
        info["gurobiError"] = str(exc)
    return info


def _validate(config_dir: Path) -> dict[str, Any]:
    missing = [name for name in REQUIRED_INPUTS if not (config_dir / name).is_file()]
    if missing:
        raise ValueError(f"缺少算例文件：{', '.join(missing)}")
    option_rows = _read_csv(config_dir / f"oT_Data_Option_{CASE}.csv")
    enabled: list[str] = []
    if option_rows:
        row = option_rows[0]
        for key in FORBIDDEN_OPTIONS:
            raw = str(row.get(key, "0") or "0").strip()
            if raw not in {"", "0", "0.0", "No", "NO", "no", "N", "n"}:
                enabled.append(key)
    if enabled:
        raise ValueError(f"v1 未开放扩展：{', '.join(enabled)}。请保持 sSEP 默认 Option。")
    return {
        "ok": True,
        "type": "result",
        "case": CASE,
        "configDir": str(config_dir),
        "files": REQUIRED_INPUTS,
    }


def _summarize(output_dir: Path) -> dict[str, Any]:
    cost = _read_csv(output_dir / f"oT_Result_CostSummary_{CASE}.csv")
    investment = _read_csv(output_dir / f"oT_Result_GenerationInvestment_{CASE}.csv")
    evaluations = _read_csv(output_dir / f"oT_Result_Evaluations_{CASE}.csv")
    eco = _read_csv(output_dir / f"oT_Result_EvaluationsEco_{CASE}.csv")
    if not cost and not investment and not evaluations and not eco:
        raise ValueError(f"输出目录没有可汇总的结果：{output_dir}")

    objective = 0.0
    for row in cost:
        value = _num(row.get("CNY") or row.get("value"))
        if value is not None:
            objective += value

    files = sorted(path.name for path in output_dir.iterdir() if path.is_file()) if output_dir.is_dir() else []
    return {
        "ok": True,
        "type": "result",
        "engine": "openTEPES",
        "case": CASE,
        "status": "optimal",
        "objective": round(objective, 4),
        "costSummary": cost,
        "investment": investment,
        "evaluations": evaluations,
        "evaluationsEco": eco,
        "outputFiles": files,
        "outputDir": str(output_dir),
    }


def _run(config_dir: Path, output_dir: Path) -> dict[str, Any]:
    _validate(config_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    os.environ["MGPLAN_CONFIG_DIR"] = str(config_dir)
    os.environ["MGPLAN_OUTPUT_DIR"] = str(output_dir)
    os.environ["MPLBACKEND"] = "Agg"
    os.chdir(str(SCRIPTS))
    started = time.time()
    from openTEPES import openTEPES_run

    openTEPES_run(str(SCRIPTS), CASE, "gurobi", "No")
    elapsed = round(time.time() - started, 2)
    summary = _summarize(output_dir)
    summary["elapsedSeconds"] = elapsed
    summary["fixture"] = False
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mgplan-agent")
    parser.add_argument("command", choices=["health", "validate", "run", "summarize", "capabilities"])
    parser.add_argument("--config-dir", type=Path)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "health":
            emit(_health())
            return 0
        if args.command == "capabilities":
            emit(_capabilities())
            return 0
        if args.command == "validate":
            if not args.config_dir:
                raise ValueError("validate 需要 --config-dir")
            emit(_validate(args.config_dir))
            return 0
        if args.command == "summarize":
            if not args.output_dir:
                raise ValueError("summarize 需要 --output-dir")
            emit(_summarize(args.output_dir))
            return 0
        if args.command == "run":
            if not args.config_dir or not args.output_dir:
                raise ValueError("run 需要 --config-dir --output-dir")
            emit(_run(args.config_dir, args.output_dir))
            return 0
        raise ValueError(f"未知命令：{args.command}")
    except Exception as exc:
        message = str(exc)
        for token in ("license", "LICENSE", "WLSACCESSID", "WLSSECRET", "GRB_LICENSE"):
            if token.lower() in message.lower() and token in ("WLSACCESSID", "WLSSECRET", "GRB_LICENSE"):
                message = "求解环境未就绪。"
                break
        emit(
            {
                "ok": False,
                "type": "error",
                "error": message,
                "trace": traceback.format_exc(limit=4),
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
