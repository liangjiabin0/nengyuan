# 概念、文献和引用证据

## 概念前置

报告正文之前放一节概念与符号，按阅读顺序分三组：基础概念、方法概念、本文自定义概念。收录范围以理解本报告所需为准。

每个术语一行，字段：

```
term_id, 中文名, 英文全称, 缩写, 定义, 数学表达或单位, 本文作用, 来源键, 来源定位, definition_type
```

`definition_type` 取教材/标准定义、原论文定义、综合解释、本文定义之一。`来源定位` 写页码、式号或条款号。综合解释可引多个来源，逐个列出；本文定义标为 `本文定义` 并说明它与既有近似概念的差别。首次提出者的归属以查到的最早出处为准，并附该出处的检索记录。

符号在首次出现处说明含义、维度、单位与取值范围，并与 `models/*/formulation.md` 的符号表共用同一套记号。

这节的产出成形后用 `question` 工具提交一次，供人工改词、补出处、删多余条目。

## 文献证据

先固定检索范围并记录：数据库或本地语料、检索日期、检索式、纳入与排除规则、去重规则。

检索顺序：

1. 本地语料 `storage/knowledge-corpus/papers`（8814 篇），先按关键词 grep，再读命中的哈希 Markdown。
2. 专利查 `storage/knowledge-corpus/patents`，按公开号从 `patents/INDEX.jsonl` 定位。
3. 外部补充用 `openalex` skill 查论文、DOI、引用关系与开放获取全文。

围绕问题与方法检索，并纳入数值分析、应用数学、优化与统计方向的文献。期刊层级作为文献筛选的参考量；算法优劣的判断依据写在 `optimization.md` 的对照实验里。

每篇文献记录：研究对象、假设、数学模型、求解算法、数据与算例、主要发现、作者自述的局限、证据页码或式号、全文可得性。题录信息支撑身份、元数据和可核验的摘要内容；专利支撑技术方案的存在性，其性能表现另找实验或文献证据。

每条"现有不足"标注它的来源：取自某篇文献的作者自述局限，或取自若干文献的跨文献比较（同时写明比较成立的适用边界）。每条创新主张记录它的近邻方法和具体差异点。检索范围之外的领域，在结论里写明未覆盖。

## BibTeX 与人工校正

用 DOI 和规范化题名去重。元数据优先取出版社或 DOI 关联的官方来源，其次取可信索引，并保存来源 URL 与获取时间。抓取不到时把该字段标为 `missing`，连同条目清单用 `question` 工具一并提交订正。

保留三层文件：

- `evidence/bib/raw.bib` — 抓取到的原始条目，每条带来源 URL 与获取时间。
- `evidence/bib/normalized.bib` — 去重、字段规范化后的候选条目。
- `evidence/bib/overrides.yaml` — 人工修订层，每条记录条目键、字段、旧值、新值、依据、修改者、时间。

最终 `references.bib` 由 `normalized.bib` 叠加 `overrides.yaml` 生成。重新抓取时更新 `raw.bib` 和 `normalized.bib`，`overrides.yaml` 在生成时最后叠加，人工修订因此持续生效。

每条文献另记两个状态字段：`full_text_status`（`fulltext` / `abstract` / `metadata_only`）和 `metadata_status`（`official` / `index` / `manual` / `missing`）。算法细节、实验设置一类的引用以 `full_text_status = fulltext` 的条目为依据。年份分在线发表与卷期出版两列；预印本与正式版用同一条目键关联，计数时算一篇。

学术文献与本项目代码、实验附件在参考文献里分节列出。术语表、模型说明、实验记录和参考文献共用同一套引用键。

引文与正文的一致性用 `writing-source-grounded-research-reviews` skill 的 `scripts/check_citation_consistency.py` 检查，检查输出存入 `evidence/`。
