---
name: patent-aris-structure
description: 成熟发明结构化流程（源自 ARIS invention-structuring，MIT）；输出对接 disclosure.json
license: MIT
compatibility: opencode
metadata:
  workflow: patent
  source: wanshuiyin/Auto-claude-code-research-in-sleep skills/invention-structuring
---

# patent-aris-structure（成熟流程）

源自 ARIS `invention-structuring`（MIT）。先加载 `patent-ref-principles`。

工作区（相对 `storage/`）：`patents/{projectId}/opencode/`。

读取：`SOURCE.md`、`ANSWERS.md`、`PRIOR_ART.json`、`META.json`。

## 框架

1. **技术问题**：来自现有技术缺陷，须具体、技术性  
2. **技术方案**：机制而非结果；区分已知特征与发明特征  
3. **有益效果**：由发明特征导出  

## 三层分解

- **核心发明构思** → 独立权利要求范围  
- **支撑性特征** → 从属权利要求  
- **可选特征** → 实施例细节  

## 权利要求类型规划

至少规划：方法 + 系统/装置；宜含存储介质（发明）。

## 附图计划

图1 方法流程、图2 系统结构、图3 数据流/实施例（与本系统附图计划一致）。

## 输出（本系统契约）

写入同目录 `disclosure.json`（字段与 `patent-disclosure` 一致）：proposedTitle、technicalField、background、technicalProblems、inventiveConcept、essentialFeatures、optionalFeatures、inputs/outputs/constraints、technicalEffects、embodiments、figureSuggestions、sourceAnchors、assumptions、missingInformation。

规则：不得编造实验结果；身份缺口写入 missingInformation（P0）；字符串数组元素必须是字符串。
