from __future__ import annotations
import json
from pathlib import Path
from jsonschema import Draft202012Validator
from .utils import package_root
from .cases import CASES

class SpecValidationError(ValueError):
    pass


def _schema():
    p = package_root()/"schemas"/"run-spec.schema.json"
    return json.loads(p.read_text(encoding="utf-8"))


def validate_run_spec(spec: dict):
    errors=[]; warnings=[]
    validator=Draft202012Validator(_schema())
    for err in sorted(validator.iter_errors(spec), key=lambda e: list(e.path)):
        loc=".".join(map(str,err.path)) or "$"
        errors.append(f"{loc}: {err.message}")
    if errors:
        return {"valid":False,"errors":errors,"warnings":warnings}

    case_id=spec["case"]["case_id"]
    if case_id not in CASES: errors.append(f"Unknown case_id: {case_id}")
    caps=spec["capabilities"]
    hierarchy=caps["hierarchy"]
    scales=caps["time_scales"]
    backend=spec["solver"]["backend"]

    if hierarchy == "main_distribution_microgrid":
        if case_id != "main_dist_micro_demo" and not spec["case"].get("boundary_ports"):
            errors.append("main_distribution_microgrid requires boundary_ports or main_dist_micro_demo")
    if len(scales)>1 and not caps.get("rolling_optimization",False):
        warnings.append("Multiple time scales selected but rolling_optimization=false")
    if caps["power_control"]=="PQ" and backend=="pandapower_dcopf":
        errors.append("PQ coordination is incompatible with pandapower_dcopf")
    if "single_period" not in scales and "timeseries" not in spec:
        errors.append("Non-single-period task requires timeseries")
    if backend=="reference_dry_run":
        warnings.append("reference_dry_run does not perform numerical optimization")
    if case_id=="main_dist_micro_demo":
        warnings.append("main_dist_micro_demo is a composite template, not an IEEE standard main-distribution-microgrid case")
    return {"valid":not errors,"errors":errors,"warnings":warnings}


def assert_valid(spec):
    r=validate_run_spec(spec)
    if not r["valid"]:
        raise SpecValidationError("; ".join(r["errors"]))
    return r
