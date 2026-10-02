#!/usr/bin/env python3
"""Render a chart PNG/SVG from JSON spec or CSV for chart-discovery."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path


def die(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def load_spec(path: str | None) -> dict:
    if not path:
        return {}
    text = Path(path).read_text(encoding="utf-8-sig")
    data = json.loads(text)
    if not isinstance(data, dict):
        die("spec.json 必须是对象。")
    return data


def read_csv(path: str, x_col: str, y_cols: list[str]) -> dict:
    with Path(path).open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        die("CSV 没有数据行。")
    if not x_col:
        x_col = next(iter(rows[0].keys()))
    if x_col not in rows[0]:
        die(f"CSV 没有列：{x_col}")
    if not y_cols:
        y_cols = [name for name in rows[0] if name != x_col][:4]
    series = []
    for name in y_cols:
        if name not in rows[0]:
            die(f"CSV 没有列：{name}")
        values = []
        for row in rows:
            raw = str(row.get(name, "")).strip().replace(",", "")
            try:
                values.append(float(raw))
            except ValueError:
                values.append(None)
        series.append({"name": name, "y": values})
    return {
        "x": [str(row.get(x_col, "")) for row in rows],
        "series": series,
    }


def to_floats(values) -> list[float]:
    out = []
    for item in values:
        if item is None or item == "":
            out.append(float("nan"))
            continue
        try:
            out.append(float(str(item).replace(",", "")))
        except ValueError:
            out.append(float("nan"))
    return out


# Default bbox_inches="tight" only pads 0.1in; CJK titles then sit on the
# figure edge and look cropped in chat thumbnails.
SAVE_PAD_INCHES = 0.45
MIN_PNG_MARGIN_PX = 48


def setup_font(plt) -> None:
    candidates = [
        "Microsoft YaHei",
        "SimHei",
        "Source Han Sans CN",
        "Noto Sans CJK SC",
        "WenQuanYi Micro Hei",
        "Arial Unicode MS",
        "DejaVu Sans",
    ]
    try:
        from matplotlib import font_manager

        available = {item.name for item in font_manager.fontManager.ttflist}
        chosen = next((name for name in candidates if name in available), "DejaVu Sans")
        plt.rcParams["font.sans-serif"] = [chosen, "DejaVu Sans"]
    except Exception:
        plt.rcParams["font.sans-serif"] = candidates
    plt.rcParams["axes.unicode_minus"] = False
    plt.rcParams["axes.titlepad"] = 14
    plt.rcParams["savefig.facecolor"] = "white"
    plt.rcParams["savefig.edgecolor"] = "none"
    plt.rcParams["savefig.bbox"] = "tight"
    plt.rcParams["savefig.pad_inches"] = SAVE_PAD_INCHES


def _rgb_uint8(image):
    import numpy as np

    arr = np.asarray(image)
    if arr.ndim == 2:
        arr = np.repeat(arr[..., None], 3, axis=2)
    if arr.dtype == np.uint8:
        rgb = arr[..., :3].astype(np.float32)
        if arr.shape[-1] == 4:
            alpha = arr[..., 3:4].astype(np.float32) / 255.0
            rgb = rgb * alpha + 255.0 * (1.0 - alpha)
        return np.clip(rgb, 0, 255).astype(np.uint8)
    rgb = arr[..., :3].astype(np.float32)
    if float(np.nanmax(rgb)) <= 1.0:
        rgb = rgb * 255.0
    if arr.shape[-1] == 4:
        alpha = arr[..., 3:4].astype(np.float32)
        if float(np.nanmax(alpha)) <= 1.0:
            pass
        else:
            alpha = alpha / 255.0
        rgb = rgb * alpha + 255.0 * (1.0 - alpha)
    return np.clip(rgb, 0, 255).astype(np.uint8)


def ensure_png_margin(path: Path, min_px: int = MIN_PNG_MARGIN_PX) -> None:
    """Pad a PNG with white if content (especially the title) sits on the edge."""
    if path.suffix.lower() != ".png" or not path.exists():
        return
    try:
        import numpy as np
        import matplotlib.image as mpimg
    except ImportError:
        return
    rgb = _rgb_uint8(mpimg.imread(path))
    ink = np.any(rgb < 250, axis=2)
    if not ink.any():
        return
    rows = np.where(ink.any(axis=1))[0]
    cols = np.where(ink.any(axis=0))[0]
    top, bottom = int(rows[0]), int(rows[-1])
    left, right = int(cols[0]), int(cols[-1])
    height, width = rgb.shape[:2]
    pad_top = max(0, min_px - top)
    pad_bottom = max(0, min_px - (height - 1 - bottom))
    pad_left = max(0, min_px - left)
    pad_right = max(0, min_px - (width - 1 - right))
    if pad_top == pad_bottom == pad_left == pad_right == 0:
        return
    padded = np.pad(
        rgb,
        ((pad_top, pad_bottom), (pad_left, pad_right), (0, 0)),
        mode="constant",
        constant_values=255,
    )
    mpimg.imsave(path, padded)


def save_chart(fig, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(
        out_path,
        bbox_inches="tight",
        pad_inches=SAVE_PAD_INCHES,
        facecolor="white",
        edgecolor="none",
    )
    ensure_png_margin(out_path)


def render(spec: dict, out_path: Path) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        die("缺少 matplotlib。请先运行：python -m pip install matplotlib pandas")

    setup_font(plt)
    kind = str(spec.get("kind") or "line").strip().lower()
    title = str(spec.get("title") or "").strip()
    xlabel = str(spec.get("xlabel") or "").strip()
    ylabel = str(spec.get("ylabel") or "").strip()
    xs = [str(item) for item in (spec.get("x") or [])]
    series = spec.get("series") or []
    if not isinstance(series, list) or not series:
        die("缺少 series。")

    fig, ax = plt.subplots(figsize=(9.2, 5.1), dpi=140)
    colors = ["#0f766e", "#c2410c", "#1d4ed8", "#7c3aed", "#b45309", "#be123c"]

    if kind == "pie":
        first = series[0]
        labels = xs or [str(item) for item in (first.get("x") or [])] or [first.get("name") or "系列"]
        values = to_floats(first.get("y") or [])
        if len(labels) != len(values):
            die("饼图的 x 与 y 长度不一致。")
        ax.pie(values, labels=labels, autopct="%1.1f%%", startangle=90, colors=colors[: len(values)])
        ax.axis("equal")
    else:
        if not xs:
            length = max(len(item.get("y") or []) for item in series)
            xs = [str(index + 1) for index in range(length)]
        positions = list(range(len(xs)))
        if kind == "bar":
            width = 0.8 / max(1, len(series))
            for index, item in enumerate(series):
                offset = (index - (len(series) - 1) / 2) * width
                ax.bar(
                    [pos + offset for pos in positions],
                    to_floats(item.get("y") or []),
                    width=width,
                    label=str(item.get("name") or f"系列{index + 1}"),
                    color=colors[index % len(colors)],
                )
            ax.set_xticks(positions)
            ax.set_xticklabels(xs, rotation=30, ha="right")
        elif kind == "hbar":
            ax.barh(xs, to_floats(series[0].get("y") or []), color=colors[0])
        elif kind == "scatter":
            for index, item in enumerate(series):
                ys = to_floats(item.get("y") or [])
                ax.scatter(positions[: len(ys)], ys, label=str(item.get("name") or f"系列{index + 1}"), color=colors[index % len(colors)])
            ax.set_xticks(positions)
            ax.set_xticklabels(xs, rotation=30, ha="right")
        else:
            for index, item in enumerate(series):
                ys = to_floats(item.get("y") or [])
                ax.plot(positions[: len(ys)], ys, marker="o", linewidth=2, label=str(item.get("name") or f"系列{index + 1}"), color=colors[index % len(colors)])
            ax.set_xticks(positions)
            ax.set_xticklabels(xs, rotation=30, ha="right")
        if xlabel:
            ax.set_xlabel(xlabel)
        if ylabel:
            ax.set_ylabel(ylabel)
        if len(series) > 1 or kind != "hbar":
            ax.legend(frameon=False)
        ax.grid(True, axis="y", linestyle="--", alpha=0.35)
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)

    if title:
        ax.set_title(title, pad=16)
    fig.tight_layout(pad=1.2)
    save_chart(fig, out_path)
    plt.close(fig)
    print(str(out_path))


def main() -> None:
    parser = argparse.ArgumentParser(description="chart-discovery 出图")
    parser.add_argument("--spec", help="JSON 规格文件")
    parser.add_argument("--csv", help="CSV 数据文件")
    parser.add_argument("--x", dest="x_col", default="", help="CSV 横轴列名")
    parser.add_argument("--y", dest="y_cols", default="", help="CSV 数值列，逗号分隔")
    parser.add_argument("--kind", default="", help="line/bar/hbar/pie/scatter")
    parser.add_argument("--title", default="", help="图题")
    parser.add_argument("--xlabel", default="", help="横轴名")
    parser.add_argument("--ylabel", default="", help="纵轴名")
    parser.add_argument("--out", help="输出 PNG 或 SVG")
    parser.add_argument(
        "--ensure-margin",
        nargs="+",
        metavar="PNG",
        help="给已有 PNG 补白边，避免中文标题贴顶被裁切",
    )
    args = parser.parse_args()

    if args.ensure_margin:
        for item in args.ensure_margin:
            ensure_png_margin(Path(item))
        return
    if not args.out:
        die("请提供 --out。")

    spec = load_spec(args.spec)
    if args.csv:
        spec.update(read_csv(args.csv, args.x_col, [item for item in args.y_cols.split(",") if item.strip()]))
    if args.kind:
        spec["kind"] = args.kind
    if args.title:
        spec["title"] = args.title
    if args.xlabel:
        spec["xlabel"] = args.xlabel
    if args.ylabel:
        spec["ylabel"] = args.ylabel
    if not spec:
        die("请提供 --spec 或 --csv。")
    render(spec, Path(args.out))


if __name__ == "__main__":
    main()
