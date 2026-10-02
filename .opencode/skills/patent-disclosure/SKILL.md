---
name: patent-disclosure
description: 适配层：加载成熟 invention-structuring 后写出 disclosure.json
compatibility: opencode
metadata:
  workflow: patent
  adapts: patent-aris-structure
---

# patent-disclosure（适配层）

1. 先加载 `patent-ref-principles`，再加载 `patent-aris-structure`（成熟 ARIS 流程）。  
2. 按成熟流程从 `SOURCE.md` / `META.json` / `ANSWERS.md` / `PRIOR_ART.json` 结构化发明。  
3. **必须**写入工作区 `disclosure.json`，字段：

```json
{
  "proposedTitle": "",
  "technicalField": "",
  "background": "",
  "technicalProblems": [],
  "inventiveConcept": "",
  "essentialFeatures": [{"id":"EF1","name":"","description":"","essential":true,"technicalEffect":"","anchors":["A1"]}],
  "optionalFeatures": [{"id":"OF1","name":"","description":"","essential":false,"technicalEffect":"","anchors":["A2"]}],
  "inputs": [],
  "outputs": [],
  "constraints": [],
  "technicalEffects": [],
  "embodiments": [],
  "figureSuggestions": [],
  "sourceAnchors": [{"id":"A1","quote":"","section":""}],
  "assumptions": [],
  "missingInformation": [{"severity":"P0","question":"","reason":""}]
}
```

本系统附加规则：

- **必须是严格 JSON**（`JSON.parse` 可过）：禁止反引号模板字符串；对象字段之间用 `,`，禁止在字段中途写 `},` 提前结束对象。  
- 仅提取明确记载事实；公知原理可进 assumptions，不进 missingInformation。  
- 字符串数组元素必须是字符串。  
- figureSuggestions 给 2–4 个附图建议。
