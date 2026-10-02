---
name: patent-ref-cn-format
description: CNIPA 中国发明专利格式与撰写要点参考（源自 ARIS patent-format-cn，MIT）
license: MIT
compatibility: opencode
metadata:
  workflow: patent
  source: wanshuiyin/Auto-claude-code-research-in-sleep shared-references/patent-format-cn.md
---

# CNIPA 专利格式指南（参考）

适用中国发明专利申请（CNIPA）。完整规则来自 ARIS `patent-format-cn`（MIT）。

## 法律依据

- 《专利法》（2020 修正）、《专利法实施细则》、《专利审查指南》

## 权利要求书

- 两部式：前序 +「其特征在于」+ 特征部分
- 从属项：「根据权利要求X所述的…，其特征在于…」
- 编号连续 1,2,3…；独立项与从属项交错编号，禁止跳号分组
- 方法：「一种…的方法，其特征在于，包括以下步骤：」
- 系统/装置：「一种…的系统/装置，其特征在于，包括：」
- 禁止把实验结果、信号现象当作权利要求技术特征

## 说明书顺序

发明名称 → 技术领域 → 背景技术 → 发明内容（技术问题/技术方案/有益效果）→ 附图说明 → 具体实施方式

## 摘要

- ≤300 汉字；客观描述；指定摘要附图（图1 等）

## 关键语纪律

- 首次「一种/一个」，后文「所述」
- 发明内容偏概述；公式与详推写入具体实施方式
- 有益效果宜由结构/步骤推导，避免无来源数值吹嘘

加载本 skill 后，结合工作区 `SOURCE.md` / `claims.txt` / `draft.json` 执行，不得编造对比文件编号。
