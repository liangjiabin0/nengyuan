from __future__ import annotations

import csv
from pathlib import Path


def render_csv(spec: dict, output: str | Path) -> Path:
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    encoding = spec.get("encoding") or "utf-8-sig"
    delimiter = spec.get("delimiter") or ","
    columns = spec.get("columns") or []
    rows = spec.get("rows") or []
    with output.open("w", encoding=encoding, newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=columns,
            delimiter=delimiter,
            quoting=csv.QUOTE_MINIMAL,
            extrasaction="ignore",
        )
        writer.writeheader()
        for row in rows:
            writer.writerow({key: "" if row.get(key) is None else row.get(key) for key in columns})
    return output
