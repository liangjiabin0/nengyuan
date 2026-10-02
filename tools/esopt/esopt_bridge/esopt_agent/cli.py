from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from . import service
from .expr import parse_linear


def _print(data: Any) -> None:
    json.dump(data, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="esopt",
        description="ESOPT / DCOPF CLI. Same functions are also exposed as an MCP server.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_help = sub.add_parser("help-topic", help="Read the agent modeling manual")
    p_help.add_argument("topic", nargs="?", default="overview")
    p_tpl = sub.add_parser("template", help="List or load a teaching template")
    p_tpl.add_argument("name", nargs="?")
    p_tpl.add_argument("--solve", action="store_true")
    sub.add_parser("validate", help="Validate the incremental model")
    sub.add_parser("capabilities", help="Show what this machine can run")
    sub.add_parser("cases", help="List bundled PGLib cases")

    p_inspect = sub.add_parser("inspect", help="Inspect a case without solving")
    p_inspect.add_argument("case")

    p_solve = sub.add_parser("solve", help="Solve DC optimal power flow")
    p_solve.add_argument("case")
    p_solve.add_argument("--pslp", action="store_true")
    p_solve.add_argument("--no-presolve", action="store_true")
    p_solve.add_argument("--no-generators", action="store_true")
    p_solve.add_argument("--timeout", type=int, default=600)

    p_cmp = sub.add_parser("compare", help="Compare an objective with bundled reference logs")
    p_cmp.add_argument("case")
    p_cmp.add_argument("--objective", type=float)

    p_model = sub.add_parser("model", help="Solve a generic linear model JSON, MPS or LP file")
    p_model.add_argument("file")
    p_model.add_argument("--timeout", type=int, default=3600, help="HiGHS time_limit seconds; MPS/LP default 1 hour")

    p_new = sub.add_parser("model-new", help="Start an empty incremental model")
    p_addv = sub.add_parser("add-var", help="Add a variable to the incremental model")
    p_addv.add_argument("name")
    p_addv.add_argument("--lb")
    p_addv.add_argument("--ub")
    p_addv.add_argument("--domain", default="continuous")
    p_addv.add_argument("--start", type=float)

    p_addc = sub.add_parser("add-con", help="Add a linear constraint: 5 x1 + 3 x2 <= 10")
    p_addc.add_argument("expr", help='Example: "5 x1 + 3 x2 <= 100"')
    p_addc.add_argument("--name", default="")

    p_obj = sub.add_parser("set-obj", help="Set linear objective: min 5 x1 + 3 x2")
    p_obj.add_argument("expr", help='Example: "min 5 x1 + 3 x2"')

    sub.add_parser("optimize", help="Solve the incremental model")
    sub.add_parser("show-model", help="Show the incremental model")

    sub.add_parser("mcp", help="Run MCP server on stdio for Cursor Agent")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.cmd == "mcp":
            from .mcp_server import run_mcp

            run_mcp()
            return 0
        if args.cmd == "help-topic":
            _print(service.modeling_help(args.topic))
        elif args.cmd == "template":
            if args.name:
                _print(service.load_template(args.name, solve=args.solve))
            else:
                _print(service.list_templates())
        elif args.cmd == "validate":
            _print(service.validate_model())
        elif args.cmd == "capabilities":
            _print(service.capabilities())
        elif args.cmd == "cases":
            _print(service.list_cases())
        elif args.cmd == "inspect":
            _print(service.inspect_case(args.case))
        elif args.cmd == "solve":
            _print(
                service.solve_dcopf(
                    args.case,
                    pslp=args.pslp,
                    highs_pre=not args.no_presolve,
                    with_generators=not args.no_generators,
                    timeout=args.timeout,
                )
            )
        elif args.cmd == "compare":
            _print(service.compare_reference(args.case, args.objective))
        elif args.cmd == "model":
            _print(service.solve_model(args.file, timeout=args.timeout))
        elif args.cmd == "model-new":
            _print(service.model_create())
        elif args.cmd == "add-var":
            def _bound(value: str | None):
                if value is None:
                    return None
                if value in {"inf", "+inf", "-inf"}:
                    return value
                return float(value)

            _print(
                service.model_add_variable(
                    args.name,
                    lb=_bound(args.lb),
                    ub=_bound(args.ub),
                    domain=args.domain,
                    start=args.start,
                )
            )
        elif args.cmd == "add-con":
            parsed = parse_linear(args.expr)
            if parsed["sense"] is None:
                raise SystemExit("constraint must contain <=, >= or ==")
            _print(service.model_add_constraint(expr=args.expr, name=args.name))
        elif args.cmd == "set-obj":
            _print(service.model_set_objective(expr=args.expr))
        elif args.cmd == "optimize":
            _print(service.model_optimize())
        elif args.cmd == "show-model":
            _print(service.model_get())
        return 0
    except Exception as exc:
        _print({"ok": False, "error": str(exc)})
        return 1
