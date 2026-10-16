"""Real MCP protocol and solver regression matrix. Only writes sandbox test artifacts."""

import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
assert str(ROOT) == "/data/temp/ai4es", "Sandbox only"
BASE = ROOT / "storage/power-validation" / str(uuid.uuid4())
BASE.mkdir(parents=True)
cases = json.loads(Path("/data/temp/control/requirements-scenarios.json").read_text())
checks = []
python = ROOT / "tools/power-mcp-venv/bin/python"


def check(name, fn):
    selected = os.environ.get("POWER_SCENARIO_FILTER", "")
    if selected and not any(term in name for term in selected.split(",")):
        return
    started = time.time()
    try:
        detail = fn()
        checks.append(
            dict(
                name=name,
                passed=True,
                seconds=round(time.time() - started, 2),
                detail=detail,
            )
        )
    except Exception as e:
        checks.append(
            dict(
                name=name,
                passed=False,
                seconds=round(time.time() - started, 2),
                detail=str(e),
            )
        )
    print(json.dumps(checks[-1], ensure_ascii=False), flush=True)
    Path("/data/temp/logs/power-requirements-scenarios.json").write_text(
        json.dumps(checks, ensure_ascii=False, indent=2)
    )


def execute(spec, label):
    directory = BASE / label
    directory.mkdir()
    (directory / "input.json").write_text(json.dumps(spec))
    env = {
        **os.environ,
        "PYTHONUTF8": "1",
        "MPLCONFIGDIR": str(directory / "matplotlib"),
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "ANDES_PYCODE_PATH": str(ROOT / "storage/power-cache/andes-pycode"),
        "POWERIO_MCP_ALLOWED_ROOTS": str(directory),
        "XDG_CACHE_HOME": str(directory / "cache"),
    }
    with (directory / "test.log").open("w") as log:
        p = subprocess.run(
            [
                str(python),
                str(ROOT / "tools/power-mcp/execute.py"),
                str(directory / "input.json"),
                str(directory),
            ],
            cwd=directory,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            timeout=300,
        )
    if p.returncode:
        raise AssertionError((directory / "test.log").read_text()[-2200:])
    result = json.loads((directory / "engine-result.json").read_text())
    assert result["runId"] == spec["runId"] and result["inputHash"] == spec["inputHash"]
    for key in [
        "source",
        "engine",
        "version",
        "solver",
        "fidelity",
        "modelHash",
        "execution",
    ]:
        assert result.get(key), key
    assert result["execution"]["durationMs"] > 0
    return result, directory


def successful(spec, index):
    result, directory = execute(spec, str(index) + "-" + spec["parameters"]["analysis"])
    assert result["solverStatus"] in ["converged", "optimal", "completed"], result
    task = spec["parameters"]["analysis"]
    if task.startswith("n_minus_"):
        assert result["metrics"]["scenarioCount"] > 0
        assert len(result["tables"]["scenarios"]) == result["metrics"]["scenarioCount"]
    if task == "small_signal":
        assert result["metrics"]["modeCount"] > 0 and result["tables"]["participation"]
        assert all(0 <= r["factor"] <= 1 for r in result["tables"]["participation"])
    if spec["engine"] == "pypsa":
        m = result["metrics"]
        assert abs(m["costCny"] - m["operatingCostCny"] - m["investmentCostCny"]) < 1e-3
    if task == "ac_flow":
        import pandapower as pp

        net = pp.from_json(str(directory / "network.json"))
        pp.runpp(net, tolerance_mva=1e-8)
        actual = [r["voltagePu"] for r in result["tables"]["buses"]]
        assert max(abs(a - b) for a, b in zip(actual, net.res_bus.vm_pu)) < 1e-7
    return dict(solver=result["solverStatus"], metrics=result["metrics"])


for i, spec in enumerate(cases):
    check(
        spec["parameters"]["analysis"] + " " + str(i),
        lambda s=spec, i=i: successful(s, i),
    )


def changed(engine, updates):
    s = copy.deepcopy(next(s for s in cases if s["engine"] == engine))
    s.pop("runSpec", None)
    s["parameters"].update(updates)
    s["runId"] = str(uuid.uuid4())
    s["inputHash"] = hashlib.sha256(json.dumps(s["parameters"]).encode()).hexdigest()
    return s


def infeasible():
    result, _ = execute(changed("pypsa", dict(gridLimitKw=1, powerKw=1)), "infeasible")
    assert (
        result["solverStatus"] == "infeasible"
        and result["series"] == []
        and result["criteriaStatus"] == "not_evaluated"
    )


check("infeasible has no fabricated curves", infeasible)


def diverged():
    result, _ = execute(
        changed("pandapower", dict(maxIterations=1, loadFactor=3)), "diverged"
    )
    assert result["solverStatus"] == "diverged" and result["series"] == []


check("nonconvergence is explicit", diverged)


def flat_price():
    result, _ = execute(changed("pypsa", dict(prices=[0.5] * 24)), "flat-price")
    assert result["solverStatus"] == "optimal" and result["metrics"]["savingCny"] < 1e-4


check("flat price cannot invent savings", flat_price)


def workspace_escape():
    sys.path.insert(0, str(ROOT / "tools/power-mcp"))
    from analysis import contained_file

    os.environ["POWERIO_MCP_ALLOWED_ROOTS"] = str(BASE)
    try:
        contained_file("/etc/passwd")
    except ValueError:
        return
    raise AssertionError("outside workspace accepted")


check("MCP rejects outside workspace", workspace_escape)


def convert():
    directory = BASE / "powerio"
    directory.mkdir()
    text = """function mpc = case2
mpc.version = '2';
mpc.baseMVA = 100;
mpc.bus = [1 3 0 0 0 0 1 1 0 110 1 1.1 .9;2 1 10 2 0 0 1 1 0 110 1 1.1 .9;];
mpc.gen = [1 10 2 100 -100 1 100 1 100 0;];
mpc.branch = [1 2 .01 .04 0 100 100 100 0 0 1 -360 360;];
mpc.gencost = [2 0 0 2 20 0;];
"""
    (directory / "source-0.m").write_text(text)
    (directory / "sources.json").write_text(json.dumps({"source-0.m": "case2.m"}))
    p = subprocess.run(
        [
            str(python),
            str(ROOT / "tools/power-mcp/diagnose.py"),
            str(directory),
            "pandapower",
        ],
        capture_output=True,
        text=True,
    )
    assert p.returncode == 0, p.stdout + p.stderr[-1000:]
    diag = json.loads((directory / "diagnosis.json").read_text())
    assert diag["counts"]["buses"] == 2 and diag["loader"] == "powerio"
    assert diag["originals"][0]["sha256"] == hashlib.sha256(text.encode()).hexdigest()
    return diag["counts"]


check("PowerIO real MATPOWER import and source hash", convert)


def extreme(label, engine, updates, expected="optimal"):
    result, directory = execute(changed(engine, updates), "extreme-" + label)
    assert result["solverStatus"] == expected, result
    assert set(result["versions"]) <= {"powermcp", "mcp", engine, "highspy"}
    assert (
        hashlib.sha256(
            (
                directory
                / (
                    "model-input.nc"
                    if engine == "pypsa"
                    else "model-input.json"
                    if engine == "pandapower"
                    else "model-input.xlsx"
                )
            ).read_bytes()
        ).hexdigest()
        == result["modelHash"]
    )
    if expected in ["infeasible", "diverged", "solver_error"]:
        assert not result["series"] and result["criteriaStatus"] == "not_evaluated"
    if engine == "pypsa" and expected == "optimal":
        m = result["metrics"]
        assert abs(m["costCny"] - m["investmentCostCny"] - m["operatingCostCny"]) < 1e-3
    return result["metrics"]


def explicit_mcp():
    spec = changed("pandapower", {})
    spec["transport"] = "mcp"
    result, directory = execute(spec, "explicit-pandapower-mcp")
    assert (
        result["solverStatus"] == "converged"
        and result["transport"] == "mcp"
        and (directory / "mcp.json").exists()
    )
    return result["metrics"]


check("extreme real pandapower MCP alternative", explicit_mcp)
check(
    "extreme zero tariff",
    lambda: extreme("zero-tariff", "pypsa", dict(prices=[0] * 24)),
)
check(
    "extreme negative tariff physical dispatch",
    lambda: extreme("negative-tariff", "pypsa", dict(prices=[-0.1] * 24)),
)
check(
    "extreme lossless battery",
    lambda: extreme(
        "lossless-battery", "pypsa", dict(efficiencyCharge=1, efficiencyDischarge=1)
    ),
)
check(
    "extreme zero load", lambda: extreme("zero-load", "pypsa", dict(loadsKw=[0] * 24))
)
check(
    "extreme SOC at lower bound",
    lambda: extreme("soc-bound", "pypsa", dict(initialSoc=0.1, terminalSoc=0.1)),
)
check(
    "extreme storage capacity extension",
    lambda: extreme(
        "storage-extension",
        "pypsa",
        dict(
            analysis="capacity_expansion",
            solarProfile=[
                0,
                0,
                0,
                0,
                0,
                0,
                0.1,
                0.2,
                0.4,
                0.6,
                0.8,
                0.9,
                1,
                0.9,
                0.8,
                0.6,
                0.4,
                0.2,
                0.1,
                0,
                0,
                0,
                0,
                0,
            ],
            solarMaxKw=1000,
            solarAnnualCost=350,
            storageMaxKw=500,
            storageAnnualCost=5,
        ),
    ),
)
check(
    "extreme unaffordable capacity extension",
    lambda: extreme(
        "no-expansion",
        "pypsa",
        dict(
            analysis="capacity_expansion",
            solarProfile=[0.5] * 24,
            solarMaxKw=1000,
            solarAnnualCost=1e6,
            storageMaxKw=0,
        ),
    ),
)
check(
    "extreme half-hour commitment costs",
    lambda: extreme(
        "commitment-halfhour",
        "pypsa",
        dict(
            analysis="unit_commitment",
            generatorKw=400,
            generatorCost=0.6,
            stepMinutes=30,
        ),
    ),
)
check(
    "extreme inadequate committed capacity",
    lambda: extreme(
        "insufficient-commitment",
        "pypsa",
        dict(analysis="unit_commitment", generatorKw=1, gridLimitKw=1),
        "infeasible",
    ),
)
check(
    "extreme wind and thermal dispatch",
    lambda: extreme(
        "wind-dispatch",
        "pypsa",
        dict(
            analysis="economic_dispatch",
            windKw=200,
            windProfile=[0.5] * 24,
            generatorKw=400,
            generatorCost=0.6,
        ),
    ),
)
check(
    "extreme explicit N-1 subset",
    lambda: extreme(
        "n1-subset",
        "pandapower",
        dict(analysis="n_minus_1", contingencyElements=["line:0"]),
        "converged",
    ),
)
check(
    "extreme explicit N-2 subset",
    lambda: extreme(
        "n2-subset",
        "pandapower",
        dict(analysis="n_minus_2", contingencyElements=["line:0", "line:1"]),
        "converged",
    ),
)
check(
    "extreme missing contingency device",
    lambda: extreme(
        "missing-device",
        "pandapower",
        dict(analysis="n_minus_1", contingencyElements=["line:999999"]),
        "solver_error",
    ),
)
check(
    "extreme insufficient N-2 device set",
    lambda: extreme(
        "short-n2",
        "pandapower",
        dict(analysis="n_minus_2", contingencyElements=["line:0"]),
        "solver_error",
    ),
)
check(
    "extreme long dynamic dense output",
    lambda: extreme(
        "dense-dynamic", "andes", dict(endAtS=30, stepS=0.005), "completed"
    ),
)
check(
    "extreme extended sixty-second dynamic",
    lambda: extreme(
        "extended-dynamic", "andes", dict(endAtS=60, stepS=0.01), "completed"
    ),
)
print(
    json.dumps(
        dict(
            passed=sum(c["passed"] for c in checks),
            failed=sum(not c["passed"] for c in checks),
            directory=str(BASE),
        )
    ),
    flush=True,
)
sys.exit(1 if any(not c["passed"] for c in checks) else 0)
