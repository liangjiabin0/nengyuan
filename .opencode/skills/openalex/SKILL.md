---
name: openalex
title: OpenAlex 学术检索
description: 用系统 OpenAlex API key 查询全球学术图谱：论文、作者、机构、期刊、主题、基金、奖项、出版商、引用网络、开放获取与缓存全文。用户提到 OpenAlex、DOI、ORCID、ROR、ISSN、PMID、文献计量、引用数、开放获取、基金资助、期刊或外部论文检索时使用。
---

# OpenAlex 学术检索

用本技能访问 OpenAlex（`https://api.openalex.org`）。本地 `knowledge-corpus/papers` 仍须先检索；本技能补外部图谱、引用、机构产出、基金与 OA/PDF。不要编造 DOI、引用数、作者归属或期刊影响因子。

免费档 key 约 $1/天 ≈ 10000 credits。key 从环境变量 `OPENALEX_API_KEY` 读取（写在 .env.local，不入库）。鉴权用 `Authorization: Bearer`，不要把 key 写进 URL。

## 何时加载

出现下面任一情况就 `skill` 加载 `openalex` 并跑脚本：

- 查外部论文、综述、作者、机构、期刊、主题、基金、奖项
- 用户给出 DOI / ORCID / ROR / ISSN / PMID / OpenAlex ID
- 要引用数、FWCI、OA 状态、被引文献、参考文献、相关论文
- 要按单位/基金/期刊做文献计量或抽样

不要用本技能：只问本地语料是否收录、导师网页档案、专利撰写、编造“影响因子/分区”。

## 调用方式

skill 加载后，脚本在技能目录 `scripts/openalex.mjs`。工作区不在仓库根时，用技能路径或仓库内 `tools/openalex/scripts/openalex.mjs`。

```bash
node tools/openalex/scripts/openalex.mjs usage
node tools/openalex/scripts/openalex.mjs get works doi:10.7717/peerj.4375
node tools/openalex/scripts/openalex.mjs resolve authors "Heather Piwowar"
node tools/openalex/scripts/openalex.mjs search works "virtual power plant" --per-page 10 --sort cited_by_count:desc --select id,display_name,publication_year,cited_by_count,doi
node tools/openalex/scripts/openalex.mjs list works --filter "authorships.institutions.id:I99065089,publication_year:2024,type:article" --sort cited_by_count:desc --per-page 10
node tools/openalex/scripts/openalex.mjs oql "works where year >= (2023) and open access is (true)" --per-page 5
```

完整命令与字段见 [reference.md](reference.md)。能源领域现成 ID 见 [examples.md](examples.md)。

## 硬性规则

1. **先消歧再过滤。** 禁止 `filter=author_name:张三`。先 `resolve`/`autocomplete`/`search` 拿到 `A…`/`I…`/`S…`/`T…`/`F…`，再 `filter=authorships.author.id:A…`。
2. **单条 ID/DOI/ORCID/ROR/ISSN/PMID 用 `get`，免费。** 列表+filter 约 $0.0001；`search` / `semantic` 约 $0.001；PDF/XML 约 $0.01。先 `usage` 看剩余额度。
3. **`per_page=100`，`select` 只要用到的字段。** OR 值最多 100 个。基本翻页 `page × per_page ≤ 10000`，更深用 `--cursor *`。
4. **默认语料是 core（约 3.2 亿 works）。** 要含扩张库加 `--corpus all`。不要用已弃用的 `include_xpac`。
5. **禁止** `GET /text`（已弃用，实测 500 且一次 100 credits）。禁止 `from_updated_date` / `from_created_date`（本 key 返回 429 Plan upgrade required）。`/works/{id}/ngrams` 现会落到作品本体，不要当 n-gram 用。
6. **下载 PDF 前**先 `filter=has_content.pdf:true` 或看 `content_urls`；每次加 `--yes --out`。版权仍属原文，只下载用户明确要的少量文件。
7. **摘要**在 `abstract_inverted_index`，用 `abstract` 命令还原，不要假设有明文 `abstract` 字段。
8. **纠错/收藏写入**（`collections create`、`curate`）必须用户明确要求。
9. 回答里给出 OpenAlex ID、DOI、年份、被引、OA；网页引用用 `https://openalex.org/W…` 或 DOI URL。

## 查询选型

| 需求 | 命令 |
| --- | --- |
| 已知 DOI/PMID | `get works doi:…` / `pmid:…` |
| 已知作者 ORCID | `get authors https://orcid.org/…` |
| 名称找 ID | `resolve authors\|institutions\|sources\|topics\|funders "…"` |
| 关键词 | `search works "…"`（可 Boolean、引号短语） |
| 段落/基金摘要找同类 | `semantic "…"`（最多 50 条，1 次/秒） |
| 精确集合、嵌套布尔 | `oql "works where …"` 或 `oqo` |
| 引用该文的文献 | `cites W…` |
| 该文参考文献 | `cited-by W…` |
| 相关论文 | `related W…` |
| 计数/构成 | `group works --filter … --group-by type\|publication_year\|topics.id` |

OQL 走 API 根路径 `/?oql=`，不要写成 `/works?oql=`。复杂语句先 `validate` 或 `translate oql …`。

## 常用 filter（works）

```
publication_year:2020-2024
type:article
is_oa:true
open_access.oa_status:gold|hybrid|green|diamond|bronze|closed
authorships.author.id:A…
authorships.institutions.id:I…
primary_location.source.id:S…
topics.id:T…
funders.id:F…
awards.funder_id:F4320321001
has_abstract:true
has_content.pdf:true
cited_by_count:>50
fwci:>2
is_retracted:false
language:en|zh
cites:W…
related_to:W…
```

AND 用逗号，OR 用 `|`，否定用 `!`，比较用 `>` `<`。别名 `author.id`、`institutions.id`、`is_oa` 可用。主题用 Topics，不要用已弃用 Concepts 做新分析。`host_venue`/`grants` 已删除，改用 `primary_location`、`funders`、`awards`。

## 失败时

- `429`：脚本已退避重试；仍失败则读 `usage`，说明今日额度。
- `400`：多半是用名称当 filter。改成先 resolve ID。
- 单条 `301`：实体已合并，跟随重定向即可。
- 本地语料已有全文时，不要为同一篇再花 $0.01 下 PDF。
