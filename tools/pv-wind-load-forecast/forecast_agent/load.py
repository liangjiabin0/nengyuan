from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from .common import (
    add_calendar,
    extra_feature_columns,
    feature_index,
    keras_ready,
    parse_time_index,
    pick_columns,
    read_table,
    recursive_forecast,
    resolve_target_column,
    season_mask,
    sklearn_multivariate,
    split_index,
    validation_fraction,
    window_xy,
)

LOAD_FEATURES = ["temperature", "humidity", "speed", "temp", "wind_speed"]


def _base_frame(data_path: Path | None, target_column: str | None = None, feature_columns: list[str] | None = None) -> tuple[pd.DataFrame, str, pd.DatetimeIndex | None]:
    df = read_table("load", data_path)
    target = target_column if target_column in df.columns else resolve_target_column(df, "load")
    features = [col for col in (feature_columns or []) if col in df.columns and col != target]
    if not features:
        features = pick_columns(df, LOAD_FEATURES) or extra_feature_columns(df, target)
    index = parse_time_index(df)
    work = pd.DataFrame({target: pd.to_numeric(df[target], errors="coerce")})
    for col in features:
        work[col] = pd.to_numeric(df[col], errors="coerce")
    work = work.dropna()
    if index is not None:
        index = index[work.index] if len(index) == len(df) else parse_time_index(work)
    return work, target, index


def _variant_matrix(work: pd.DataFrame, target: str, index: pd.DatetimeIndex | None, variant: str) -> tuple[np.ndarray, list[str], int]:
    """Return (values, columns, window). Target is always column 0."""
    cols = [target] + [col for col in work.columns if col != target]
    frame = work[cols].copy()
    window = 1
    if variant == "v5":
        frame = add_calendar(frame, index)
        window = 12
    elif variant == "v4":
        if index is not None and len(index) == len(frame):
            mask = season_mask(index, len(frame))
            frame = frame.loc[mask].reset_index(drop=True)
            if index is not None:
                index = index[mask]
        window = 12
    elif variant == "v3":
        window = 12
    elif variant == "v2":
        window = 1
    else:
        window = 1
    columns = list(frame.columns)
    return frame.to_numpy(dtype=float), columns, window


def _build_lstm(window: int, n_features: int):
    from keras.layers import Dense, LSTM
    from keras.models import Sequential

    model = Sequential()
    model.add(LSTM(64, input_shape=(window, n_features)))
    model.add(Dense(1))
    model.compile(loss="mae", optimizer="adam")
    return model


def run(
    kind: str,
    model_name: str,
    data_path: Path | None,
    horizon: int,
    action: str,
    output_dir: Path,
    epochs: int,
    variant: str,
    target_column: str | None = None,
    feature_columns: list[str] | None = None,
    window_override: int | None = None,
    train_ratio: float | None = None,
    validation_ratio: float | None = None,
    test_ratio: float | None = None,
):
    work, target, index = _base_frame(data_path, target_column, feature_columns)
    values, columns, window = _variant_matrix(work, target, index, variant)
    if window_override:
        window = max(1, int(window_override))
    paper = f"load-multifeature-{variant}-adaptation"
    adaptation_warning = f"{variant} 是本项目依据论文描述实现的适配协议，不代表已逐行执行论文原仓库。"

    if model_name == "svr" or not keras_ready():
        actual, holdout, used, future = sklearn_multivariate(values, horizon, max(window, 8), model_name, test_ratio)
        return actual, holdout, used, future, None, columns, paper, {
            "fidelity": "fallback", "weightStatus": "not-used", "scaler": "sklearn_pipeline",
            "warnings": [adaptation_warning, "未执行请求的深度模型，使用了统计学习后端。"],
            "inputShape": [max(window, 8), values.shape[1]],
        }

    if variant == "v2":
        # previous power + current weather → now power. For forecast, persist last weather.
        x, y = [], []
        for i in range(1, len(values)):
            row = np.concatenate(([values[i - 1, 0]], values[i, 1:]))
            x.append(row)
            y.append(values[i, 0])
        x = np.asarray(x)
        y = np.asarray(y)
        split = split_index(len(x), test_ratio, min(16, len(x) - 1))
        from sklearn.preprocessing import MinMaxScaler

        scaler = MinMaxScaler()
        xs = scaler.fit_transform(x)
        xr = xs.reshape((len(xs), 1, xs.shape[1]))
        model = _build_lstm(1, xs.shape[1])
        model.fit(xr[:split], y[:split], epochs=max(1, min(epochs, 12)), batch_size=72, verbose=0, shuffle=False, validation_split=validation_fraction(validation_ratio, test_ratio))
        pred = model.predict(xr[split:], verbose=0).reshape(-1)
        actual = y[split:]
        future = []
        last_power = values[-1, 0]
        weather = values[-1, 1:]
        for _ in range(horizon):
            row = np.concatenate(([last_power], weather)).reshape(1, -1)
            row = scaler.transform(row).reshape(1, 1, -1)
            last_power = float(model.predict(row, verbose=0).reshape(-1)[0])
            future.append(last_power)
        dest = output_dir / "weights" / f"best_load_{variant}.keras"
        dest.parent.mkdir(parents=True, exist_ok=True)
        model.save(dest)
        return actual, pred, f"keras_load_{variant}_lstm", np.asarray(future), str(dest), columns, paper, {
            "fidelity": "adapted", "weightStatus": "trained", "scaler": "feature_minmax",
            "warnings": [adaptation_warning, "未来天气未知，沿用最后一行天气特征。"],
            "inputShape": [1, xs.shape[1]],
        }

    x, y = window_xy(values, window, 1)
    y = y.reshape(-1)
    if len(x) < 32:
        actual, holdout, used, future = sklearn_multivariate(values, horizon, max(window, 8), model_name, test_ratio)
        return actual, holdout, used, future, None, columns, paper, {
            "fidelity": "fallback", "weightStatus": "not-used", "scaler": "sklearn_pipeline",
            "warnings": [adaptation_warning, "有效样本不足，使用了统计学习后端。"],
            "inputShape": [max(window, 8), values.shape[1]],
        }
    split = split_index(len(x), test_ratio, min(24, len(x) - 1))
    if model_name == "cnn":
        from keras.layers import Conv1D, Dense, Flatten
        from keras.models import Sequential

        model = Sequential([
            Conv1D(16, 3, activation="relu", input_shape=(window, values.shape[1])),
            Flatten(),
            Dense(1),
        ])
        model.compile(optimizer="adam", loss="mae")
        used = f"keras_load_{variant}_cnn"
    elif model_name == "gru":
        from keras.layers import Dense, GRU
        from keras.models import Sequential

        model = Sequential([GRU(64, input_shape=(window, values.shape[1])), Dense(1)])
        model.compile(optimizer="adam", loss="mae")
        used = f"keras_load_{variant}_gru"
    else:
        model = _build_lstm(window, values.shape[1])
        used = f"keras_load_{variant}_lstm"

    model.fit(x[:split], y[:split], epochs=max(1, min(epochs, 16)), batch_size=72, verbose=0, shuffle=False, validation_split=validation_fraction(validation_ratio, test_ratio))
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
    dest = output_dir / "weights" / f"best_load_{variant}_{model_name}.keras"
    dest.parent.mkdir(parents=True, exist_ok=True)
    model.save(dest)
    return actual, pred, used, future, str(dest), columns, paper, {
        "fidelity": "adapted", "weightStatus": "trained", "scaler": "none",
        "warnings": [adaptation_warning, "未来外生特征采用持续值和日历递推。"],
        "inputShape": [window, values.shape[1]],
    }
