from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def _health() -> dict[str, Any]:
    info: dict[str, Any] = {
        "ok": True,
        "type": "result",
        "engine": "power-dispatch",
        "python": sys.version.split()[0],
        "root": str(ROOT),
        "pandapower": False,
        "pyomo": False,
        "highs": False,
    }
    try:
        import pandapower  # noqa: F401

        info["pandapower"] = True
    except Exception as exc:
        info["pandapowerError"] = str(exc)
    try:
        import pyomo.environ  # noqa: F401

        info["pyomo"] = True
    except Exception as exc:
        info["pyomoError"] = str(exc)
    try:
        import highspy  # noqa: F401

        info["highs"] = True
    except Exception:
        info["highs"] = False
    info["ok"] = bool(info["pandapower"])
    return info


def _validate(spec_path: Path) -> dict[str, Any]:
    from power_dispatch_skill.io import load_spec
    from power_dispatch_skill.validation import validate_run_spec

    spec = load_spec(str(spec_path))
    result = validate_run_spec(spec)
    return {"ok": bool(result.get("valid")), "type": "result", "engine": "power-dispatch", **result}


def _run(spec_path: Path, output_dir: Path, dry_run: bool) -> dict[str, Any]:
    from power_dispatch_skill.io import dump_json, load_spec
    from power_dispatch_skill.orchestrator import DispatchOrchestrator

    spec = load_spec(str(spec_path))
    output_dir.mkdir(parents=True, exist_ok=True)
    bundle = DispatchOrchestrator().run(spec, force_dry_run=dry_run)
    dump_json(output_dir / "run_spec.json", spec)
    dump_json(output_dir / "result_bundle.json", bundle)
    status = str(bundle.get("status") or "failed")
    objective = bundle.get("objective") or {}
    total = objective.get("total") if isinstance(objective, dict) else objective
    return {
        "ok": status in {"success", "planned"},
        "type": "result",
        "engine": "power-dispatch",
        "status": status,
        "success": status == "success",
        "fixture": status == "planned" or dry_run,
        "objective": total,
        "bundle": bundle,
        "outputDir": str(output_dir),
        "outputFiles": ["run_spec.json", "result_bundle.json"],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dispatch-agent")
    parser.add_argument("command", choices=["health", "validate", "run", "cases", "backends", "serve"])
    parser.add_argument("--spec", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args(argv)
    try:
        if args.command == "health":
            emit(_health())
            return 0
        if args.command == "validate":
            if not args.spec:
                raise ValueError("validate 需要 --spec")
            emit(_validate(args.spec))
            return 0
        if args.command == "cases":
            from power_dispatch_skill.cases import list_cases

            emit({"ok": True, "type": "result", "engine": "power-dispatch", "items": list_cases()})
            return 0
        if args.command == "backends":
            from power_dispatch_skill.orchestrator import DispatchOrchestrator

            emit({"ok": True, "type": "result", "engine": "power-dispatch", "items": DispatchOrchestrator().registry.list()})
            return 0
        if args.command == "serve":
            if str(ROOT) not in sys.path:
                sys.path.insert(0, str(ROOT))
            import uvicorn
            from web.fastapi_app import app

            uvicorn.run(app, host=args.host, port=args.port)
            return 0
        if args.command == "run":
            if not args.spec or not args.output_dir:
                raise ValueError("run 需要 --spec --output-dir")
            emit(_run(args.spec, args.output_dir, args.dry_run))
            return 0
        raise ValueError(f"未知命令：{args.command}")
    except Exception as exc:
        emit({"ok": False, "type": "error", "engine": "power-dispatch", "error": str(exc), "trace": traceback.format_exc(limit=6)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
