from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"src"))

from pathlib import Path
from power_dispatch_skill.io import load_spec
from power_dispatch_skill.validation import validate_run_spec
from power_dispatch_skill.orchestrator import DispatchOrchestrator
ROOT=Path(__file__).resolve().parents[1]
files=sorted((ROOT/"examples"/"inputs").glob("*.yaml"))
for f in files:
    spec=load_spec(f); v=validate_run_spec(spec)
    assert v["valid"], (f,v)
    bundle=DispatchOrchestrator().run(spec,force_dry_run=True)
    assert bundle["status"]=="planned", bundle
    print("OK",f.name,bundle["input_digest"][:12])
print(f"{len(files)} example specs passed schema + dry-run smoke test")
