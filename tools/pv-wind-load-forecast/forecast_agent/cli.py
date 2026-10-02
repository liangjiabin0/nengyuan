from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any

import numpy as np

from . import energy, load, pv, wind
from .common import (
    keras_ready,
    metrics,
    save_payload,
    write_chart,
    write_dispatch_profile,
    write_predict_csv,
    file_identity,
)


def emit(payload: dict[str, Any]) -> None:
    text = json.dumps(payload, ensure_ascii=True, default=str) + "\n"
    sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
    sys.stdout.flush()


def _health() -> dict[str, Any]:
    info: dict[str, Any] = {
        "ok": True,
        "type": "result",
        "engine": "pv-wind-load-forecast",
        "python": sys.version.split()[0],
        "sklearn": False,
        "keras": keras_ready(),
        "tensorflow": False,
        "kinds": ["pv", "wind", "load", "energy"],
        "models": ["lstm", "gru", "svr", "cnn"],
        "variants": ["v1", "v2", "v3", "v4", "v5"],
        "papers": [
            "pvdaq-lstm-adaptation",
            "wind-kaggle-paper-compatible-or-adapted",
            "wind-gaf-cnn-paper-compatible-or-adapted",
            "load-multifeature-v1-adaptation",
            "load-multifeature-v2-adaptation",
            "load-multifeature-v3-adaptation",
            "load-multifeature-v4-adaptation",
            "load-multifeature-v5-adaptation",
            "ercot-bidirectional-adaptation",
        ],
    }
    try:
        import sklearn  # noqa: F401

        info["sklearn"] = True
    except Exception as exc:
        info["ok"] = False
        info["error"] = str(exc)
    try:
        import tensorflow  # noqa: F401

        info["tensorflow"] = True
    except Exception:
        info["tensorflow"] = False
    return info


def _run(
    kind: str,
    model_name: str,
    output_dir: Path,
    data_path: Path | None,
    horizon: int,
    action: str,
    variant: str,
    epochs: int,
    target: str | None,
    features: list[str] | None,
    window: int | None,
    seed: int | None,
    train_ratio: float | None,
    validation_ratio: float | None,
    test_ratio: float | None,
) -> dict[str, Any]:
    if seed is not None:
        np_seed = int(seed)
        import random

        random.seed(np_seed)
        np.random.seed(np_seed)
        try:
            from keras.utils import set_random_seed

            set_random_seed(np_seed)
        except Exception:
            pass
    output_dir.mkdir(parents=True, exist_ok=True)
    if kind == "pv":
        raw = pv.run(
            kind, model_name, data_path, horizon, action, output_dir, epochs, target, features, window,
            train_ratio, validation_ratio, test_ratio
        )
    elif kind == "wind":
        raw = wind.run(
            kind, model_name, data_path, horizon, action, output_dir, epochs, target, features, window,
            train_ratio, validation_ratio, test_ratio
        )
    elif kind == "load":
        raw = load.run(
            kind, model_name, data_path, horizon, action, output_dir, epochs, variant, target, features, window,
            train_ratio, validation_ratio, test_ratio
        )
    else:
        raw = energy.run(
            kind, model_name, data_path, horizon, action, output_dir, epochs, target, features, window,
            train_ratio, validation_ratio, test_ratio
        )

    if len(raw) == 8:
        actual, holdout, used, future, weight_path, columns, paper, audit = raw
    else:
        actual, holdout, used, future, weight_path, columns, paper = raw
        audit = {}

    csv_path = output_dir / f"{kind}_{used}_{action}.csv"
    write_predict_csv(csv_path, kind, actual, holdout, future)
    profile_path = write_dispatch_profile(output_dir / f"{kind}_profile.csv", kind, future)
    dispatch_path = write_dispatch_profile(output_dir / "dispatch-profile.csv", kind, future)
    chart_path = write_chart(output_dir / "forecast.png", actual, holdout, future, f"{kind} / {used}")
    metric = metrics(actual, holdout)
    for name, value in metric.items():
        if isinstance(value, float) and not np.isfinite(value):
            raise ValueError(f"指标 {name} 不是有限数值。")
    identity = file_identity(data_path)
    audit_data = audit.get("data") if isinstance(audit, dict) and isinstance(audit.get("data"), dict) else {}
    audit = audit if isinstance(audit, dict) else {}
    output_files = [csv_path.name, profile_path.name, dispatch_path.name, "metrics.json"]
    if chart_path:
        output_files.append(chart_path.name)
    payload = {
        "ok": True,
        "success": True,
        "type": "result",
        "engine": "pv-wind-load-forecast",
        "status": "success",
        "kind": kind,
        "model": used,
        "requestedModel": model_name,
        "action": action,
        "variant": variant,
        "paper": paper,
        "features": columns,
        "horizon": horizon,
        "samples": int(len(actual) + len(future)),
        "metrics": metric,
        "weightPath": weight_path,
        "predictCsv": str(csv_path),
        "profileCsv": str(profile_path),
        "dispatchProfile": str(dispatch_path),
        "chartPng": str(chart_path) if chart_path else None,
        "outputDir": str(output_dir),
        "outputFiles": output_files,
        "exogenous": "persist_last",
        "fidelity": audit.get("fidelity") or ("fallback" if used in {"ridge", "svr"} else "adapted"),
        "weightStatus": audit.get("weightStatus") or ("trained" if weight_path else "not-used"),
        "dataPath": str(identity.get("path") or audit_data.get("path") or data_path or ""),
        "dataSha256": identity.get("sha256") or audit_data.get("sha256"),
        "dataBytes": identity.get("bytes") or audit_data.get("bytes"),
        "inputShape": audit.get("inputShape"),
        "scaler": audit.get("scaler"),
        "warnings": audit.get("warnings") or [],
        "audit": audit,
        "split": {
            "method": "chronological",
            "trainRatio": train_ratio,
            "validationRatio": validation_ratio,
            "testRatio": test_ratio,
        },
    }
    return save_payload(output_dir, payload)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="forecast-agent")
    parser.add_argument("command", choices=["health", "predict", "train"])
    parser.add_argument("--kind", choices=["pv", "wind", "load", "energy"], default="pv")
    parser.add_argument("--model", choices=["lstm", "gru", "svr", "cnn"], default="lstm")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--data", type=Path)
    parser.add_argument("--horizon", type=int, default=24)
    parser.add_argument("--variant", choices=["v1", "v2", "v3", "v4", "v5"], default="v3")
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--target")
    parser.add_argument("--features", help="逗号分隔的外生特征列")
    parser.add_argument("--window", type=int)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--train-ratio", type=float)
    parser.add_argument("--validation-ratio", type=float)
    parser.add_argument("--test-ratio", type=float)
    args = parser.parse_args(argv)
    try:
        if args.command == "health":
            emit(_health())
            return 0
        if not args.output_dir:
            raise ValueError("predict/train 需要 --output-dir")
        epochs = args.epochs if args.command == "train" else max(2, min(args.epochs, 6))
        features = [item.strip() for item in str(args.features or "").split(",") if item.strip()]
        ratios = [value for value in (args.train_ratio, args.validation_ratio, args.test_ratio) if value is not None]
        if any(value < 0 or value >= 1 for value in ratios):
            raise ValueError("训练/验证/测试比例必须在 [0, 1) 范围内")
        if len(ratios) == 3 and abs(sum(ratios) - 1.0) > 1e-6:
            raise ValueError("训练、验证、测试比例之和必须为 1")
        emit(
            _run(
                args.kind,
                args.model,
                args.output_dir,
                args.data,
                args.horizon,
                args.command,
                args.variant,
                epochs,
                args.target,
                features or None,
                args.window,
                args.seed,
                args.train_ratio,
                args.validation_ratio,
                args.test_ratio,
            )
        )
        return 0
    except Exception as exc:
        emit(
            {
                "ok": False,
                "type": "error",
                "engine": "pv-wind-load-forecast",
                "error": str(exc),
                "trace": traceback.format_exc(limit=8),
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
