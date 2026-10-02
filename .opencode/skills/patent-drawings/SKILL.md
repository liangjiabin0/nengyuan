---
name: patent-drawings
description: 制定恰好 3 幅短标签说明书附图计划，写出 drawings-plan.json
compatibility: opencode
metadata:
  workflow: patent
---

# patent-drawings

读取 `disclosure.json`、`strategy.json`、`claims.txt`。

必须制定恰好 3 幅黑白线稿计划：图1 方法流程图、图2 系统结构图、图3 数据流图。

写入 `drawings-plan.json`：

```json
{
  "diagrams": [
    {
      "figureNumber": 1,
      "title": "图1 方法流程图",
      "kind": "flowchart",
      "nodes": [{"id":"N1","label":"开始","ref":"101"}],
      "edges": [{"from":"N1","to":"N2","label":""}],
      "notes": []
    }
  ]
}
```

硬性规则（违反会导致渲染失败）：

- `title` 简短：`图1 方法流程图` / `图2 系统结构图` / `图3 数据流图`，不要把发明名称塞进标题。
- **每个节点 `label` 最多 8 个汉字**（可含数字/英文缩写，总显示宽度按 ≤8 汉字控制）。
- 用短词：如「负载分类」「光纤建模」「热阻热容」「优化求解」「调度中心」。
- 禁止长句、禁止省略号「…」、禁止「模块/单元」堆砌成长串。
- 每图节点 4–7 个；`kind` 依次 `flowchart`、`block`、`structure`。
- `ref` 用三位数字：图1 从 101，图2 从 201，图3 从 301。
- 不得编造源交底没有的新模块；可用上位短名。
- `notes` 必须是字符串数组。
