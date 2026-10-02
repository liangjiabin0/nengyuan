---
name: chart-discovery
title: 主动生成数据图
description: 用户在输入框功能列表中选中「主动生成数据图」后使用。发现对话、附件、表格、CSV/Excel 和计算结果中可画图的数据，用本机脚本生成 PNG/SVG，并写入当前会话 charts 目录供系统收成附件。
---

# 主动生成数据图

本轮用户已经选中「主动生成数据图」。发现能画图的数据就画，不要等用户再说“画个图”。图必须写成文件，放到本轮图表目录；系统会收成附件。不要只丢 ASCII 图，也不要让用户自己去画。

若本轮提示没有写明已开启该功能，不要主动出图，也不要自行寻找出图脚本。

## 何时必须出图

出现下面任一情况就出图：

- 附件或检索结果里有 CSV / Excel / 多列表格，且至少有一列可量化
- 回答里要比较 3 个及以上数值（方案、年份、设备、场景）
- 有时序：负荷、出力、电价、成本、损耗、误差、残差
- 有占比或排名：构成、份额、Top-N
- 求解器 / 算例结果带序列或汇总指标

不要出图：只有 1–2 个孤立数字、纯概念解释、没有可核对数值。

## 输出位置（系统认这里为附件）

把成品图写到系统提示里给出的「图表输出目录」。那个目录已经建好，必须原样使用，禁止自己哈希/截断会话 ID，也禁止另建平行目录。

缺省形态：

```text
storage/chat-workspaces/<完整会话ID>/charts/<文件名>.png
```

先跑 `render_chart.py --out` 真正写出 PNG/SVG，再写 `manifest.json`。只有规格没有图，系统收不到附件。只写图，不写日志。文件名用英文短横线，例如 `load-curve.png`。单轮 1–4 张。

可选清单 `manifest.json`：

```json
[
  { "file": "load-curve.png", "title": "典型日负荷曲线" },
  { "file": "cost-compare.png", "title": "方案总成本对比" }
]
```

正文用标题点明每张图在说什么，不要写 `![](本地路径)`，系统会把图收成附件。

## 出图步骤

1. 抽出可画数据：时间/类别 + 至少一条数值系列。写不清来源的数不要画。
2. 选图：趋势用折线，对比用柱，占比用饼（类别 ≤ 8），相关用散点，排名用水平柱。
3. 用下面脚本出图，不要手写一套新的画图栈。
4. 确认目标目录里已经有对应 PNG/SVG，再写最终回答。

```bash
python tools/chart-discovery/scripts/render_chart.py --spec spec.json --out storage/chat-workspaces/<conversationId>/charts/load-curve.png
```

从 CSV 直接画：

```bash
python tools/chart-discovery/scripts/render_chart.py --csv data.csv --x 时间 --y 负荷,出力 --kind line --title 负荷与出力 --out storage/chat-workspaces/<conversationId>/charts/load-vs-gen.png
```

`spec.json` 最小字段：

```json
{
  "kind": "line",
  "title": "典型日负荷曲线",
  "xlabel": "时刻",
  "ylabel": "功率 / MW",
  "x": ["0:00", "4:00", "8:00", "12:00", "16:00", "20:00"],
  "series": [{ "name": "负荷", "y": [62, 55, 78, 91, 88, 80] }]
}
```

`kind` 取 `line` / `bar` / `hbar` / `pie` / `scatter`。

## 画风

- 中文标题、轴名、图例；单位写在轴名里
- 一张图一个观点，避免双轴堆很多系列
- 必须用上面的 `render_chart.py` 出图。它已经给标题留了上边距。不要手写 matplotlib 再用默认 `savefig(..., bbox_inches="tight")`：默认只留 0.1 英寸，中文标题会贴顶被裁切。若不得不手写，必须 `pad_inches=0.45`
- 数据来自附件或语料时，回答里保留可核验引用

## 失败时

脚本报缺 matplotlib：先 `python -m pip install matplotlib pandas`，再画。仍然失败就用表格给出同样的数，并写明出图失败原因。
