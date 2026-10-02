from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"src"))
from power_dispatch_skill.io import load_spec
from power_dispatch_skill.validation import validate_run_spec

def test_all_examples_validate():
    for f in (ROOT/"examples"/"inputs").glob("*.yaml"):
        r=validate_run_spec(load_spec(f))
        assert r["valid"], (f,r)
