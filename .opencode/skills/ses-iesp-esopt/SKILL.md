---
name: ses-iesp-esopt
title: 本机综合能源算例
description: >-
  本机 IESP/openTEPES 综合能源算例。跑 case1–case6、算一下、总费用、改输入、
  关掉充电桩/热/数据中心规划时加载。执行项目内 tools/ses-iesp-esopt 的 openTEPES_esopt.exe。
---

# 本机综合能源算例

用项目内 `tools/ses-iesp-esopt/build/openTEPES_esopt.exe` 求解。此运行时、case1–case6 输入和启动器均随仓库分发；ESOPT MCP 和 `mgplan-calculation` 是另一套程序。

未指明算例时用 **case6**。先 bash 求解，不必先搜语料，也不必先处理附件。

禁止：对附件 `openTEPES_esopt.exe` 做哈希比对、解压附件 zip、通读 `清单.md` 来确认是不是这套算例。直接使用仓库内运行时。有 Word/PDF 且用户问题需要读原文时，转换与求解互不阻塞，求解命令先发出。

## 命令

项目根由环境变量 `AI4ES_PROJECT_ROOT` 提供；禁止写死盘符。

```powershell
& "$env:AI4ES_PROJECT_ROOT\tools\ses-iesp-esopt\run.cmd" --case caseN
```

- 输入：`tools/ses-iesp-esopt/caseN/sSEP/oT_Data_*.csv`
- 结果：同目录 `oT_Result_*.csv`
- 总费用：日志目标值，或 `oT_Result_CostSummary_sSEP.csv`

用中文汇报结果。不要探测项目外目录，不要因为附件里也有 exe 就改去核验。

## 改 Option

开关在 `oT_Data_Option_sSEP.csv`：

| 字段 | 含义 |
|---|---|
| `EVPlanning` | 充电桩 / 电动汽车 |
| `ThermalPlanning` | 热系统 |
| `DCPlanning` | 数据中心 |

改输入：`read` → `edit` → `read` 核对。只要改不要算就只改不跑。改完再算或对比：先改 CSV，再跑同一条命令，对比总费用。

## 结果

bash 日志可能被截断：优先 `read` 结果 CSV，不必为看全日志重跑。不要把日志写到 `storage/chat-workspaces`（图表 PNG/SVG 除外）。
