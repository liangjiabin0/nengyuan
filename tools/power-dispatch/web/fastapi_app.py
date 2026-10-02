from __future__ import annotations
from pathlib import Path
import sys, json
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"src"))
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from power_dispatch_skill.validation import validate_run_spec
from power_dispatch_skill.orchestrator import DispatchOrchestrator
from power_dispatch_skill.cases import list_cases

app=FastAPI(title="Power Dispatch Optimization Skill API",version="0.1.0")
ORCH=DispatchOrchestrator()
RESULTS={}

class RunRequest(BaseModel):
    spec: dict
    dry_run: bool=False

@app.get("/api/cases")
def get_cases(): return {"items":list_cases()}

@app.get("/api/backends")
def get_backends(): return {"items":ORCH.registry.list()}

@app.post("/api/run/validate")
def validate(req:RunRequest): return validate_run_spec(req.spec)

@app.post("/api/run")
def run(req:RunRequest):
    v=validate_run_spec(req.spec)
    if not v["valid"]: raise HTTPException(status_code=422,detail=v)
    try: bundle=ORCH.run(req.spec,force_dry_run=req.dry_run)
    except Exception as e: raise HTTPException(status_code=500,detail={"type":type(e).__name__,"message":str(e)})
    RESULTS[bundle["run_id"]]=bundle
    return bundle

@app.get("/api/result/{run_id}")
def result(run_id:str):
    if run_id not in RESULTS: raise HTTPException(status_code=404,detail="run_id not found")
    return RESULTS[run_id]

@app.get("/health")
def health(): return {"ok":True}
