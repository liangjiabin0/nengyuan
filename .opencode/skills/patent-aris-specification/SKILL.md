---
name: patent-aris-specification
description: 成熟说明书撰写流程（源自 ARIS specification-writing，MIT）；输出 draft.json
license: MIT
compatibility: opencode
metadata:
  workflow: patent
  source: wanshuiyin/Auto-claude-code-research-in-sleep skills/specification-writing
---

# patent-aris-specification（成熟流程）

源自 ARIS `specification-writing`（MIT）。先加载 `patent-ref-principles` 与 `patent-ref-cn-format`。

工作区：`patents/{projectId}/opencode/`。读取 `claims.txt`、`disclosure.json`、`drawings-plan.json`、`PRIOR_ART.json`、`SOURCE.md`。

## 章节（CN 顺序）

1. 发明名称（简明，无宣传词）  
2. 技术领域  
3. 背景技术（具体缺陷，非文献综述）  
4. 发明内容：技术问题 / 技术方案 / 有益效果（对应独立权）  
5. 附图说明（图1–图3）  
6. 具体实施方式（通常 ≥2500 汉字；覆盖全部权要特征；定义公式变量；公式用 `$...$` / `$$...$$` LaTeX）  
7. 摘要（≤300 汉字）+ abstractFigure  

## ARIS 关键纪律

- 说明书服务权利要求支持与充分公开  
- 术语全文一致；禁止主观吹嘘与无来源实验成绩表充当保护依据  
- 发明内容偏概述；详推与方程进具体实施方式  

## 输出

完整 `draft.json`：title、abstract、abstractFigure、claims（填入 claims.txt 全文）、technicalField、backgroundArt、inventionSummary、drawingDescription、embodiments。

完成后做「权要特征 ↔ 说明书」支持核对表（可写入 audit 前自检）。
