from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from .common import (
    ENERGY_DIR,
    add_calendar,
    extra_feature_columns,
    feature_index,
    keras_ready,
    parse_time_index,
    read_table,
    recursive_forecast,
    resolve_target_column,
    sklearn_multivariate,
    split_index,
    validation_fraction,
    window_xy,
)


def _merge_weather(demand: pd.DataFrame) -> pd.DataFrame:
    weather_path = ENERGY_DIR / "FST.csv"
    if not weather_path.is_file():
        return demand
    try:
        weather = pd.read_csv(weather_path, usecols=lambda name: name in {"valid", "tmpf", "relh", "sknt"})
    except Exception:
        return demand
    weather["valid"] = pd.to_datetime(weather["valid"], errors="coerce")
    weather = weather.dropna(subset=["valid"])
    weather["hour"] = weather["valid"].dt.floor("h")
    for col in ("tmpf", "relh", "sknt"):
        weather[col] = pd.to_numeric(weather[col], errors="coerce")
    hourly = weather.groupby("hour")[["tmpf", "relh", "sknt"]].mean()
    if "Date" in demand.columns and "HE" in demand.columns:
        stamp = pd.to_datetime(demand["Date"], errors="coerce") + pd.to_timedelta(
            pd.to_numeric(demand["HE"], errors="coerce").fillna(1) - 1, unit="h"
        )
        demand = demand.copy()
        demand["_stamp"] = stamp
        merged = demand.join(hourly, on="_stamp")
        return merged.drop(columns=["_stamp"], errors="ignore")
    return demand


def _frame(data_path: Path | None, target_column: str | None = None, feature_columns: list[str] | None = None) -> tuple[np.ndarray, list[str]]:
    df = read_table("energy", data_path)
    if data_path is None or Path(data_path).name.startswith("Ercot"):
        df = _merge_weather(df)
    target = target_column if target_column in df.columns else resolve_target_column(df, "energy")
    index = parse_time_index(df)
    if index is None and "Date" in df.columns and "HE" in df.columns:
        index = pd.DatetimeIndex(
            pd.to_datetime(df["Date"], errors="coerce")
            + pd.to_timedelta(pd.to_numeric(df["HE"], errors="coerce").fillna(1) - 1, unit="h")
        )
    extras = [col for col in (feature_columns or []) if col in df.columns and col != target]
    if not extras:
        extras = extra_feature_columns(df, target)
    work = pd.DataFrame({target: pd.to_numeric(df[target], errors="coerce")})
    for col in extras:
        work[col] = pd.to_numeric(df[col], errors="coerce")
    work = add_calendar(work, index)
    work = work.dropna()
    cols = [target] + [col for col in work.columns if col != target]
    return work[cols].to_numpy(dtype=float), cols


def _texas_model(window: int, n_features: int):
    from keras.layers import (
        GRU,
        LSTM,
        Bidirectional,
        Conv1D,
        Dense,
        Dropout,
        MaxPooling1D,
        SimpleRNN,
    )
    from keras.models import Sequential

    model = Sequential()
    model.add(Conv1D(filters=20, kernel_size=2, input_shape=(window, n_features)))
    model.add(MaxPooling1D(2))
    model.add(Conv1D(filters=10, kernel_size=2))
    model.add(MaxPooling1D(2))
    model.add(Bidirectional(LSTM(100, activation="relu", recurrent_dropout=0.2, return_sequences=True)))
    model.add(Bidirectional(GRU(75, activation="relu", recurrent_dropout=0.2, return_sequences=True)))
    model.add(SimpleRNN(50, activation="relu", recurrent_dropout=0.2))
    model.add(Dense(40, activation="relu"))
    model.add(Dense(30, activation="relu"))
    model.add(Dense(20, activation="relu"))
    model.add(Dense(10, activation="relu"))
    model.add(Dropout(0.1))
    model.add(Dense(1, activation="linear"))
    model.compile(optimizer="adam", loss="mae")
    return model


def run(kind: str, model_name: str, data_path: Path | None, horizon: int, action: str, output_dir: Path, epochs: int, target_column: str | None = None, feature_columns: list[str] | None = None, window_override: int | None = None, train_ratio: float | None = None, validation_ratio: float | None = None, test_ratio: float | None = None):
    values, columns = _frame(data_path, target_column, feature_columns)
    window = int(window_override or 30)
    if len(values) > 10_000:
        values = values[-10_000:]
    if model_name == "svr" or not keras_ready():
        actual, holdout, used, future = sklearn_multivariate(values, horizon, window, model_name, test_ratio)
        return actual, holdout, used, future, None, columns, "energy-sklearn", {
            "fidelity": "fallback", "weightStatus": "not-used", "scaler": "sklearn_pipeline",
            "warnings": ["未执行 ERCOT 深度网络，使用了统计学习后端。"], "inputShape": [window, values.shape[1]],
        }

    x, y = window_xy(values, window, 1)
    y = y.reshape(-1)
    if len(x) < 64:
        actual, holdout, used, future = sklearn_multivariate(values, horizon, window, model_name, test_ratio)
        return actual, holdout, used, future, None, columns, "energy-sklearn", {
            "fidelity": "fallback", "weightStatus": "not-used", "scaler": "sklearn_pipeline",
            "warnings": ["有效样本不足，使用了统计学习后端。"], "inputShape": [window, values.shape[1]],
        }
    split = split_index(len(x), test_ratio, min(32, len(x) - 1))
    model = _texas_model(window, values.shape[1])
    cache = Path(__file__).resolve().parents[1] / "weights" / "energy" / "best_texas.keras"
    dest = output_dir / "weights" / "best_texas.keras"
    loaded = None
    weight_status = "not-used"
    warnings: list[str] = []
    if action == "predict" and cache.is_file():
        try:
            from keras.models import load_model

            model = load_model(str(cache), compile=False)
            loaded = cache
            weight_status = "loaded"
        except Exception:
            loaded = None
    if loaded is None:
        model.fit(x[:split], y[:split], epochs=max(1, min(epochs, 6)), batch_size=32, verbose=0, validation_split=validation_fraction(validation_ratio, test_ratio))
        dest.parent.mkdir(parents=True, exist_ok=True)
        model.save(dest)
        cache.parent.mkdir(parents=True, exist_ok=True)
        try:
            cache.write_bytes(dest.read_bytes())
        except OSError:
            pass
        loaded = dest
        weight_status = "trained"
        if action == "predict":
            warnings.append("ERCOT 缓存权重无法加载，已现场训练适配模型。")

    pred = model.predict(x[split:], verbose=0).reshape(-1)
    actual = y[split:]

    def predict_one(hist: np.ndarray) -> float:
        return float(model.predict(hist.reshape(1, hist.shape[0], hist.shape[1]), verbose=0).reshape(-1)[0])

    future = recursive_forecast(
        predict_one,
        values[-window:],
        horizon,
        feature_index(columns, "hour"),
        feature_index(columns, "month"),
        feature_index(columns, "dow"),
    )
    return actual, pred, "keras_energy_texas", future, str(loaded), columns, "ercot-bidirectional-adaptation", {
        "fidelity": "adapted", "weightStatus": weight_status, "scaler": "none",
        "warnings": warnings + ["该实现复用了论文网络结构，但数据预处理和未来外生变量协议未与论文逐项校验。"],
        "inputShape": [window, values.shape[1]],
    }
