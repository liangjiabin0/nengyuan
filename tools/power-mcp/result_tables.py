"""Write full CSV tables while bounding the data sent through MCP and the browser."""

import csv
import math


def export_table(directory, name, rows, preview_limit=1000):
    preview = []
    count = 0
    writer = None
    with (directory / (name + ".csv")).open(
        "w", newline="", encoding="utf-8-sig"
    ) as stream:
        for row in rows:
            if writer is None:
                writer = csv.DictWriter(stream, fieldnames=list(row))
                writer.writeheader()
            for value in row.values():
                if isinstance(value, float) and not math.isfinite(value):
                    raise ValueError("结果表包含非有限数")
            writer.writerow(
                {
                    key: "'" + value
                    if isinstance(value, str)
                    and value.startswith(("=", "+", "-", "@", "\t", "\r"))
                    else value
                    for key, value in row.items()
                }
            )
            if len(preview) < preview_limit:
                preview.append(row)
            count += 1
    return preview, count
