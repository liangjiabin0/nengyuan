from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def _health() -> dict[str, Any]:
    info: dict[str, Any] = {
        "ok": True,
        "type": "result",
        "engine": "nwxs-loss",
        "python": sys.version.split()[0],
        "root": str(ROOT),
        "powerGridModel": False,
    }
    try:
        import power_grid_model  # noqa: F401

        info["powerGridModel"] = True
    except Exception as exc:
        info["ok"] = False
        info["error"] = str(exc)
    return info


def _summarize(output_dir: Path) -> dict[str, Any]:
    day = output_dir / "json_results" / "DistributionLine_Day.json"
    stats: dict[str, Any] = {}
    if day.is_file():
        rows = json.loads(day.read_text(encoding="utf-8"))
        if isinstance(rows, list) and rows:
            row = rows[0] if isinstance(rows[0], dict) else {}
        elif isinstance(rows, dict):
            row = rows
        else:
            row = {}
        stats = {
            "acti_power": row.get("acti_power"),
            "feeder_acti_loss": row.get("feeder_acti_loss"),
            "feeder_lossrate": row.get("feeder_lossrate") or row.get("loss_rate"),
            "lnseg_loss": row.get("lnseg_loss"),
            "tran_copp_loss": row.get("tran_copp_loss"),
            "tran_iron_loss": row.get("tran_iron_loss"),
        }
    files = sorted(str(path.relative_to(output_dir)).replace("\\", "/") for path in output_dir.rglob("*") if path.is_file())
    return {"statistics": stats, "outputFiles": files}


def _run(input_path: Path, output_dir: Path, method: str, fmt: str, workers: int | None) -> dict[str, Any]:
    from scripts.main_calculation import calculate_one_day, load_json_data, validate_input_data

    data = load_json_data(str(input_path))
    validate_input_data(data)
    output_dir.mkdir(parents=True, exist_ok=True)
    results = calculate_one_day(
        json_data=data,
        output_dir=str(output_dir),
        calc_method=method,
        output_format=fmt,
        max_workers=workers,
    )
    summary = _summarize(output_dir)
    stats = {**(results.get("statistics") or {}), **(summary.get("statistics") or {})}
    return {
        "ok": True,
        "success": True,
        "type": "result",
        "engine": "nwxs-loss",
        "status": "success",
        "message": results.get("message", "计算完成"),
        "results": results.get("results", {}),
        "statistics": stats,
        "lossRate": stats.get("feeder_lossrate"),
        "outputDir": str(output_dir),
        "outputFiles": summary.get("outputFiles") or [],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="loss-agent")
    parser.add_argument("command", choices=["health", "run", "summarize"])
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--method", default="04")
    parser.add_argument("--format", default="full", choices=["full", "json_only", "summary"])
    parser.add_argument("--workers", type=int)
    args = parser.parse_args(argv)
    try:
        if args.command == "health":
            emit(_health())
            return 0
        if args.command == "summarize":
            if not args.output_dir:
                raise ValueError("summarize 需要 --output-dir")
            emit({"ok": True, "type": "result", "engine": "nwxs-loss", **_summarize(args.output_dir)})
            return 0
        if args.command == "run":
            if not args.input or not args.output_dir:
                raise ValueError("run 需要 --input --output-dir")
            emit(_run(args.input, args.output_dir, args.method, args.format, args.workers))
            return 0
        raise ValueError(f"未知命令：{args.command}")
    except Exception as exc:
        emit({"ok": False, "type": "error", "engine": "nwxs-loss", "error": str(exc), "trace": traceback.format_exc(limit=6)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
