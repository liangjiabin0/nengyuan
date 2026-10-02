from __future__ import annotations
from dataclasses import dataclass

@dataclass(frozen=True)
class CaseInfo:
    case_id: str
    kind: str
    loader: str | None
    standard: bool
    note: str

CASES = {
    "ieee14": CaseInfo("ieee14", "transmission", "case14", True, "IEEE 14-bus test case"),
    "ieee30": CaseInfo("ieee30", "transmission", "case30", True, "30-bus test case / common OPF benchmark"),
    "ieee57": CaseInfo("ieee57", "transmission", "case57", True, "IEEE 57-bus test case"),
    "ieee118": CaseInfo("ieee118", "transmission", "case118", True, "IEEE 118-bus test case"),
    "case33bw": CaseInfo("case33bw", "distribution", "case33bw", True, "33-bus radial distribution test case"),
    "main_dist_micro_demo": CaseInfo("main_dist_micro_demo", "composite", None, False, "Composite template: IEEE14 + case33bw + microgrid templates"),
}

def list_cases():
    return [vars(v) for v in CASES.values()]


def case_info(case_id):
    try: return CASES[case_id]
    except KeyError: raise KeyError(f"Unknown case_id: {case_id}")


def load_pandapower_case(case_id):
    info = case_info(case_id)
    if not info.loader:
        raise ValueError(f"{case_id} is composite and cannot be loaded as a single pandapower case")
    try:
        import pandapower.networks as pn
    except ImportError as e:
        raise RuntimeError("pandapower is not installed. Install requirements-full.txt") from e
    loader = getattr(pn, info.loader)
    return loader()
