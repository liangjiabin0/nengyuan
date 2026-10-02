---
name: pv-wind-load-forecast
description: Forecast photovoltaic, wind, load, or energy time series with auditable paper-compatible, adapted, or fallback implementations and emit a per-unit profile that can be fed back into dispatch. Use when the user asks for 光伏/风电/负荷/电量预测, MAE/RMSE, 回灌调度, or a 24-hour source-load curve.
---

# 源荷预测

## 触发

- 光伏、风电、负荷或电量曲线预测
- 需要 MAE/RMSE/MAPE 或可回灌调度的标幺曲线
- 负荷多特征 V1–V5、风电 GAF-CNN、德州 ERCOT 电量

## 不要用

- 交流/直流最优潮流、机组组合、线损、Modelica 动态仿真（那些走各自引擎；预测曲线可以回灌调度）

## 运行

```bash
python -m forecast_agent predict --kind pv --model lstm --output-dir <dir> --horizon 24 --epochs 3
python -m forecast_agent predict --kind load --model lstm --variant v4 --horizon 24 --epochs 3
python -m forecast_agent predict --kind wind --model cnn --horizon 24 --epochs 3
python -m forecast_agent predict --kind energy --model lstm --horizon 24 --epochs 3
```

论文复现工作区必须先读 `experiment/runtime-budget.json`，把 `--epochs` / `--window` / `--horizon` 压到本机 5 分钟预算内，不要按论文完整 epoch 长训。

`kind`：`pv` / `wind` / `load` / `energy`  
`model`：`lstm` / `gru` / `cnn` / `svr`  
`variant`（仅负荷）：`v1` 上一时刻全特征 → `v2` 上一时刻功率+此刻天气 → `v3` 多步窗口 → `v4` 季节拆分 → `v5` 季节+日/周/月周期

## 实现

- 光伏：PVDAQ 多特征 LSTM（温度/逆变器/组件/辐照/湿度/风向风速 + 小时月）
- 风电：有功+风速及相关特征；LSTM/GRU 为论文 2×64+BN+Dropout；CNN 为 GAF+Conv2D；优先加载 `weights/best_*.hdf5`
- 负荷：`power` 列（不是最后一列）；温度/湿度/风速全部进入模型
- 电量：ERCOT + FST 天气，Conv1D + 双向 LSTM/GRU + SimpleRNN
- 没有 Keras 时深度模型回退 Ridge/SVR，禁止写成已跑通 LSTM
- 只有结果中的 `fidelity=paper-compatible` 才能称论文兼容复现；`adapted` 是本地适配实验，`fallback` 是回退基线
- `weightStatus=trained` 表示现场训练，不得写成加载了论文预训练权重

## 回灌

输出 `dispatch-profile.csv`（`hour,load_pu,pv_pu,wt_pu`）。方案求解里后续调度任务会自动引用会话级 `forecast-profile.csv`。
