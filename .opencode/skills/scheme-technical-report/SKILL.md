---
name: scheme-technical-report
description: 方案求解技术报告结构。数字必须来自 result.json。
---

# 技术报告

把完整中文报告写入 `REPORT.md`，章节固定：

1. 问题陈述
2. 决策变量
3. 约束条件
4. 目标函数
5. 算例或数据来源
6. 求解状态（必须写 `termination_status`）
7. 结果解读（目标值与关键变量，全部来自 `result.json`）
8. 局限与下一步
9. 附录：校核记录（摘录 `review-small.md` 与 `review-large.md`）

禁止编造未出现在 `result.json` 中的数字。不要写过程话、工具路径或模型真名。
