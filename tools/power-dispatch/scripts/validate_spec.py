from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"src"))

import argparse, json
from power_dispatch_skill.io import load_spec
from power_dispatch_skill.validation import validate_run_spec
p=argparse.ArgumentParser(); p.add_argument("spec"); a=p.parse_args()
spec=load_spec(a.spec); result=validate_run_spec(spec)
print(json.dumps(result,ensure_ascii=False,indent=2))
raise SystemExit(0 if result["valid"] else 2)
