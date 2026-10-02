from __future__ import annotations
from pathlib import Path
import pandas as pd
from .utils import package_root


def resolve_profile(spec: dict, source_spec_path: str | None = None):
    ts=spec.get("timeseries") or {}
    profile=ts.get("profile_file")
    if not profile: return None
    p=Path(profile)
    if not p.is_absolute():
        if source_spec_path:
            candidate=Path(source_spec_path).resolve().parent/p
            if candidate.exists(): p=candidate
            else: p=package_root()/p
        else: p=package_root()/p
    if not p.exists(): raise FileNotFoundError(f"Profile not found: {p}")
    df=pd.read_csv(p)
    return df
