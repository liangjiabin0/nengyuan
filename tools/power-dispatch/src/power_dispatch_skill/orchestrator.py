from __future__ import annotations
from pathlib import Path
import uuid
from .validation import assert_valid
from .registry import BackendRegistry
from .utils import digest_object
from .composite import build_main_dist_micro_manifest
from .profiles import resolve_profile

class DispatchOrchestrator:
    def __init__(self, registry=None): self.registry=registry or BackendRegistry()

    def plan_context(self,spec):
        ctx={"input_digest":digest_object(spec)}
        if spec["case"]["case_id"]=="main_dist_micro_demo": ctx["composite_manifest"]=build_main_dist_micro_manifest(spec)
        source=(spec.get("metadata") or {}).get("source_file")
        df=resolve_profile(spec,source)
        if df is not None:
            ctx["profile_columns"]=list(df.columns); ctx["profile_rows"]=len(df)
        return ctx

    def run(self,spec,force_dry_run=False):
        validation=assert_valid(spec)
        context=self.plan_context(spec)
        backend_name="reference_dry_run" if force_dry_run else spec["solver"]["backend"]
        backend=self.registry.get(backend_name)
        ok,reason=backend.supports(spec)
        if not ok and backend_name!="reference_dry_run":
            return self._bundle(spec,context,{"status":"unsupported","backend":{"name":backend_name},"solver":{},"objective":{},"metrics":{},"series":{},"boundary_ports":{},"validation":{"numeric_execution":False,"violations":[]},"warnings":[reason]+validation["warnings"]})
        raw=backend.run(spec,context)
        raw.setdefault("warnings",[]); raw["warnings"] += validation["warnings"]
        return self._bundle(spec,context,raw)

    def _bundle(self,spec,context,raw):
        run_id=f"run_{uuid.uuid4().hex[:12]}"
        return {"run_id":run_id,"status":raw.get("status","failed"),"input_digest":context["input_digest"],
                "task":spec.get("task"),"case":spec.get("case"),"capabilities":spec.get("capabilities"),
                "backend":raw.get("backend",{}),"solver":raw.get("solver",{}),"objective":raw.get("objective",{}),
                "metrics":raw.get("metrics",{}),"series":raw.get("series",{}),"boundary_ports":raw.get("boundary_ports",{}),
                "validation":raw.get("validation",{}),"warnings":raw.get("warnings",[]),"artifacts":["run_spec.json","result_bundle.json"]}
