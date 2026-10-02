---
name: patent-strategy
description: 按中国创造性三步法制定保护策略，写出 strategy.json
compatibility: opencode
metadata:
  workflow: patent
---

# patent-strategy

读取 `disclosure.json`、`PRIOR_ART.json`、`ANSWERS.md`。采用创造性“三步法”制定保护策略。

不得把候选摘要未记载内容当作已公开；不得宣称检索已证明新颖性。

写入 `strategy.json`：

```json
{
  "inventionTitle": "",
  "coreContribution": "",
  "objectiveTechnicalProblem": "",
  "distinguishingFeatures": ["区别特征一"],
  "nonObviousnessReasoning": ["非显而易见理由一"],
  "independentClaims": [{"type":"method","scope":"","essentialFeatureIds":["EF1"]}],
  "dependentClaimPlan": [{"parentType":"method","featureIds":["OF1"],"purpose":""}],
  "fallbackPositions": ["将特征A收窄为B写入从属权利要求"],
  "excludedMatter": ["不写入独立权的内容"]
}
```

规则：

- `type` 仅可取 `method` / `system` / `device` / `storage_medium`（存储介质勿写 `computer_storage_medium`），须符合单一总的发明构思。
- 至少规划：1 项方法独立权利要求 + 1 项系统（或装置）独立权利要求；宜含存储介质。
- `dependentClaimPlan` 应支撑最终 12–16 项权利要求（含多层回退）。
- `distinguishingFeatures`、`nonObviousnessReasoning`、`fallbackPositions`、`excludedMatter`、`essentialFeatureIds`、`featureIds` 必须是字符串数组，禁止对象元素。
- 必须吸收用户答复中的保护边界与排除事项。
- 现有技术仅有摘要时不得武断认定已公开；不确定的保护边界若影响独立权，应在澄清阶段提问而非硬写。
