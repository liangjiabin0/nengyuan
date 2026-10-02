from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"src"))

import json
from power_dispatch_skill.cases import list_cases
print(json.dumps(list_cases(),ensure_ascii=False,indent=2))
