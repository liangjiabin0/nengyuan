from __future__ import annotations

import json
import sys
from typing import Any

from . import service


def _ok(data: Any) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False, indent=2)}]}


def _err(message: str) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": json.dumps({"ok": False, "error": message}, ensure_ascii=False)}],
        "isError": True,
    }


TOOLS: dict[str, dict[str, Any]] = {
    "esopt_help": {
        "description": (
            "Read the agent modeling manual. Call this BEFORE building a new model. "
            "Topics: overview, workflow, dcopf, generic_lp, mip, expressions, status, "
            "parameters, limits, recipes, templates, list."
        ),
        "handler": lambda arguments: service.modeling_help(arguments.get("topic", "overview")),
        "schema": {
            "type": "object",
            "properties": {
                "topic": {
                    "type": "string",
                    "description": "overview|workflow|dcopf|generic_lp|mip|expressions|status|parameters|limits|recipes|templates|list",
                }
            },
        },
    },
    "esopt_templates": {
        "description": "List or load a ready-made teaching model (diet, knapsack, transport). Set solve=true to run it.",
        "handler": lambda arguments: (
            service.load_template(arguments["name"], solve=bool(arguments.get("solve", False)))
            if arguments.get("name")
            else service.list_templates()
        ),
        "schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "diet|knapsack|transport"},
                "solve": {"type": "boolean", "default": False},
            },
        },
    },
    "esopt_model_validate": {
        "description": "Check the current incremental model for missing objective, unknown variables, or lb>ub before solving.",
        "handler": lambda arguments: service.validate_model(),
        "schema": {"type": "object", "properties": {}},
    },
    "esopt_capabilities": {
        "description": "Show ESOPT/DCOPF capabilities on this machine: solvers, cases, API surface, what is actually runnable.",
        "handler": lambda arguments: service.capabilities(),
        "schema": {"type": "object", "properties": {}},
    },
    "esopt_list_cases": {
        "description": "List bundled PGLib DC-OPF cases with bus/branch/generator counts and total load.",
        "handler": lambda arguments: service.list_cases(),
        "schema": {"type": "object", "properties": {}},
    },
    "esopt_inspect_case": {
        "description": "Inspect a PGLib case without solving. Accepts aliases like case24, 24, or a full JSON path.",
        "handler": lambda arguments: service.inspect_case(arguments["case"]),
        "schema": {
            "type": "object",
            "properties": {"case": {"type": "string", "description": "Case name or path, e.g. case24"}},
            "required": ["case"],
        },
    },
    "esopt_solve_dcopf": {
        "description": (
            "Solve DC optimal power flow with ESOPT+HiGHS. Returns objective, status, "
            "generation/load balance, and per-generator outputs. Use case aliases: case24, case500, case1354."
        ),
        "handler": lambda arguments: service.solve_dcopf(
            arguments["case"],
            pslp=bool(arguments.get("pslp", False)),
            highs_pre=bool(arguments.get("highs_pre", True)),
            with_generators=bool(arguments.get("with_generators", True)),
            timeout=int(arguments.get("timeout", 600)),
        ),
        "schema": {
            "type": "object",
            "properties": {
                "case": {"type": "string", "description": "Case alias or JSON path"},
                "pslp": {"type": "boolean", "default": False, "description": "Use PSLP presolve (needs patched HiGHS)"},
                "highs_pre": {"type": "boolean", "default": True, "description": "Use HiGHS presolve"},
                "with_generators": {"type": "boolean", "default": True},
                "timeout": {"type": "integer", "default": 600},
            },
            "required": ["case"],
        },
    },
    "esopt_compare_reference": {
        "description": "Compare a computed objective with the bundled reference logs for that case.",
        "handler": lambda arguments: service.compare_reference(arguments["case"], arguments.get("objective")),
        "schema": {
            "type": "object",
            "properties": {
                "case": {"type": "string"},
                "objective": {"type": "number", "description": "Objective from a previous solve"},
            },
            "required": ["case"],
        },
    },
    "esopt_model_create": {
        "description": "Start a new incremental ESOPT linear model session. Clears previous variables/constraints.",
        "handler": lambda arguments: service.model_create(),
        "schema": {"type": "object", "properties": {}},
    },
    "esopt_model_add_variable": {
        "description": "Add a decision variable to the current model session.",
        "handler": lambda arguments: service.model_add_variable(
            arguments["name"],
            lb=arguments.get("lb"),
            ub=arguments.get("ub"),
            domain=arguments.get("domain", "continuous"),
            start=arguments.get("start"),
        ),
        "schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "lb": {"description": "Lower bound. Use null or -inf for unbounded."},
                "ub": {"description": "Upper bound. Use null or inf for unbounded."},
                "domain": {"type": "string", "enum": ["continuous", "integer", "binary"], "default": "continuous"},
                "start": {"type": "number"},
            },
            "required": ["name"],
        },
    },
    "esopt_model_add_constraint": {
        "description": "Add a linear constraint. Prefer expr like '3*x + 2*y <= 10'.",
        "handler": lambda arguments: service.model_add_constraint(
            arguments.get("terms"),
            sense=arguments.get("sense", "<="),
            rhs=float(arguments.get("rhs", 0.0)),
            name=arguments.get("name", ""),
            constant=float(arguments.get("constant", 0.0)),
            lb=arguments.get("lb"),
            ub=arguments.get("ub"),
            expr=arguments.get("expr"),
        ),
        "schema": {
            "type": "object",
            "properties": {
                "expr": {"type": "string", "description": "Preferred. Example: 3*x + 2*y <= 10"},
                "terms": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"var": {"type": "string"}, "coef": {"type": "number"}},
                        "required": ["var"],
                    },
                },
                "sense": {"type": "string", "enum": ["<=", ">=", "=="], "default": "<="},
                "rhs": {"type": "number", "default": 0},
                "name": {"type": "string"},
                "constant": {"type": "number", "default": 0},
                "lb": {},
                "ub": {},
            },
        },
    },
    "esopt_model_set_objective": {
        "description": "Set the linear objective. Prefer expr like 'min 5*x + 3*y' or 'max x'.",
        "handler": lambda arguments: service.model_set_objective(
            arguments.get("terms"),
            sense=arguments.get("sense", "minimize"),
            constant=float(arguments.get("constant", 0.0)),
            expr=arguments.get("expr"),
        ),
        "schema": {
            "type": "object",
            "properties": {
                "expr": {"type": "string", "description": "Preferred. Example: min 5*x + 3*y"},
                "terms": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"var": {"type": "string"}, "coef": {"type": "number"}},
                        "required": ["var"],
                    },
                },
                "sense": {"type": "string", "enum": ["minimize", "maximize"], "default": "minimize"},
                "constant": {"type": "number", "default": 0},
            },
        },
    },
    "esopt_model_set_parameter": {
        "description": "Set a HiGHS/ESOPT solver parameter on the current model, e.g. presolve=on.",
        "handler": lambda arguments: service.model_set_parameter(arguments["name"], arguments["value"]),
        "schema": {
            "type": "object",
            "properties": {"name": {"type": "string"}, "value": {}},
            "required": ["name", "value"],
        },
    },
    "esopt_model_get": {
        "description": "Show the current incremental model and last solve result.",
        "handler": lambda arguments: service.model_get(),
        "schema": {"type": "object", "properties": {}},
    },
    "esopt_model_optimize": {
        "description": "Solve the current incremental ESOPT linear model with HiGHS and return variable values.",
        "handler": lambda arguments: service.model_optimize(),
        "schema": {"type": "object", "properties": {}},
    },
    "esopt_model_solve_file": {
        "description": "Solve a .mps or .lp file with HiGHS. Use this instead of rewriting a large MPS into JSON variables.",
        "handler": lambda arguments: service.solve_mps(
            arguments["file"],
            timeout=int(arguments.get("timeout", 3600)),
        ),
        "schema": {
            "type": "object",
            "properties": {
                "file": {"type": "string", "description": "Absolute or workspace-relative .mps/.lp path"},
                "timeout": {"type": "integer", "default": 3600},
            },
            "required": ["file"],
        },
    },
    "esopt_model_solve_json": {
        "description": "One-shot solve of a complete linear model JSON (variables, constraints, objective, parameters), or an .mps/.lp path.",
        "handler": lambda arguments: service.solve_model(arguments["model"]),
        "schema": {
            "type": "object",
            "properties": {
                "model": {
                    "description": "Model object or JSON string. Same schema as esoptc model --file.",
                }
            },
            "required": ["model"],
        },
    },
}


def _tool_list() -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "description": spec["description"],
            "inputSchema": spec["schema"],
        }
        for name, spec in TOOLS.items()
    ]


def _dispatch(name: str, arguments: dict[str, Any] | None) -> dict[str, Any]:
    if name not in TOOLS:
        return _err(f"Unknown tool: {name}")
    try:
        result = TOOLS[name]["handler"](arguments or {})
        return _ok(result)
    except Exception as exc:
        return _err(str(exc))


def _read_message() -> dict[str, Any] | None:
    # Cursor / MCP stdio is newline-delimited JSON-RPC.
    # Also accept LSP-style Content-Length frames.
    first = sys.stdin.buffer.readline()
    if not first:
        return None
    if first.lower().startswith(b"content-length:"):
        headers = {"content-length": first.split(b":", 1)[1].strip()}
        while True:
            line = sys.stdin.buffer.readline()
            if not line or line in (b"\r\n", b"\n"):
                break
            if b":" in line:
                key, value = line.decode("utf-8").split(":", 1)
                headers[key.strip().lower()] = value.strip()
        raw = sys.stdin.buffer.read(int(headers["content-length"]))
        return json.loads(raw.decode("utf-8"))
    text = first.decode("utf-8").strip()
    if not text:
        return _read_message()
    return json.loads(text)


def _write_message(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def run_mcp() -> None:
    while True:
        message = _read_message()
        if message is None:
            return
        method = message.get("method")
        msg_id = message.get("id")
        if method == "initialize":
            _write_message(
                {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": {"name": "esopt", "version": "1.0.0"},
                        "instructions": (
                            "You can model and solve optimization problems with these tools. "
                            "First call esopt_help(topic='workflow'). "
                            "Grid DC-OPF / PGLib cases: inspect then esopt_solve_dcopf. "
                            "Any other decision problem: create a linear or MIP model "
                            "(variables, linear constraints, min/max linear objective), "
                            "validate, then optimize. "
                            "Prefer expr strings like '3*x + 2*y <= 10' and 'min 5*x'. "
                            "termination_status 7 means optimal. "
                            "Quadratic, sin/cos, and commercial solvers are not runnable on this machine."
                        ),
                    },
                }
            )
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            _write_message({"jsonrpc": "2.0", "id": msg_id, "result": {"tools": _tool_list()}})
        elif method == "resources/list":
            _write_message({"jsonrpc": "2.0", "id": msg_id, "result": {"resources": []}})
        elif method == "prompts/list":
            _write_message({"jsonrpc": "2.0", "id": msg_id, "result": {"prompts": []}})
        elif method == "tools/call":
            params = message.get("params") or {}
            result = _dispatch(params.get("name", ""), params.get("arguments") or {})
            _write_message({"jsonrpc": "2.0", "id": msg_id, "result": result})
        elif method == "ping":
            _write_message({"jsonrpc": "2.0", "id": msg_id, "result": {}})
        elif method in {"shutdown", "exit"}:
            if msg_id is not None:
                _write_message({"jsonrpc": "2.0", "id": msg_id, "result": {}})
            return
        elif msg_id is not None:
            _write_message(
                {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {"code": -32601, "message": f"Method not found: {method}"},
                }
            )
