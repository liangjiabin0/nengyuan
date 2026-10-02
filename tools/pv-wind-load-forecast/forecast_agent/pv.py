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
    sklearn_multivariate,
    split_index,
    validation_fraction,
    window_xy,
)

PAPER_FEATURES = [
    "ambient_temp",
    "inverter_temp",
    "module_temp",
    "poa_irradiance",
    "relative_humidity",
    "wind_direction",
    "wind_speed",
]


def _frame(kind: str, data_path: Path | None, target_column: str | None = None, feature_columns: list[str] | None = None) -> tuple[np.ndarray, list[str], pd.DatetimeIndex | None]:
    df = read_table(kind, data_path)
    target = target_column if target_column in df.columns else resolve_target_column(df, "pv")
    features = [col for col in (feature_columns or []) if col in df.columns and col != target]
    if not features:
        features = pick_columns(df, PAPER_FEATURES)
    if not features:
        features = extra_feature_columns(df, target)
    index = parse_time_index(df)
    work = pd.DataFrame({target: pd.to_numeric(df[target], errors="coerce")})
    for col in features:
        work[col] = pd.to_numeric(df[col], errors="coerce")
    work = add_calendar(work, index)
    work[target] = work[target].clip(lower=0)
    work = work.dropna()
    cols = [target] + [col for col in work.columns if col != target]
    return work[cols].to_numpy(dtype=float), cols, index


def _build_model(window: int, n_features: int, steps_out: int):
    from keras.layers import Dense, Input, LSTM
    from keras.models import Sequential

    model = Sequential()
    model.add(Input((window, n_features)))
    model.add(LSTM(300, activation="relu", return_sequences=True))
    model.add(LSTM(200, activation="relu"))
    model.add(Dense(steps_out))
    model.compile(optimizer="adam", loss="mse")
    return model


def run(kind: str, model_name: str, data_path: Path | None, horizon: int, action: str, output_dir: Path, epochs: int, target_column: str | None = None, feature_columns: list[str] | None = None, window_override: int | None = None, train_ratio: float | None = None, validation_ratio: float | None = None, test_ratio: float | None = None):
    values, columns, _index = _frame(kind, data_path, target_column, feature_columns)
    window = int(window_override or 24)
    steps_out = 6 if horizon >= 6 else max(1, horizon)
    if model_name == "svr" or not keras_ready():
        actual, holdout, used, future = sklearn_multivariate(values, horizon, window, model_name, test_ratio)
        return actual, holdout, used if model_name == "svr" else "ridge", future, None, columns, "pv-univariate-fallback", {
            "fidelity": "fallback", "weightStatus": "not-used", "scaler": "sklearn_pipeline",
            "warnings": ["未执行论文 LSTM，使用了统计学习回退模型。"], "inputShape": [window, values.shape[1]],
        }

    if len(values) > 6000:
        values = values[-6000:]
    x, y = window_xy(values, window, steps_out)
    if len(x) < 64:
        actual, holdout, used, future = sklearn_multivariate(values, horizon, window, model_name, test_ratio)
        return actual, holdout, used, future, None, columns, "pv-univariate-fallback", {
            "fidelity": "fallback", "weightStatus": "not-used", "scaler": "sklearn_pipeline",
            "warnings": ["有效样本不足，使用了统计学习回退模型。"], "inputShape": [window, values.shape[1]],
        }

    split = split_index(len(x), test_ratio, min(32, len(x) - 1))
    model = _build_model(window, values.shape[1], steps_out)
    weight = output_dir / "weights" / "best_pv_lstm.keras"
    cache = Path(__file__).resolve().parents[1] / "weights" / "pv" / "best_lstm.keras"
    loaded = None
    weight_status = "not-used"
    warnings: list[str] = []
    expected = (window, values.shape[1])
    if action == "predict":
        for candidate in (weight, cache):
            if candidate.is_file():
                try:
                    from keras.models import load_model

                    candidate_model = load_model(str(candidate), compile=False)
                    shape = tuple(getattr(candidate_model, "input_shape", (None, *expected))[1:] or expected)
                    if shape == expected:
                        model = candidate_model
                        loaded = candidate
                        weight_status = "loaded"
                        break
                except Exception:
                    loaded = None
    if loaded is None:
        model.fit(x[:split], y[:split], epochs=max(1, epochs), batch_size=32, verbose=0, validation_split=validation_fraction(validation_ratio, test_ratio))
        weight.parent.mkdir(parents=True, exist_ok=True)
        model.save(weight)
        cache.parent.mkdir(parents=True, exist_ok=True)
        try:
            cache.write_bytes(weight.read_bytes())
        except OSError:
            pass
        loaded = weight
        weight_status = "trained"
        if action == "predict":
            warnings.append("没有与当前输入契约匹配的预训练权重，已现场训练适配模型。")

    hold_x, hold_y = x[split:], y[split:]
    if len(hold_x):
        pred = model.predict(hold_x, verbose=0)
        actual = hold_y[:, 0]
        holdout = pred[:, 0]
    else:
        actual = np.asarray([])
        holdout = np.asarray([])

    hist = values[-window:]
    hour_idx = feature_index(columns, "hour")
    month_idx = feature_index(columns, "month")

    def predict_block(hist_block: np.ndarray) -> np.ndarray:
        return model.predict(hist_block.reshape(1, window, -1), verbose=0).reshape(-1)

    future: list[float] = []
    cursor = hist.copy()
    while len(future) < horizon:
        block = predict_block(cursor)
        for value in block:
            if len(future) >= horizon:
                break
            future.append(float(value))
            nxt = cursor[-1].copy()
            nxt[0] = float(value)
            if hour_idx is not None:
                nxt[hour_idx] = (nxt[hour_idx] + 1) % 24
            if month_idx is not None and hour_idx is not None and nxt[hour_idx] == 0:
                nxt[month_idx] = nxt[month_idx] % 12 + 1
            cursor = np.vstack([cursor[1:], nxt])
    return actual, holdout, "keras_pv_lstm", np.asarray(future), str(loaded), columns, "pvdaq-lstm-adaptation", {
        "fidelity": "adapted", "weightStatus": weight_status, "scaler": "none",
        "warnings": warnings + ["该实现复用了论文网络思路，但未验证与论文数据预处理和权重完全一致。"],
        "inputShape": [window, values.shape[1]],
    }
