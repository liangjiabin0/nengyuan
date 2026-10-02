from __future__ import annotations
import time
from .base import OptimizationBackend, BackendCapabilities
from ..cases import load_pandapower_case

class PandapowerACOPFBackend(OptimizationBackend):
    name="pandapower_acopf"
    capabilities=BackendCapabilities(single_period=True,active_power=True,reactive_power=True,ac_validation=True)
    def run(self,spec,context):
        try:
            import pandapower as pp
        except ImportError as e:
            raise RuntimeError("pandapower is required for pandapower_acopf") from e
        case_id=spec["case"]["case_id"]
        net=load_pandapower_case(case_id)
        t0=time.perf_counter()
        # Baseline AC PF
        pp.runpp(net, calculate_voltage_angles=True, init="auto")
        baseline={
            "min_vm_pu": float(net.res_bus.vm_pu.min()),
            "max_vm_pu": float(net.res_bus.vm_pu.max()),
            "total_load_mw": float(net.load.p_mw.sum()) if len(net.load) else 0.0,
            "line_max_loading_pct": float(net.res_line.loading_percent.max()) if len(net.line) else 0.0,
        }
        # OPF; benchmark cases imported by pandapower generally carry cost/limit data.
        pp.runopp(net, calculate_voltage_angles=True, init="pf")
        elapsed=time.perf_counter()-t0
        objective=float(getattr(net,"res_cost",float("nan")))
        metrics={
            "min_vm_pu": float(net.res_bus.vm_pu.min()),
            "max_vm_pu": float(net.res_bus.vm_pu.max()),
            "line_max_loading_pct": float(net.res_line.loading_percent.max()) if len(net.line) else 0.0,
            "baseline": baseline,
        }
        series={
            "bus_vm_pu": {str(i):float(v) for i,v in net.res_bus.vm_pu.items()},
            "line_loading_pct": {str(i):float(v) for i,v in net.res_line.loading_percent.items()} if len(net.line) else {},
        }
        return {
            "status":"success",
            "backend":{"name":self.name,"model_fidelity":"AC_OPF"},
            "solver":{"termination_condition":"optimal_or_converged","solve_time_s":elapsed},
            "objective":{"total":objective},"metrics":metrics,"series":series,"boundary_ports":{},
            "validation":{"numeric_execution":True,"ac_powerflow_converged":True,"violations":[]},"warnings":[]
        }

class PandapowerDCOPFBackend(OptimizationBackend):
    name="pandapower_dcopf"
    capabilities=BackendCapabilities(single_period=True,active_power=True,reactive_power=False,ac_validation=False)
    def run(self,spec,context):
        try: import pandapower as pp
        except ImportError as e: raise RuntimeError("pandapower is required for pandapower_dcopf") from e
        net=load_pandapower_case(spec["case"]["case_id"])
        t0=time.perf_counter(); pp.rundcopp(net); elapsed=time.perf_counter()-t0
        return {"status":"success","backend":{"name":self.name,"model_fidelity":"DC_OPF"},
                "solver":{"termination_condition":"optimal_or_converged","solve_time_s":elapsed},
                "objective":{"total":float(getattr(net,"res_cost",float("nan")))},
                "metrics":{},"series":{},"boundary_ports":{},
                "validation":{"numeric_execution":True,"ac_powerflow_converged":None,"violations":[]},
                "warnings":["DC OPF is an approximation; use an AC validation step before engineering interpretation."]}
