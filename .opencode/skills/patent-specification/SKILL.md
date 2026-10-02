---
name: patent-specification
description: 适配层：加载成熟 specification-writing 后写出 draft.json
compatibility: opencode
metadata:
  workflow: patent
  adapts: patent-aris-specification
---

# patent-specification（适配层）

1. 加载 `patent-ref-cn-format`、`patent-ref-principles`、`patent-aris-specification`。  
2. 读取 `disclosure.json`、`strategy.json`、`claims.txt`、`drawings-plan.json`、`SOURCE.md`。  
3. 按成熟流程撰写后写入完整 `draft.json`：

title / abstract / abstractFigure / claims / technicalField / backgroundArt / inventionSummary / drawingDescription / embodiments

本系统硬门槛：摘要 ≤300 汉字；实施例通常 ≥2500 汉字；abstractFigure 一般为图1；claims 填入 claims.txt 全文。

**draft.json 必须是严格 JSON**（可用 `JSON.parse` 校验）：
- 禁止 JS 模板字符串反引号 `` `...` ``；长文本一律用 JSON 双引号字符串，换行写成 `\n`。
- `drawingDescription` 必须是**字符串**（可用换行列出“图1：…\\n图2：…”），禁止对象数组。
- `claims` / `embodiments` 同样必须是字符串字段。

**公式必须用 LaTeX，并用定界符包裹**（导出 Word 时转为原生公式，勿写纯文本伪公式）：
- 行内：`$E = mc^2$` 或 `\(E = mc^2\)`
- 独立成行：`$$P = \sum_{i=1}^{N} \\frac{\\lambda_i}{\\mu_i}$$` 或 `\\[ ... \\]`
- 变量首次出现时用中文定义，公式本身保持 LaTeX。
