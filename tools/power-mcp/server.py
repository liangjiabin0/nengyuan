"""PowerMCP adapters: preserve upstream tools and return complete solver data.

PyPSA upstream discards the optimized Network without exporting storage SOC.
ANDES upstream returns only a TDS summary. The two narrow overrides below
retain the same MCP tool names while returning the actual numerical arrays.
"""

import argparse
import contextlib
import importlib.util
import sys
from pathlib import Path


def load_server(engine):
    from powermcp.registry import get_tool

    entry = get_tool(engine).resolve_entry_script()
    sys.path.insert(0, str(entry.parent))
    spec = importlib.util.spec_from_file_location("power_upstream_" + engine, entry)
    module = importlib.util.module_from_spec(spec)
    with contextlib.redirect_stdout(sys.stderr):
        spec.loader.exec_module(module)
    return module


def extend_pypsa(module):
    module.mcp.remove_tool("optimize_network")

    @module.mcp.tool()
    def optimize_network(network_name: str, solver_name: str = "highs") -> dict:
        """Optimize a contained PyPSA model and export its complete solution."""
        if solver_name != "highs":
            return {
                "status": "error",
                "message": "Only the validated HiGHS solver is enabled.",
            }
        source = module._checked_network_source(network_name, purpose="network_name")
        with contextlib.redirect_stdout(sys.stderr):
            network = module.Network(source)
            status, termination = module._optimize(
                network, solver_name="highs", solver_options={"threads": 1}
            )
            result = {
                "status": str(status),
                "termination_condition": str(termination),
                "solver": "highs",
            }
            if status != "ok" or termination != "optimal":
                return result
            network.export_to_netcdf(source)
            result.update(
                {
                    "objective": float(network.objective),
                    "snapshots": [str(t) for t in network.snapshots],
                    "grid_mw": network.generators_t.p["grid"].tolist(),
                    "storage_dispatch_mw": network.storage_units_t.p_dispatch[
                        "battery"
                    ].tolist(),
                    "storage_charge_mw": network.storage_units_t.p_store[
                        "battery"
                    ].tolist(),
                    "storage_energy_mwh": network.storage_units_t.state_of_charge[
                        "battery"
                    ].tolist(),
                }
            )
            return result


def extend_andes(module):
    import os

    original_run = module.andes.run

    def isolated_run(*args, **kwargs):
        from analysis import contained_file

        if args:
            contained_file(args[0])
        kwargs["pycode_path"] = os.environ["ANDES_PYCODE_PATH"]
        return original_run(*args, **kwargs)

    module.andes.run = isolated_run
    original = module.run_time_domain_simulation
    module.mcp.remove_tool("run_time_domain_simulation")

    @module.mcp.tool()
    def run_time_domain_simulation(
        step_size: float = 0.01, t_end: float = 10.0
    ) -> dict:
        """Run upstream ANDES TDS and return its full voltage/speed time series."""
        import numpy as np

        result = original(step_size=step_size, t_end=t_end)
        if result.get("status") != "success" or not result.get("simulation", {}).get(
            "success"
        ):
            return result
        system = module.system_state["current_system"]
        system.dae.ts.unpack()
        ts = system.dae.ts
        times = np.asarray(ts.t).reshape(-1)
        voltages = np.asarray(ts.y)[:, system.Bus.v.a]
        speeds = {}
        angles = {}
        for name, model in system.SynGen.models.items():
            if model.n and hasattr(model, "omega"):
                values = np.asarray(ts.x)[:, model.omega.a]
                for index, idx in enumerate(model.idx.v):
                    speeds[name + ":" + str(idx)] = values[:, index].tolist()
                if hasattr(model, "delta"):
                    vals = np.asarray(ts.x)[:, model.delta.a]
                    for index, idx in enumerate(model.idx.v):
                        angles[name + ":" + str(idx)] = vals[:, index].tolist()
        frequencies = {}
        if hasattr(system, "BusFreq") and system.BusFreq.n:
            values = np.asarray(ts.y)[:, system.BusFreq.f.a]
            frequencies = {
                str(idx): values[:, i].tolist()
                for i, idx in enumerate(system.BusFreq.idx.v)
            }
        result["series"] = {
            "timeS": times.tolist(),
            "busVoltagePu": {
                str(idx): voltages[:, i].tolist()
                for i, idx in enumerate(system.Bus.idx.v)
            },
            "generatorSpeedPu": speeds,
            "generatorAngleRad": angles,
            "busFrequencyPu": frequencies,
            "baseFrequencyHz": float(system.config.freq),
        }
        return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("engine", choices=["pandapower", "pypsa", "andes"])
    engine = parser.parse_args().engine
    module = load_server(engine)
    if engine == "pypsa":
        extend_pypsa(module)
    if engine == "andes":
        extend_andes(module)
    from analysis import (
        static_analysis,
        small_signal,
        optimize_planning,
        contained_file,
        failure,
    )

    if engine == "pandapower":

        @module.mcp.tool()
        def run_static_analysis(file_path: str, parameters: dict) -> dict:
            """Execute a confirmed static analysis on a task-contained model."""
            with contextlib.redirect_stdout(sys.stderr):
                try:
                    return static_analysis(file_path, parameters)
                except ValueError as e:
                    return failure("solver_error", str(e))

    if engine == "pypsa":

        @module.mcp.tool()
        def run_planning_analysis(
            file_path: str, parameters: dict, native_model: bool = False
        ) -> dict:
            """Optimize the confirmed planning model and retain native results."""
            with contextlib.redirect_stdout(sys.stderr):
                try:
                    if native_model:
                        from native_planning import optimize_native

                        return optimize_native(file_path, parameters)
                    return optimize_planning(str(contained_file(file_path)), parameters)
                except ValueError as e:
                    return {
                        "status": "error",
                        "termination_condition": "input_error",
                        "message": str(e),
                    }

    if engine == "andes":

        @module.mcp.tool()
        def run_small_signal_analysis() -> dict:
            """Run ANDES EIG on the current initialized dynamic model."""
            with contextlib.redirect_stdout(sys.stderr):
                return small_signal(module.system_state["current_system"])

    # Expose only the per-engine allowlist, including upstream helper tools.
    import json

    allowed = set(
        json.loads((Path(__file__).parent / "servers.json").read_text())["servers"][
            engine
        ]["allowedTools"]
    )
    import asyncio

    for tool in asyncio.run(module.mcp.list_tools()):
        if tool.name not in allowed:
            module.mcp.remove_tool(tool.name)
    module.mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
