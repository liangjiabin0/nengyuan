# 多能系统规划计算 skill

基于现有 openTEPES 程序整理的独立 skill，用于多能系统规划、源网荷储投资优化和运行模拟。

本 skill 不创建新的包装主函数，直接使用原始 `openTEPES_Main.py`。

## 环境要求

- Python 3
- Gurobi 及有效许可证/ISV 授权
- 目标设备通过原程序 MAC 白名单
- 建议内存不少于 8 GB

安装 Python 依赖：

```bash
pip install -r requirements.txt
```

## 运行

从 skill 根目录执行：

```bash
python scripts/openTEPES_Main.py
```

或使用现有虚拟环境：

```powershell
& "$env:AI4ES_PROJECT_ROOT\tools\mgplan-venv\Scripts\python.exe" `
  "$env:AI4ES_PROJECT_ROOT\tools\mgplan\scripts\openTEPES_Main.py"
```

原主函数固定使用：

```text
案例：    sSEP
求解器：  gurobi
日志：    Yes
```

虽然主函数声明了 `--case`、`--dir`、`--solver` 和 `--log`，但当前没有执行 `parse_args()`，这些命令行参数不会生效。

## 输入输出

因为 `DIR = os.path.dirname(__file__)`，输入与输出均位于：

```text
scripts/sSEP/
```

必需输入包括 Option、Parameter、Demand、ElectricityPrice、Generation、VariableMaxGeneration、NodeLocation、Network 和 LoadLevel CSV。

主要输出包括：

- `oT_Result_CostSummary_sSEP.csv`
- `oT_Result_GenerationInvestment_sSEP.csv`
- `oT_Result_GenerationOutput_sSEP.csv`
- `oT_Result_GenerationCommitment_sSEP.csv`
- `oT_Result_ESSChargeDischarge_sSEP.csv`
- `oT_Result_Evaluations_sSEP.csv`
- `oT_Result_EvaluationsEco_sSEP.csv`
- `oT_Result_NetworkPloss_sSEP.csv`
- `oT_Result_NetworkENS_sSEP.csv`
- `oT_Plot_MapNetwork_sSEP.html`

## 目录结构

```text
mgplan-calculation-skill/
├── SKILL.md
├── README.md
├── requirements.txt
├── 交付说明.md
├── scripts/
│   ├── openTEPES_Main.py
│   ├── openTEPES.py
│   ├── openTEPES_InputData.py
│   ├── openTEPES_ModelFormulation.py
│   ├── openTEPES_ProblemSolving.py
│   ├── openTEPES_OutputResults.py
│   ├── openTEPES.mapbox_token
│   ├── opt/
│   └── sSEP/
├── config/
│   └── calculation_config.py
├── assets/
│   └── templates/
│       └── case_file_manifest.json
├── test_data/
├── output/
│   ├── json_results/
│   └── charts/
├── lib/
└── references/
```

顶层目录与参考 skill 保持一致；原程序运行所需文件集中在 `scripts/`，以保证复制后的主函数无需修改即可执行。

## 注意事项

1. 不要删除或绕过 `scripts/openTEPES_Main.py` 的 MAC 校验。
2. `scripts/openTEPES.mapbox_token` 属于敏感配置，不应公开传播。
3. 默认 sSEP 包含完整年度时序，求解可能持续较长时间。
4. 程序会覆盖或更新 `scripts/sSEP/` 中同名结果，运行前建议备份。
5. 无图形界面的环境可能无法使用 Chrome renderer，但 CSV 结果可独立验收。

## 许可证

内部使用。Gurobi、Mapbox 及原 openTEPES 程序遵循其现有许可。
