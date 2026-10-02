from __future__ import annotations
from .base import OptimizationBackend, BackendCapabilities

class DryRunBackend(OptimizationBackend):
    name="reference_dry_run"
    capabilities=BackendCapabilities(single_period=True,time_series=True,active_power=True,reactive_power=True,hierarchical=True,multi_timescale=True,ac_validation=False)
    def run(self,spec,context):
        return {
            "status":"planned",
            "backend":{"name":self.name,"model_fidelity":"no_numerical_execution"},
            "solver":{"termination_condition":"not_run","solve_time_s":0.0},
            "objective":{},"metrics":{},"series":{},"boundary_ports":context.get("composite_manifest",{}).get("boundary_ports",[]),
            "validation":{"numeric_execution":False,"ac_powerflow_converged":None,"violations":[]},
            "warnings":["Dry-run only: no power-flow or optimization result was computed."]
        }
