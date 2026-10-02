from __future__ import annotations

import json
import hashlib
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
PV_DIR = ROOT / "solor" / "LSTM-power-forecasting-master"
WIND_DIR = ROOT / "wind" / "wind-power-forcast-kaggle"
LOAD_DIR = ROOT / "load" / "Multi-feature-power-load-forecasting-based-on-deep-learning-master" / "power_load_forecasting_V1"
ENERGY_DIR = ROOT / "load-energy-fcst" / "Texas-Energy-Demand-Forecasting-main"

TARGET_ALIASES = {
    "pv": ["dc_power", "ac_power", "pv", "p_mw", "power"],
    "wind": ["activepower", "active_power", "wind", "p_mw", "power"],
    "load": ["power", "load", "p_mw", "demand"],
    "energy": ["mwh", "demand", "load", "energy", "power"],
}

FEATURE_GROUPS = {
    "temp": ["ambient_temp", "module_temp", "inverter_temp", "temperature", "temp", "tmpf", "feel"],
    "humidity": ["relative_humidity", "humidity", "relh"],
    "wind_speed": ["wind_speed", "windspeed", "speed", "sknt"],
    "wind_dir": ["wind_direction", "winddirection", "drct"],
    "irradiance": ["poa_irradiance", "ghi", "dni", "dhi", "irradiance"],
}


def keras_ready() -> bool:
    try:
        import keras  # noqa: F401
        import tensorflow  # noqa: F401

        return True
    except Exception:
        return False


def metrics(actual: np.ndarray, pred: np.ndarray) -> dict[str, float | int | None]:
    actual = np.asarray(actual, dtype=float).reshape(-1)
    pred = np.asarray(pred, dtype=float).reshape(-1)
    n = min(len(actual), len(pred))
    if n == 0:
        return {"mae": None, "rmse": None, "mape": None, "smape": None, "mapeCoverage": 0}
    actual, pred = actual[-n:], pred[-n:]
    mae = float(np.mean(np.abs(actual - pred)))
    rmse = float(np.sqrt(np.mean((actual - pred) ** 2)))
    nonzero = np.abs(actual) > 1e-6
    mape = float(np.mean(np.abs((actual[nonzero] - pred[nonzero]) / actual[nonzero])) * 100) if np.any(nonzero) else None
    smape_denom = np.abs(actual) + np.abs(pred)
    smape_mask = smape_denom > 1e-6
    smape = float(np.mean(2 * np.abs(actual[smape_mask] - pred[smape_mask]) / smape_denom[smape_mask]) * 100) if np.any(smape_mask) else None
    return {
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "mape": round(mape, 4) if mape is not None else None,
        "mapeCoverage": round(float(np.mean(nonzero) * 100), 4),
        "smape": round(smape, 4) if smape is not None else None,
    }


def _norm(name: str) -> str:
    return str(name).strip().lower().replace(" ", "").replace("-", "_")


def resolve_target_column(df: pd.DataFrame, kind: str) -> str:
    aliases = TARGET_ALIASES[kind]
    cols = { _norm(col): col for col in df.columns }
    for alias in aliases:
        if alias in cols:
            return cols[alias]
    numeric = [col for col in df.columns if pd.api.types.is_numeric_dtype(df[col])]
    if not numeric:
        raise ValueError("没有可用数值列")
    # never prefer an obvious time/index leftover
    for col in reversed(numeric):
        if _norm(col) not in {"unnamed:0", "he", "hour", "step", "siteid"}:
            return col
    return numeric[-1]


def pick_columns(df: pd.DataFrame, names: list[str]) -> list[str]:
    cols = { _norm(col): col for col in df.columns }
    found = []
    for name in names:
        key = _norm(name)
        if key in cols and cols[key] not in found:
            found.append(cols[key])
    return found


def extra_feature_columns(df: pd.DataFrame, target: str) -> list[str]:
    found: list[str] = []
    for group in FEATURE_GROUPS.values():
        found.extend(pick_columns(df, group))
    numeric = [
        col for col in df.columns
        if col != target and pd.api.types.is_numeric_dtype(df[col]) and _norm(col) not in {
            "unnamed:0", "he", "siteid", "inverter_error_code"
        }
    ]
    # keep paper-relevant extras first, then remaining numeric (capped)
    ordered = []
    for col in found + numeric:
        if col not in ordered and col != target:
            ordered.append(col)
    return ordered[:12]


def parse_time_index(df: pd.DataFrame) -> pd.DatetimeIndex | None:
    for col in df.columns:
        key = _norm(col)
        if key in {"date-time", "datetime", "date", "time", "valid", "timestamp"}:
            parsed = pd.to_datetime(df[col], errors="coerce")
            if parsed.notna().mean() > 0.6:
                return pd.DatetimeIndex(parsed)
    if isinstance(df.index, pd.DatetimeIndex):
        return df.index
    return None


def add_calendar(frame: pd.DataFrame, index: pd.DatetimeIndex | None) -> pd.DataFrame:
    out = frame.copy()
    if index is None:
        return out
    out["hour"] = index.hour.to_numpy()
    out["month"] = index.month.to_numpy()
    out["dow"] = index.dayofweek.to_numpy()
    return out


def season_mask(index: pd.DatetimeIndex | None, length: int) -> np.ndarray:
    if index is None:
        return np.ones(length, dtype=bool)
    month = index.month.to_numpy()
    last = int(month[-1])
    if last in (6, 7, 8):
        return np.isin(month, [6, 7, 8])
    if last in (12, 1, 2):
        return np.isin(month, [12, 1, 2])
    return ~np.isin(month, [6, 7, 8, 12, 1, 2])


def default_data_path(kind: str) -> Path:
    if kind == "pv":
        return PV_DIR / "pvdaq_2012_2014_hourly.csv"
    if kind == "wind":
        return WIND_DIR / "Turbine_Data.csv"
    if kind == "load":
        return LOAD_DIR / "power.csv"
    if kind == "energy":
        return ENERGY_DIR / "Ercot_2011_2021_feb.csv"
    raise ValueError(f"未知预测种类：{kind}")


def read_table(kind: str, data_path: Path | None) -> pd.DataFrame:
    path = data_path or default_data_path(kind)
    if not path.is_file():
        raise FileNotFoundError(f"找不到数据文件：{path}")
    suffix = path.suffix.lower()
    if suffix in {".xlsx", ".xls"}:
        df = pd.read_excel(path)
    elif suffix == ".tsv":
        df = pd.read_csv(path, sep="\t")
    elif suffix == ".json":
        raw = json.loads(path.read_text(encoding="utf-8"))
        df = pd.DataFrame(raw if isinstance(raw, list) else raw.get("data", raw))
    else:
        df = pd.read_csv(path)
    df = df.replace(["M", "m", "NA", "NaN", ""], np.nan)
    return df


def file_identity(data_path: Path | None) -> dict[str, Any]:
    if data_path is None:
        return {"path": None, "sha256": None, "bytes": None}
    digest = hashlib.sha256()
    with data_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"path": str(data_path), "sha256": digest.hexdigest(), "bytes": data_path.stat().st_size}


def window_xy(values: np.ndarray, window: int, horizon_out: int = 1):
    x, y = [], []
    for index in range(window, len(values) - horizon_out + 1):
        x.append(values[index - window : index])
        y.append(values[index : index + horizon_out, 0] if values.ndim > 1 else values[index : index + horizon_out])
    return np.asarray(x, dtype=float), np.asarray(y, dtype=float)


def persist_exogenous(last_row: np.ndarray, pred: float, hour_idx: int | None, month_idx: int | None, dow_idx: int | None):
    nxt = last_row.copy()
    nxt[0] = pred
    if hour_idx is not None:
        nxt[hour_idx] = (nxt[hour_idx] + 1) % 24
    if month_idx is not None and hour_idx is not None and nxt[hour_idx] == 0:
        nxt[month_idx] = nxt[month_idx] % 12 + 1
    if dow_idx is not None and hour_idx is not None and nxt[hour_idx] == 0:
        nxt[dow_idx] = (nxt[dow_idx] + 1) % 7
    return nxt


def recursive_forecast(
    predict_one,
    history: np.ndarray,
    horizon: int,
    hour_idx: int | None = None,
    month_idx: int | None = None,
    dow_idx: int | None = None,
) -> np.ndarray:
    hist = np.asarray(history, dtype=float).copy()
    future = []
    for _ in range(horizon):
        pred = float(predict_one(hist))
        future.append(pred)
        nxt = persist_exogenous(hist[-1], pred, hour_idx, month_idx, dow_idx)
        hist = np.vstack([hist[1:], nxt])
    return np.asarray(future, dtype=float)


def split_index(length: int, test_ratio: float | None = None, minimum: int = 1) -> int:
    ratio = float(test_ratio) if test_ratio is not None else 0.2
    if not 0 < ratio < 1:
        raise ValueError("test_ratio 必须在 0 和 1 之间")
    return max(minimum, min(length - 1, int(length * (1 - ratio))))


def validation_fraction(validation_ratio: float | None, test_ratio: float | None) -> float:
    if validation_ratio is None or validation_ratio <= 0:
        return 0.0
    available = 1 - (float(test_ratio) if test_ratio is not None else 0.2)
    return min(0.4, max(0.0, float(validation_ratio) / max(available, 1e-6)))


def sklearn_multivariate(values: np.ndarray, horizon: int, window: int, model_name: str, test_ratio: float | None = None):
    from sklearn.linear_model import Ridge
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.svm import SVR

    clean = np.asarray(values, dtype=float)
    if len(clean) < window + 8:
        raise ValueError("有效样本太少，无法训练预测模型")
    x, y = window_xy(clean, window, 1)
    x2 = x.reshape((len(x), -1))
    y2 = y.reshape(-1)
    split = split_index(len(x2), test_ratio, min(window, len(x2) - 1))
    if model_name == "svr":
        model = make_pipeline(StandardScaler(), SVR(kernel="rbf", C=2.0, epsilon=0.0, gamma="scale"))
        used = "svr"
    else:
        model = make_pipeline(StandardScaler(), Ridge(alpha=1.0))
        used = "ridge"
    model.fit(x2[:split], y2[:split])
    holdout = model.predict(x2[split:]) if split < len(x2) else model.predict(x2[-min(24, len(x2)) :])
    actual = y2[split:] if split < len(y2) else y2[-len(holdout) :]

    def predict_one(hist: np.ndarray) -> float:
        return float(model.predict(hist.reshape(1, -1))[0])

    future = recursive_forecast(predict_one, clean[-window:], horizon)
    return actual, holdout, used, future


def write_predict_csv(path: Path, kind: str, actual: np.ndarray, pred: np.ndarray, future: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    for index, (left, right) in enumerate(zip(np.asarray(actual).reshape(-1), np.asarray(pred).reshape(-1))):
        rows.append({"step": index, "kind": kind, "actual": float(left), "predicted": float(right), "split": "holdout"})
    for value in np.asarray(future).reshape(-1):
        rows.append({"step": len(rows), "kind": kind, "actual": "", "predicted": float(value), "split": "forecast"})
    pd.DataFrame(rows).to_csv(path, index=False, encoding="utf-8")


def write_dispatch_profile(path: Path, kind: str, future: np.ndarray) -> Path:
    arr = np.asarray(future, dtype=float).reshape(-1)
    peak = max(float(np.nanmax(np.abs(arr))), 1e-6)
    pu = np.clip(arr / peak, 0.0, 1.2)
    key = {"pv": "pv_pu", "wind": "wt_pu", "load": "load_pu", "energy": "load_pu"}[kind]
    rows = []
    for hour, value in enumerate(pu):
        row = {"hour": hour, "load_pu": 1.0, "pv_pu": 0.0, "wt_pu": 0.0}
        row[key] = round(float(value), 6)
        if kind == "energy":
            row["load_pu"] = round(float(value), 6)
        rows.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_csv(path, index=False, encoding="utf-8")
    return path


def write_chart(path: Path, actual: np.ndarray, pred: np.ndarray, future: np.ndarray, title: str) -> Path | None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    actual = np.asarray(actual, dtype=float).reshape(-1)
    pred = np.asarray(pred, dtype=float).reshape(-1)
    future = np.asarray(future, dtype=float).reshape(-1)
    fig, ax = plt.subplots(figsize=(10, 4))
    if len(actual):
        ax.plot(range(len(actual)), actual, label="holdout actual")
        ax.plot(range(len(pred)), pred[: len(actual)], label="holdout pred")
    if len(future):
        start = len(actual)
        ax.plot(range(start, start + len(future)), future, label="forecast")
    ax.set_title(title)
    ax.set_xlabel("step")
    ax.set_ylabel("value")
    ax.legend()
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)
    return path


def gramian_angular_field(rows: np.ndarray) -> np.ndarray:
    """Per-row GAF image (n, f, f, 1) without pyts."""
    x = np.asarray(rows, dtype=float)
    lo = np.nanmin(x, axis=1, keepdims=True)
    hi = np.nanmax(x, axis=1, keepdims=True)
    scaled = np.clip(2 * (x - lo) / np.clip(hi - lo, 1e-6, None) - 1, -1, 1)
    phi = np.arccos(scaled)
    images = np.cos(phi[:, :, None] + phi[:, None, :])
    return images.reshape(images.shape[0], images.shape[1], images.shape[2], 1)


def feature_index(columns: list[str], name: str) -> int | None:
    key = _norm(name)
    for index, col in enumerate(columns):
        if _norm(col) == key:
            return index
    return None


def save_payload(output_dir: Path, payload: dict[str, Any]) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "metrics.json").write_text(
        json.dumps(payload.get("metrics") or {}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return payload
