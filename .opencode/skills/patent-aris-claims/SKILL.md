---
name: patent-aris-claims
description: 成熟权利要求撰写流程（源自 ARIS claims-drafting，MIT）；输出 claims.txt
license: MIT
compatibility: opencode
metadata:
  workflow: patent
  source: wanshuiyin/Auto-claude-code-research-in-sleep skills/claims-drafting
---

# patent-aris-claims（成熟流程）

源自 ARIS `claims-drafting`（MIT）。先加载 `patent-ref-principles` 与 `patent-ref-cn-format`。

工作区：`patents/{projectId}/opencode/`。读取 `disclosure.json`、`strategy.json`、`PRIOR_ART.json`、`ANSWERS.md`。

## 常量（本系统）

- 管辖：CN（CNIPA），发明专利  
- 独立权至少 2 项（方法 + 系统/装置）；总项 **12–16**（高质量目标）  
- 修订轮：最多 3 轮自检（无外部 Codex 时用本模型扮演审查员）

## 流程（ARIS）

1. 确定两部式中文写法（其特征在于）  
2. 先写独立权：方法最宽可辩护范围；系统权与方法步骤对应  
3. 再写从属权：参数/实施例/替代实现，形成多层回退  
4. 连续编号，独立与从属交错；每项一个句号  
5. 自检：清楚性、支持、相对现有技术区别、禁止结果限定与实验数据入权  

## 输出

纯文本 `claims.txt`（无 Markdown 标题）。禁止编造源交底没有的技术特征。

无 Codex MCP：跳过跨模型审查，在自检清单中注明「本地审查员角色已完成」。
