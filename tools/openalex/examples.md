# OpenAlex 能源领域示例

下列 ID 均用本技能 key 在生产 API 查过。名称会变，**过滤一律用 ID**。

## 已核对的实体

| 对象 | OpenAlex ID | 外部 ID |
| --- | --- | --- |
| 清华大学 | `I99065089` | ROR `https://ror.org/03cve4549` |
| 国家自然科学基金委 NSFC | `F4320321001` | ROR `01h0zpd94`，Crossref `501100001809` |
| IEEE Transactions on Power Systems | `S201921491` | 用 `resolve sources` 复核 ISSN |
| Nature（期刊） | `S137773608` | ISSN `0028-0836` |
| 关键词 microgrid | `keywords/microgrid` | |
| OA 经典论文 The state of OA | `W2741809807` | DOI `10.7717/peerj.4375`，PMID `29456894` |

## 虚拟电厂 / 储能

```bash
node tools/openalex/scripts/openalex.mjs search works "virtual power plant" --per-page 10 --select id,display_name,publication_year,cited_by_count,doi
node tools/openalex/scripts/openalex.mjs semantic "distributed energy storage for frequency regulation" --per-page 10
node tools/openalex/scripts/openalex.mjs resolve topics "power system"
```

## 清华 2024 高被引文章

```bash
node tools/openalex/scripts/openalex.mjs list works --filter "authorships.institutions.id:I99065089,publication_year:2024,type:article" --sort cited_by_count:desc --per-page 10 --select id,display_name,cited_by_count,doi
```

## NSFC 资助的储能相关

```bash
node tools/openalex/scripts/openalex.mjs list works --filter "awards.funder_id:F4320321001,publication_year:2020-2024" --search "energy storage" --per-page 10
```

`search` 与 `filter` 不要拆成两次再手工拼接；一次请求即可。search 比纯 filter 贵 10 倍。

## 期刊发文

```bash
node tools/openalex/scripts/openalex.mjs list works --filter "primary_location.source.id:S201921491,publication_year:2023-2025,type:article" --sort cited_by_count:desc --per-page 10
```

## 开放获取 + 可下载 PDF

```bash
node tools/openalex/scripts/openalex.mjs list works --filter "has_content.pdf:true,best_oa_location.license:cc-by,publication_year:2023" --per-page 5 --select id,display_name,has_content,content_urls,doi
```

确认用户要全文后再：

```bash
node tools/openalex/scripts/openalex.mjs content pdf W4385245566 --out papers/W4385245566.pdf --yes
```

## 引用网络

```bash
node tools/openalex/scripts/openalex.mjs get works W2741809807
node tools/openalex/scripts/openalex.mjs cites W2741809807 --per-page 10 --sort cited_by_count:desc
node tools/openalex/scripts/openalex.mjs related W2741809807 --per-page 10
node tools/openalex/scripts/openalex.mjs abstract W2741809807
```

## OQL

```bash
node tools/openalex/scripts/openalex.mjs validate "works where year >= (2023) and title has (microgrid)"
node tools/openalex/scripts/openalex.mjs oql "works where year >= (2023) and open access is (true) and type is (article)" --per-page 5 --sort cited_by_count:desc
node tools/openalex/scripts/openalex.mjs translate oql "works where institution is (I99065089) and year is (2024)"
```

## 计量

```bash
node tools/openalex/scripts/openalex.mjs group works --filter "authorships.institutions.id:I99065089,publication_year:2020-2024" --group-by publication_year
node tools/openalex/scripts/openalex.mjs group works --filter "publication_year:2024,authorships.institutions.country_code:cn,type:article" --group-by open_access.oa_status
```

## 批量 DOI

```bash
node tools/openalex/scripts/openalex.mjs batch-doi 10.7717/peerj.4375 10.1038/nature12373
```

单条 DOI 用 `get`（免费）。只有清单比对才用 batch-doi（list 计费）。
