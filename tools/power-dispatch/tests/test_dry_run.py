from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"src"))
from power_dispatch_skill.io import load_spec
from power_dispatch_skill.orchestrator import DispatchOrchestrator

def test_dry_run_ieee14():
    spec=load_spec(ROOT/"examples"/"inputs"/"ieee14_acopf.yaml")
    r=DispatchOrchestrator().run(spec,force_dry_run=True)
    assert r["status"]=="planned"
    assert r["validation"]["numeric_execution"] is False
