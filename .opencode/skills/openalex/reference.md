# OpenAlex 接口备忘

官方索引：https://help.openalex.org/llms.txt  
LLM 速查：https://help.openalex.org/api/llm-quick-reference.md  
本技能 key 已在 2026-09-01 对生产 API 做过通测。

## 鉴权与费用

- Base：`https://api.openalex.org`
- User API：`https://user.openalex.org`（收藏、纠错）
- Content：`https://content.openalex.org`
- Header：`Authorization: Bearer <key>`（推荐）或 `?api_key=`
- 免费档（本 key）：`$1/day`，`credits_limit=10000`，UTC 午夜重置
- 单价：singleton 0；list 1 credit（$0.0001）；search/semantic 10（$0.001）；content/text 100（$0.01）
- 每秒最多 100 次；semantic / 已弃用 `/text` 另有 1 次/秒
- 响应头：`X-RateLimit-Limit|Remaining|Credits-Used|Reset`
- `GET /rate-limit` 返回 `daily_budget_usd`、`prepaid_*`、`endpoint_costs_usd`

本 key **没有**付费同步：`from_updated_date` / `from_created_date` → 429 `Plan upgrade required`。

## 实体与外部 ID

| 前缀 | 实体 | 外部 ID | 单条示例 |
| --- | --- | --- | --- |
| W | works | DOI、PMID、PMCID | `/works/doi:10.7717/peerj.4375` |
| A | authors | ORCID | `/authors/https://orcid.org/0000-0001-6187-6610` |
| S | sources | ISSN / ISSN-L | `/sources/issn:0028-0836` |
| I | institutions | ROR | `/institutions/https://ror.org/03cve4549` |
| T | topics | Wikidata | `/topics/T10305` |
| K | keywords | slug | `/keywords/microgrid` |
| P | publishers | Wikidata / ROR | `/publishers/P4310320439` |
| F | funders | ROR / Crossref Funder ID | `/funders/F4320321001` |
| G | awards | 基金号 | `/awards/G5066037109` |

Aboutness：`/topics` `/subfields` `/fields` `/domains` `/keywords` `/sdgs`。词表：`/continents` `/countries` `/languages` `/work-types` `/licenses`。`/concepts` 仍可查但已弃用。

## 列表参数

| 参数 | 说明 |
| --- | --- |
| `filter` | `field:value`，逗号 AND，`\|` OR（最多 100），`!` 否定，`>` `<` 比较，年份 `2020-2024` |
| `search` | 标题/摘要/全文（works）；会 stemming |
| `search.exact` | 不 stemming；通配 `*` `?` 必须走 exact |
| `search.semantic` | 语义检索，最多 50 条、输入 2000 字；不可与 search 同用 |
| `sort` | `cited_by_count:desc`；`relevance_score` 仅在 search 时 |
| `select` | 只要顶层字段，如 `id,doi,display_name,open_access` |
| `per_page` | 默认 25，最大 100（200 为遗留，不要用） |
| `page` | 与 per_page 乘积不超过 10000 |
| `cursor` | 深分页，从 `*` 开始跟 `meta.next_cursor` |
| `sample` / `seed` | 随机抽样，sample 最大 10000 |
| `group_by` | 最多每页 200 组；更多用 cursor；不要用 page |
| `corpus` | `core`（默认）/ `expansion` / `all` |

Boolean search：`AND` `OR` `NOT` 大写；短语加引号；邻近 `"climate change"~5`；模糊 `machin~1`。URL 约 4KB 上限，超长布尔要拆请求再并集。

## OQL / OQO

- 执行：`GET /?oql=` 或 `POST /` `{"oql":"…"}` / `{"oqo":{…}}`
- 翻译：`GET /query/oql/…` ` /query/oqo/…` ` /query/oxurl/…`
- 校验：`GET /validate?q=`
- 字段注册表：`GET /properties`、`GET /properties/works`（works 约 161 个 filter）
- 规格：`GET /query/spec`（cheatsheet / grammar / OQO schema）
- OQL 例：`works where year is (2024) and open access is (true)`
- grouping 写在语句里：`works where year >= (2020) group by type`
- 视图参数 `sort` `select` `page` `per_page` `cursor` 不要塞进 OQL 字符串

## 引用与相关

- 被引：`filter=cites:W…`（实测可用）
- 参考文献：读 works.`referenced_works` 再 `filter=openalex:W1\|W2` 批量（≤100）
- 相关：`filter=related_to:W…` 或 works.`related_works`
- `cited_by_api_url` 在部分 select 组合里可能不返回；用 `cites` 更稳

## 全文

- `has_content.pdf` / `has_content.grobid_xml`
- `content_urls.pdf` / `content_urls.grobid_xml`
- `GET https://content.openalex.org/works/{id}.pdf`
- `GET https://content.openalex.org/works/{id}.grobid-xml`（可能 gzip）
- 无缓存时 404 `Work not found in content index`
- 大规模请用官方 CLI / snapshot，不要 cursor 爬全库

## 收藏 Collections

需 Bearer。本 key 的 `GET https://user.openalex.org/me/collections` 可用。

- 创建 `POST /me/collections`（display_name 1–30 字，每类最多 1000 条，每用户 100 个）
- 过滤 `filter=collection:col_…`
- 跨类：`primary_location.source.id:col_…`、`authorships.author.id:col_…` 等
- 否定 `collection:!col_…`；每个请求每个字段只能一个 collection

## 作者纠错

`POST https://user.openalex.org/curations`，约 24h 生效。动作：claim work、remove from work、改 display_name / full_name / orcid。仅在用户明确要求时使用。

## 自动补全

`GET /autocomplete/{entity}?q=`，约 200ms，实测 0 credit。可直接贴 ORCID / OpenAlex ID。

## 语义检索限制

不支持 `cited_by_count` 与 `last_known_institutions.country_code` 作预过滤。

## 摘要还原

`abstract_inverted_index` 是词→位置。脚本 `abstract` 命令已还原。OpenAlex 不提供明文摘要字段。

## 本 key 明确不可用 / 不要用

| 能力 | 结果 |
| --- | --- |
| `/text` 文本打标签 | 500，一次 100 credits |
| `from_updated_date` | 429 需付费计划 |
| `/works/{id}/ngrams` | 返回作品本体，不是 n-gram |
| `GET /me`（api 根） | ID 格式错误；用户信息走 user.openalex.org |

## works 高频 filter（完整表用 `properties works`）

`publication_year`, `publication_date`, `from_publication_date`, `to_publication_date`, `type`, `language`, `doi`, `is_oa`, `open_access.is_oa`, `open_access.oa_status`, `authorships.author.id`, `authorships.author.orcid`, `authorships.institutions.id`, `authorships.institutions.country_code`, `authorships.institutions.ror`, `authorships.institutions.type`, `authorships.countries`, `primary_location.source.id`, `primary_location.source.issn`, `primary_location.license`, `topics.id`, `topics.field.id`, `primary_topic.id`, `keywords.id`, `funders.id`, `awards.id`, `awards.funder_id`, `awards.funder_award_id`, `cited_by_count`, `fwci`, `has_abstract`, `has_doi`, `has_fulltext`, `has_content.pdf`, `has_orcid`, `is_retracted`, `sustainable_development_goals.id`, `cites`/`cited_by`, `related_to`, `indexed_in`, `best_oa_location.license`

作者：`orcid`, `has_orcid`, `last_known_institutions.id`, `works_count`, `cited_by_count`  
机构：`ror`, `country_code`, `type`, `continent`  
来源：`issn`, `type`, `is_oa`, `is_in_doaj`  
基金：`ror`, `country_code`, `awards_count`
