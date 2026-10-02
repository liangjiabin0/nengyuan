from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"src"))

import argparse, json
from pathlib import Path
from power_dispatch_skill.io import load_spec, dump_json
from power_dispatch_skill.orchestrator import DispatchOrchestrator
p=argparse.ArgumentParser(); p.add_argument("spec"); p.add_argument("--dry-run",action="store_true"); p.add_argument("--output",default="runs/latest")
a=p.parse_args(); spec=load_spec(a.spec)
out=Path(a.output); out.mkdir(parents=True,exist_ok=True)
bundle=DispatchOrchestrator().run(spec,force_dry_run=a.dry_run)
dump_json(out/"run_spec.json",spec); dump_json(out/"result_bundle.json",bundle)
print(json.dumps(bundle,ensure_ascii=False,indent=2))
