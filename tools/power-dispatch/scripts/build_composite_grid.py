from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"src"))

import argparse, json
from power_dispatch_skill.io import load_spec
from power_dispatch_skill.composite import build_main_dist_micro_manifest
p=argparse.ArgumentParser(); p.add_argument("spec"); a=p.parse_args()
spec=load_spec(a.spec)
print(json.dumps(build_main_dist_micro_manifest(spec),ensure_ascii=False,indent=2))
