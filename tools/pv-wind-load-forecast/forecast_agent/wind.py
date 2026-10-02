from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from .common import (
    WIND_DIR,
    extra_feature_columns,
    gramian_angular_field,
    keras_ready,
    parse_time_index,
    pick_columns,
    read_table,
    resolve_target_column,
    sklearn_multivariate,
    split_index,
    validation_fraction,
)

DROP = {"gearboxoiltemperature", "generatorwinding1temperature", "rotorrpm", "nacelleposition"}
PAPER_FEATURES = [
    "WindSpeed",
    "WindDirection",
    "AmbientTemperatue",
    "BearingShaftTemperature",
    "Blade1PitchAngle",
    "Blade2PitchAngle",
    "Blade3PitchAngle",
    "ControlBoxTemperature",
    "GearboxBearingTemperature",
]


def _frame(data_path: Path | None, target_column: str | None = None, feature_columns: list[str] | None = None):
    df = read_table("wind", data_path)
    target = target_column if target_column in df.columns else resolve_target_column(df, "wind")
    numeric = df.select_dtypes(include=["number"]).copy()
    for col in numeric.columns:
        numeric[col] = pd.to_numeric(numeric[col], errors="coerce")
    if target not in numeric.columns:
        numeric[target] = pd.to_numeric(df[target], errors="coerce")
    exact = [col for col in PAPER_FEATURES if col in numeric.columns and col != target]
    requested = [col for col in (feature_columns or []) if col in numeric.columns and col != target]
    preferred = pick_columns(df, ["WindSpeed", "wind_speed", "WindDirection", "wind_direction"])
    candidates = exact if len(exact) == len(PAPER_FEATURES) else requested + preferred + extra_feature_columns(df, target) + list(numeric.columns)
    extras: list[str] = []
    for col in candidates:
        key = str(col).strip().lower().replace(" ", "")
        if col != target and col not in extras and key not in DROP:
            extras.append(col)
    extras = extras[:9]
    if not extras:
        raise ValueError("风电数据没有可用外生特征列。")
    work = numeric[[target, *extras]].replace([np.inf, -np.inf], np.nan).dropna()
    index = parse_time_index(df)
    if index is not None and len(index) == len(df):
        work.index = index[work.index]
        midpoint = work.index.min() + (work.index.max() - work.index.min()) / 2
        later = work.loc[work.index >= midpoint]
        if len(later) > 500:
            work = later
    columns = [target, *extras]
    return work[columns].to_numpy(dtype=float), columns, {
        "target": target,
        "features": extras,
        "rows": int(len(work)),
        "paperFeatureContract": extras == PAPER_FEATURES,
    }


def _lstm_or_gru(model_name: str, window: int, n_features: int):
    from keras.layers import GRU, LSTM, BatchNormalization, Dense, Dropout, Input
    from keras.models import Sequential

    cell = GRU if model_name == "gru" else LSTM
    model = Sequential([
        Input((window, n_features)),
        cell(64, return_sequences=True),
        BatchNormalization(),
        Dropout(0.4),
        cell(64, return_sequences=True),
        BatchNormalization(),
        Dropout(0.4),
        Dense(1),
    ])
    model.compile(optimizer="adam", loss="mae")
    return model


def _cnn(n_features: int):
    from keras.layers import BatchNormalization, Conv2D, Dense, Dropout, Flatten, Input, LeakyReLU
    from keras.models import Model

    inputs = Input(shape=(n_features, n_features, 1))
    x = inputs
    padding = "valid" if n_features >= 9 else "same"
    for depth in range(1, 4):
        x = Conv2D(32 * depth, (3, 3), activation=None, padding=padding)(x)
        x = LeakyReLU(negative_slope=0.2)(x)
        x = BatchNormalization()(x)
        x = Dropout(0.4)(x)
    x = Conv2D(128, (3, 3), activation=None, padding=padding)(x)
    x = LeakyReLU(negative_slope=0.2)(x)
    x = BatchNormalization()(x)
    x = Flatten()(x)
    x = Dropout(0.4)(x)
    outputs = Dense(1, activation="sigmoid")(x)
    model = Model(inputs, outputs)
    model.compile(optimizer="adam", loss="mae")
    return model


def _load_model_or_weights(model_name: str, path: Path, window: int, features: int):
    from keras.models import load_model

    errors: list[str] = []
    try:
        model = load_model(str(path), compile=False)
        shape = tuple(getattr(model, "input_shape", (None, window, features))[1:] or ())
        if shape == (window, features):
            return model, None
        errors.append(f"输入形状 {shape} != {(window, features)}")
    except Exception as exc:
        errors.append(f"完整模型加载失败：{exc}")
    try:
        model = _lstm_or_gru(model_name, window, features)
        model.load_weights(str(path))
        return model, None
    except Exception as exc:
        errors.append(f"权重加载失败：{exc}")
    return None, "; ".join(errors)


def _block_data(values: np.ndarray, window: int):
    blocks = len(values) // window
    if blocks < 3:
        raise ValueError(f"风电论文协议至少需要 3 个完整 {window} 步窗口，当前只有 {blocks} 个。")
    trimmed = values[: blocks * window]
    return trimmed[:, 1:].reshape(blocks, window, -1), trimmed[:, 0].reshape(blocks, window, 1)


def _audit(*, fidelity: str, weight_status: str, data: dict[str, object], scaler: str, warnings: list[str], input_shape: tuple[int, ...]):
    return {
        "fidelity": fidelity,
        "weightStatus": weight_status,
        "data": data,
        "scaler": scaler,
        "warnings": warnings,
        "inputShape": list(input_shape),
    }


def run(
    kind: str,
    model_name: str,
    data_path: Path | None,
    horizon: int,
    action: str,
    output_dir: Path,
    epochs: int,
    target_column: str | None = None,
    feature_columns: list[str] | None = None,
    window_override: int | None = None,
    train_ratio: float | None = None,
    validation_ratio: float | None = None,
    test_ratio: float | None = None,
):
    values, columns, data = _frame(data_path, target_column, feature_columns)
    window = int(window_override or (144 if len(values) >= 144 * 20 else 24))
    if len(values) > 8000:
        values = values[-8000:]
    warnings: list[str] = []
    paper_contract = bool(data["paperFeatureContract"] and window == 144)

    if model_name == "svr" or not keras_ready():
        actual, holdout, used, future = sklearn_multivariate(values, horizon, min(window, 24), "svr" if model_name == "svr" else "ridge", test_ratio)
        if model_name != "svr":
            warnings.append("Keras 不可用，已回退 Ridge；这不是论文深度模型。")
        return actual, holdout, used, future, None, columns, "wind-sklearn", _audit(
            fidelity="fallback", weight_status="not-used", data=data, scaler="none", warnings=warnings,
            input_shape=(min(window, 24), values.shape[1]),
        )

    if model_name == "cnn":
        extras = values[:, 1:]
        images = gramian_angular_field(extras)
        target = values[:, 0]
        lo, hi = float(np.min(target)), float(np.max(target))
        scale = max(hi - lo, 1e-6)
        y = np.clip((target - lo) / scale, 0, 1)
        split = split_index(len(images), test_ratio, min(32, len(images) - 1))
        model = _cnn(images.shape[1])
        source = WIND_DIR / "weights" / "best_cnn.hdf5"
        weight_status = "not-used"
        weight_error = ""
        loaded_path: Path | None = None
        if action == "predict" and source.is_file():
            try:
                from keras.models import load_model
                model = load_model(str(source), compile=False)
                loaded_path = source
                weight_status = "loaded"
            except Exception as exc:
                weight_error = str(exc)
        if loaded_path is None:
            model.fit(images[:split], y[:split], epochs=max(1, min(epochs, 8)), batch_size=32, verbose=0, validation_split=validation_fraction(validation_ratio, test_ratio))
            loaded_path = output_dir / "weights" / "best_cnn.keras"
            loaded_path.parent.mkdir(parents=True, exist_ok=True)
            model.save(loaded_path)
            weight_status = "trained"
            if weight_error:
                warnings.append(f"论文 CNN 权重无法加载，已训练适配模型：{weight_error}")
        pred = model.predict(images[split:], verbose=0).reshape(-1) * scale + lo
        actual = target[split:]
        future: list[float] = []
        for _ in range(horizon):
            img = gramian_angular_field(extras[-1:])
            future.append(float(model.predict(img, verbose=0).reshape(-1)[0]) * scale + lo)
        warnings.append("未来外生风况未知，预测阶段沿用最后一行外生变量；论文训练评估与未来预测不是同一协议。")
        fidelity = "paper-compatible" if weight_status == "loaded" and extras.shape[1] == 9 else "adapted"
        return actual, pred, "keras_wind_gaf_cnn", np.asarray(future), str(loaded_path), columns, "wind-gaf-cnn-paper", _audit(
            fidelity=fidelity, weight_status=weight_status, data=data, scaler="target_minmax", warnings=warnings,
            input_shape=tuple(images.shape[1:]),
        )

    from sklearn.preprocessing import MinMaxScaler

    scaler = MinMaxScaler()
    scaled = scaler.fit_transform(values)
    x, y = _block_data(scaled, window)
    split = split_index(len(x), test_ratio, 1)
    model = _lstm_or_gru(model_name, window, x.shape[2])
    source = WIND_DIR / "weights" / f"best_{model_name}.hdf5"
    loaded_path: Path | None = None
    weight_status = "not-used"
    weight_error = ""
    if action == "predict" and source.is_file() and paper_contract:
        model, weight_error = _load_model_or_weights(model_name, source, window, x.shape[2])
        if model is not None:
            loaded_path = source
            weight_status = "loaded"
    elif action == "predict" and source.is_file() and not paper_contract:
        warnings.append("数据未满足论文的 144×9 外生特征契约，未加载论文权重。")
    if model is None:
        model = _lstm_or_gru(model_name, window, x.shape[2])
    if loaded_path is None:
        model.fit(x[:split], y[:split], epochs=max(1, min(epochs, 12)), batch_size=8, verbose=0, validation_split=validation_fraction(validation_ratio, test_ratio))
        loaded_path = output_dir / "weights" / f"best_{model_name}.keras"
        loaded_path.parent.mkdir(parents=True, exist_ok=True)
        model.save(loaded_path)
        weight_status = "trained"
        if weight_error:
            warnings.append(f"论文权重加载失败，已训练适配模型：{weight_error}")

    pred_scaled = model.predict(x[split:], verbose=0).reshape(-1)
    actual_scaled = y[split:].reshape(-1)
    target_min = float(scaler.data_min_[0])
    target_scale = max(float(scaler.data_range_[0]), 1e-12)
    actual = actual_scaled * target_scale + target_min
    pred = pred_scaled * target_scale + target_min
    future_scaled = np.resize(model.predict(x[-1:], verbose=0).reshape(-1), max(1, horizon))[:horizon]
    future = future_scaled * target_scale + target_min
    warnings.append("未来外生风况未知，预测阶段复用最后一个窗口；该假设已写入审计结果。")
    fidelity = "paper-compatible" if weight_status == "loaded" and paper_contract else "adapted"
    return actual, pred, f"keras_wind_{model_name}", future, str(loaded_path), columns, "wind-kaggle-paper", _audit(
        fidelity=fidelity, weight_status=weight_status, data=data, scaler="all_columns_minmax", warnings=warnings,
        input_shape=(window, x.shape[2]),
    )
