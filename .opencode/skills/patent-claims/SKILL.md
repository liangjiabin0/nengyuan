---
name: patent-claims
description: 适配层：加载成熟 claims-drafting 后写出 claims.txt
compatibility: opencode
metadata:
  workflow: patent
  adapts: patent-aris-claims
---

# patent-claims（适配层）

1. 加载 `patent-ref-cn-format`、`patent-ref-principles`、`patent-aris-claims`。  
2. 读取 `disclosure.json`、`strategy.json`、`PRIOR_ART.json`、`ANSWERS.md`。  
3. 按成熟流程撰写后，写入纯文本 `claims.txt`（无 Markdown）。

本系统硬门槛：12–16 项；方法独立权 + 系统/介质独立权；**必须用阿拉伯数字连续编号**（`1.` `2.` …）；每项一句号；多层回退；不编造特征。
禁止只写“权利要求1”或不编号正文——系统按 `1.`/`2.` 识别权项。

若权利要求含数学关系，用行内 LaTeX（如 `$P_{i,t}\\le P^{max}$`），禁止纯 Unicode 伪公式。
