from __future__ import annotations

from typing import Any

TOPICS = [
    "overview",
    "workflow",
    "dcopf",
    "generic_lp",
    "mip",
    "expressions",
    "status",
    "parameters",
    "limits",
    "recipes",
    "templates",
]


GUIDE: dict[str, Any] = {
    "overview": {
        "what_this_is": (
            "ESOPT is a modeling layer. HiGHS is the solver currently wired on this machine. "
            "The agent should translate a real decision problem into variables, linear constraints, "
            "and an objective, then call tools. Do not invent solver output."
        ),
        "two_paths": {
            "dcopf": "Use when the user already has a PGLib/DCOPF JSON case, or asks for 直流最优潮流 / 机组出力 / 电网调度.",
            "mps_file": "Use when the user uploads a .mps or .lp file. Call esopt_model_solve_file. Do not rewrite the file into JSON variables.",
            "generic_lp": "Use when the user describes any other allocation, blending, scheduling, knapsack, diet, transport, or production problem.",
        },
        "first_call": "Always start a new task with esopt_help(topic='workflow') if unsure, then esopt_capabilities.",
        "golden_rule": "If it is not linear or mixed-integer linear, say so. Do not pretend sin/cos/x^2 can be solved here until Ipopt/Knitro are loaded.",
    },
    "workflow": {
        "dcopf_steps": [
            "esopt_list_cases or esopt_inspect_case",
            "esopt_solve_dcopf(case=...)",
            "If the user wants a check: esopt_compare_reference(case=..., objective=...)",
            "Explain objective, whether generation==load, and which expensive units were used if generator_outputs exist",
        ],
        "generic_steps": [
            "Rewrite the user's request as: decisions / limits / goal",
            "esopt_model_create",
            "Add one variable per decision (name, lb, ub, domain)",
            "Add constraints with expr strings like '3*x + 2*y <= 10'",
            "Set objective with 'min 5*x + 3*y' or 'max 4*x'",
            "esopt_model_validate, then esopt_model_optimize",
            "Interpret values and objective in the user's units",
        ],
        "one_shot": "If the whole model is already clear, build a JSON and call esopt_model_solve_json.",
        "never": [
            "Never skip validate on a model you just invented",
            "Never report a non-7 termination as optimal",
            "Never use DCOPF tools for a non-grid story problem",
        ],
    },
    "dcopf": {
        "meaning": "Decide generator MW (in p.u.) to meet load at minimum linear cost, subject to DC flow and line limits.",
        "aliases": ["24", "case24", "500", "case500", "1354", "10000", "30000"],
        "outputs": {
            "objective": "Total generation cost",
            "total_generation / total_load": "Must nearly match; otherwise the model or case is wrong",
            "termination_status": "7 = optimal",
            "generator_outputs": "Each unit's pg, pmin, pmax, cost2",
        },
        "reference": {
            "case24": {"objective": 58448.6, "load": 28.5},
            "case500": {"objective": 387271, "load": 177.7292},
        },
    },
    "generic_lp": {
        "variable": "A decision the solver may choose. Name it in English letters: x, milk, gen1.",
        "domain": {
            "continuous": "Default. Any real number in [lb, ub].",
            "integer": "Whole numbers. Use for counts of machines, trucks, batches.",
            "binary": "0 or 1. Use for yes/no, on/off, choose/not choose.",
        },
        "constraint": "A linear law. Only +, - and a single <= >= ==. No *, /, sin, x*y.",
        "objective": "One linear goal. min or max. Constants are allowed but do not change the argmin.",
        "bounds_vs_constraints": "Capacity of one variable -> lb/ub. Relation among several variables -> constraint.",
    },
    "mip": {
        "when": "Use integer/binary when fractional answers are meaningless (3.2 trucks, 0.4 factories).",
        "cost": "MIP is harder than LP. Keep binaries few. Test a tiny instance first.",
        "example": "Knapsack: binary x_i, sum value*x maximized, sum weight*x <= capacity.",
    },
    "expressions": {
        "allowed": ["3*x + 2*y <= 10", "x - 0.5*y >= 1", "min 4*x + y", "max x"],
        "forbidden": ["x*y", "x^2", "sin(x)", "x/y", "if x>0"],
        "terms_form": [{"var": "x", "coef": 3}, {"var": "y", "coef": 2}],
        "tip": "Prefer the expr string. The tools accept either expr or terms.",
    },
    "status": {
        "7": "Optimal. Trust the values.",
        "not_7": "Not proven optimal. Say so. Check bounds, missing constraints, or contradictory limits.",
        "infeasible_hints": [
            "lb > ub on a variable",
            "two constraints that cannot hold together",
            "demand larger than all capacities",
        ],
    },
    "parameters": {
        "presolve": "on/off. Keep on unless debugging a tiny model.",
        "output_flag": "Usually false; the CLI/MCP already returns JSON.",
            "time_limit": "MPS/LP HiGHS time cap. Default 3600 seconds (1 hour). 0 means no solver time cap.",
        "pslp": "Optional Linux ESOPT SDK supports PSLP. Check esopt_capabilities first; large native models require a full ESOPT license.",
    },
    "limits": {
        "runnable_now": ["DCOPF via HiGHS", "linear LP", "linear MIP (integer/binary)"],
        "api_exists_but_no_runtime": ["Ipopt nonlinear", "Knitro", "Gurobi", "quadratic constraints"],
        "optional_native": "Linux ESOPT SDK provides LP/MIP/DCOPF and PSLP; without a full license, at most 300 variables and 300 constraints. Larger auto-mode models use clearly labelled HiGHS. Explicit PSLP cannot fall back.",
        "how_to_talk_about_it": (
            "If the user needs AC-OPF, sin/cos, or x^2, explain that ESOPT can model it in C++ "
            "but this agent interface cannot solve it until those solver DLLs are installed."
        ),
    },
    "recipes": {
        "diet": "Food amounts >=0; nutrient constraints >= requirements; min cost.",
        "blend": "Ingredient fractions sum to 1; quality weighted averages; min cost.",
        "transport": "Ship[i,j] >=0; row supply, column demand; min distance*flow.",
        "production": "Make[t]>=0; inventory balance; capacity; min cost or max profit.",
        "assignment": "Binary x[i,j]; each i assigned once; min cost.",
        "dcopf": "Do not rebuild by hand. Call esopt_solve_dcopf on a PGLib case.",
    },
}


TEMPLATES: dict[str, dict[str, Any]] = {
    "diet": {
        "title": "最低成本配餐",
        "story": "买面包和牛奶，蛋白质至少 20，预算最多 12，费用最低。",
        "model": {
            "variables": [
                {"name": "bread", "lb": 0, "ub": 10, "domain": "continuous"},
                {"name": "milk", "lb": 0, "ub": 10, "domain": "continuous"},
            ],
            "constraints": [
                {"name": "protein", "expr": "4*bread + 8*milk >= 20"},
                {"name": "budget", "expr": "2*bread + 3*milk <= 12"},
            ],
            "objective": {"expr": "min 2*bread + 3*milk"},
        },
        "expected": {"optimal": True, "objective": 7.5, "values": {"bread": 0.0, "milk": 2.5}},
    },
    "knapsack": {
        "title": "0-1 背包",
        "story": "三件物品，价值和重量已知，容量 5，选或不选。",
        "model": {
            "variables": [
                {"name": "a", "domain": "binary"},
                {"name": "b", "domain": "binary"},
                {"name": "c", "domain": "binary"},
            ],
            "constraints": [{"name": "weight", "expr": "2*a + 3*b + 4*c <= 5"}],
            "objective": {"expr": "max 3*a + 4*b + 5*c"},
        },
    },
    "transport": {
        "title": "两厂两仓运输",
        "story": "工厂供应 20/10，仓库需求 15/15，最小化运费。",
        "model": {
            "variables": [
                {"name": "x11", "lb": 0, "domain": "continuous"},
                {"name": "x12", "lb": 0, "domain": "continuous"},
                {"name": "x21", "lb": 0, "domain": "continuous"},
                {"name": "x22", "lb": 0, "domain": "continuous"},
            ],
            "constraints": [
                {"expr": "x11 + x12 <= 20", "name": "supply1"},
                {"expr": "x21 + x22 <= 10", "name": "supply2"},
                {"expr": "x11 + x21 == 15", "name": "demand1"},
                {"expr": "x12 + x22 == 15", "name": "demand2"},
            ],
            "objective": {"expr": "min 2*x11 + 3*x12 + 4*x21 + x22"},
        },
    },
}


def help_payload(topic: str = "overview") -> dict[str, Any]:
    key = (topic or "overview").strip().lower()
    if key in {"list", "topics", "index"}:
        return {"ok": True, "topics": TOPICS, "templates": list(TEMPLATES)}
    if key == "templates":
        return {
            "ok": True,
            "templates": {name: {"title": spec["title"], "story": spec["story"]} for name, spec in TEMPLATES.items()},
        }
    if key not in GUIDE:
        return {
            "ok": False,
            "error": f"unknown topic '{topic}'",
            "topics": TOPICS,
        }
    return {"ok": True, "topic": key, "content": GUIDE[key], "topics": TOPICS}


def template_payload(name: str | None = None) -> dict[str, Any]:
    if not name:
        return {
            "ok": True,
            "templates": {key: {"title": val["title"], "story": val["story"]} for key, val in TEMPLATES.items()},
        }
    key = name.strip().lower()
    if key not in TEMPLATES:
        return {"ok": False, "error": f"unknown template '{name}'", "templates": list(TEMPLATES)}
    return {"ok": True, "name": key, **TEMPLATES[key]}
