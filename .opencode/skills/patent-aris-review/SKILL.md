---
name: patent-aris-review
description: 成熟审查员视角多轮审校（源自 ARIS patent-review，MIT）；输出 audit.json
license: MIT
compatibility: opencode
metadata:
  workflow: patent
  source: wanshuiyin/Auto-claude-code-research-in-sleep skills/patent-review
---

# patent-aris-review（成熟流程）

源自 ARIS `patent-review`（MIT）。本环境无 Codex MCP 时，用**同一模型扮演 CNIPA 审查员**完成多角度审查（不得跳过实质判断）。

若存在 `QUALITY_REPORT.json`，以其 `angle` 为本轮重点。

工作区：`patents/{projectId}/opencode/`。读取 claims/draft/disclosure/strategy/PRIOR_ART/SOURCE。

## 审查维度（ARIS office action）

1. **清楚性**（指南：清楚完整）  
2. **说明书支持**  
3. **充分公开 / 可实施**  
4. **新颖性风险**（仅基于 PRIOR_ART 已给材料，不得编造对比文件）  
5. **创造性风险**（区别特征与非显而易见性）  
6. **保护范围**（过宽/过窄/回退是否有效）  
7. **说明书与附图质量**  

## 闭环

- CRITICAL/MAJOR：立即修订 `draft.json` / `claims.txt`  
- 依赖用户确认的事项写入 `remainingRisks`，不伪造  
- 写 `audit.json`；若任务要求另写 `audit-round-N.json`  
- 给出可解释的问题列表（含 location / suggestion）  

禁止只做“章节是否存在”的结构打勾。
