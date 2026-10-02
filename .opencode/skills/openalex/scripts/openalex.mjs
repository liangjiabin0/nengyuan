#!/usr/bin/env node
/**
 * OpenAlex REST / OQL / Collections / Content CLI for the 能元 agent.
 * Auth: OPENALEX_API_KEY, else the bundled free key.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

const DEFAULT_API_KEY = process.env.OPENALEX_API_KEY || '';
const API = 'https://api.openalex.org';
const USER = 'https://user.openalex.org';
const CONTENT = 'https://content.openalex.org';
const TIMEOUT_MS = 30_000;

const ENTITIES = new Set([
  'works',
  'authors',
  'sources',
  'institutions',
  'topics',
  'publishers',
  'funders',
  'awards',
  'subfields',
  'fields',
  'domains',
  'keywords',
  'sdgs',
  'concepts',
  'continents',
  'countries',
  'languages',
  'licenses'
]);

const VOCAB = {
  domains: '/domains',
  fields: '/fields',
  subfields: '/subfields',
  sdgs: '/sdgs',
  continents: '/continents',
  countries: '/countries',
  languages: '/languages',
  types: '/work-types',
  'work-types': '/work-types',
  licenses: '/licenses',
  keywords: '/keywords'
};

function apiKey() {
  return String(process.env.OPENALEX_API_KEY || DEFAULT_API_KEY).trim();
}

function parseArgs(argv) {
  const args = [...argv];
  const flags = {};
  const positional = [];
  while (args.length) {
    const token = args.shift();
    if (token === '--') {
      positional.push(...args);
      break;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (key === 'json' || key === 'compact' || key === 'yes' || key === 'raw') {
        flags[key] = true;
        continue;
      }
      const next = args[0] && !args[0].startsWith('-') ? args.shift() : 'true';
      flags[key] = next;
      continue;
    }
    positional.push(token);
  }
  return { flags, positional };
}

function authHeaders(extra = {}) {
  const key = apiKey();
  return {
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    Accept: 'application/json',
    ...extra
  };
}

function withQuery(url, params) {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(url, options = {}, attempt = 0) {
  const method = options.method || 'GET';
  const headers = authHeaders(options.headers || {});
  const res = await fetch(url, {
    method,
    headers,
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs || TIMEOUT_MS),
    redirect: 'follow'
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    const wait = Math.min(16_000, 1000 * 2 ** attempt);
    await sleep(wait);
    return request(url, options, attempt + 1);
  }
  return res;
}

function rateHeaders(res) {
  return {
    limit: res.headers.get('x-ratelimit-limit'),
    remaining: res.headers.get('x-ratelimit-remaining'),
    used: res.headers.get('x-ratelimit-credits-used'),
    reset: res.headers.get('x-ratelimit-reset')
  };
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'non-json', status: res.status, body: text.slice(0, 800) };
  }
}

function fail(res, json) {
  const message = json?.error || json?.message || json?.validation || `HTTP ${res.status}`;
  const err = new Error(typeof message === 'string' ? message : JSON.stringify(message));
  err.status = res.status;
  err.json = json;
  throw err;
}

async function apiJson(url, options = {}) {
  const res = await request(url, options);
  const json = await readJson(res);
  if (!res.ok) fail(res, json);
  return { json, rate: rateHeaders(res), status: res.status };
}

function reconstructAbstract(index) {
  if (!index || typeof index !== 'object') return '';
  const slots = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) slots[pos] = word;
  }
  return slots.filter((item) => item != null).join(' ');
}

function shortId(value) {
  const text = String(value || '');
  const match = text.match(/\/([A-Z]\d+|col_[A-Za-z0-9]+|sdgs\/\d+|domains\/\d+|fields\/\d+|subfields\/\d+|keywords\/[^/?#]+|types\/[^/?#]+|licenses\/[^/?#]+|continents\/[^/?#]+|countries\/[A-Z]{2})(?:\?|$)/i);
  if (match) return match[1];
  return text.replace(/^https:\/\/openalex\.org\//i, '');
}

function compactEntity(item) {
  if (!item || typeof item !== 'object') return item;
  if (item.key && item.count != null) {
    return {
      key: item.key,
      name: item.key_display_name || item.key,
      count: item.count
    };
  }
  const out = {
    id: shortId(item.id),
    display_name: item.display_name || item.title || item.hint
  };
  if (item.doi) out.doi = item.doi;
  if (item.orcid) out.orcid = item.orcid;
  if (item.ror) out.ror = item.ror;
  if (item.issn_l) out.issn_l = item.issn_l;
  if (item.publication_year) out.year = item.publication_year;
  if (item.type) out.type = item.type;
  if (item.cited_by_count != null) out.cited_by_count = item.cited_by_count;
  if (item.works_count != null) out.works_count = item.works_count;
  if (item.relevance_score != null) out.relevance_score = item.relevance_score;
  if (item.fwci != null) out.fwci = item.fwci;
  if (item.open_access) {
    out.is_oa = item.open_access.is_oa;
    out.oa_status = item.open_access.oa_status;
  }
  if (item.primary_topic?.display_name) out.topic = item.primary_topic.display_name;
  if (item.entity_type) out.entity_type = item.entity_type;
  if (item.external_id) out.external_id = item.external_id;
  if (item.ids?.ror) out.ror = item.ids.ror;
  if (item.has_content) out.has_content = item.has_content;
  return out;
}

function compactPayload(json) {
  if (!json || typeof json !== 'object') return json;
  if (Array.isArray(json.results)) {
    return {
      meta: json.meta,
      results: json.results.map(compactEntity)
    };
  }
  if (Array.isArray(json.group_by)) {
    return {
      meta: json.meta,
      group_by: json.group_by.map(compactEntity)
    };
  }
  if (json.id || json.display_name) {
    const compact = compactEntity(json);
    if (json.abstract_inverted_index) compact.abstract = reconstructAbstract(json.abstract_inverted_index);
    return compact;
  }
  return json;
}

function print(json, flags, extra = {}) {
  const payload = flags.json ? json : flags.raw ? json : compactPayload(json);
  const out = flags.compact === false ? json : { ...extra, ...payload };
  process.stdout.write(`${JSON.stringify(out, null, flags.compact ? 0 : 2)}\n`);
}

function listParams(flags) {
  return {
    filter: flags.filter,
    search: flags.search,
    'search.exact': flags['search-exact'] || flags.search_exact,
    'search.semantic': flags['search-semantic'] || flags.search_semantic,
    sort: flags.sort,
    select: flags.select,
    page: flags.page,
    per_page: flags['per-page'] || flags.per_page || flags.perPage || 25,
    cursor: flags.cursor,
    sample: flags.sample,
    seed: flags.seed,
    group_by: flags['group-by'] || flags.group_by,
    corpus: flags.corpus
  };
}

function assertEntity(name) {
  const entity = String(name || '').trim().toLowerCase();
  if (entity === 'type' || entity === 'types') return 'work-types';
  if (!ENTITIES.has(entity) && entity !== 'work-types') {
    throw new Error(`未知实体: ${name}。可用: ${[...ENTITIES].join(', ')}`);
  }
  return entity;
}

const HELP = `OpenAlex CLI（能元技能脚本）

用法:
  node tools/openalex/scripts/openalex.mjs <命令> [参数] [选项]

命令:
  usage                         配额与单价
  get <实体> <id>               单条查询（DOI/ORCID/ROR/ISSN/PMID 免费）
  list <实体>                   列表/筛选
  search <实体> <词>            关键词检索（$0.001/次）
  semantic <段落>               语义检索 works（最多 50 条）
  autocomplete [实体] <q>       快速消歧（免费）
  resolve <实体> <名称>         名称 -> ID（autocomplete）
  oql <语句>                    执行 OQL
  oqo <json>                    执行 OQO JSON
  translate oql|oqo|oxurl <q>   三种查询互译（几乎免费）
  validate <oql>                校验 OQL
  properties [实体]             可筛/可分组字段
  group <实体>                  group_by 聚合
  cites <W...>                  引用该论文的文献
  cited-by <W...>               该论文参考文献
  related <W...>                相关文献
  abstract <W...>               还原摘要
  content pdf|xml <W...> --out  下载缓存全文（$0.01，须 --yes）
  batch-doi <doi...>            批量 DOI（最多 100）
  vocab <词表>                  domains/fields/subfields/sdgs/continents/countries/languages/types/licenses
  collections list|create|get|entities|add|remove|delete
  curate                        提交作者纠错（须用户明确要求）

常用选项:
  --filter a:b,c:d   --sort cited_by_count:desc
  --select id,display_name,cited_by_count
  --per-page 100     --page 1     --cursor *
  --sample 50 --seed 42     --corpus core|all|expansion
  --group-by type    --json   --yes

鉴权: 环境变量 OPENALEX_API_KEY，否则用技能内置免费 key。
禁止: /text（已弃用且贵）、from_updated_date（本 key 无付费同步权限）。
`;

async function cmdUsage(flags) {
  const { json } = await apiJson(`${API}/rate-limit`);
  print(json, flags);
}

async function cmdGet(entity, id, flags) {
  const kind = assertEntity(entity);
  const ident = String(id || '').trim();
  if (!ident) throw new Error('缺少 id / doi / orcid / ror / issn / pmid');
  const { json } = await apiJson(`${API}/${kind}/${encodeURIComponent(ident)}`);
  if (flags.abstract && json.abstract_inverted_index) {
    json.abstract = reconstructAbstract(json.abstract_inverted_index);
  }
  print(json, flags);
}

async function cmdList(entity, flags) {
  const kind = assertEntity(entity);
  const { json } = await apiJson(withQuery(`${API}/${kind}`, listParams(flags)));
  print(json, flags);
}

async function cmdSearch(entity, query, flags) {
  const kind = assertEntity(entity);
  const { json } = await apiJson(withQuery(`${API}/${kind}`, {
    ...listParams(flags),
    search: query
  }));
  print(json, flags);
}

async function cmdSemantic(query, flags) {
  const { json } = await apiJson(withQuery(`${API}/works`, {
    ...listParams(flags),
    search: undefined,
    'search.semantic': query,
    per_page: flags['per-page'] || 25
  }));
  print(json, flags);
}

async function cmdAutocomplete(entity, query, flags) {
  const pathName = entity ? `/autocomplete/${assertEntity(entity)}` : '/autocomplete';
  const { json } = await apiJson(withQuery(`${API}${pathName}`, {
    q: query,
    filter: flags.filter,
    search: flags.search
  }));
  print(json, flags);
}

async function cmdOql(query, flags) {
  const { json } = await apiJson(withQuery(`${API}/`, {
    oql: query,
    ...listParams(flags)
  }));
  print(json, flags);
}

async function cmdOqo(raw, flags) {
  let oqo = raw;
  if (typeof raw === 'string') oqo = JSON.parse(raw);
  const body = {
    oqo,
    sort: flags.sort,
    select: flags.select,
    page: flags.page ? Number(flags.page) : undefined,
    per_page: flags['per-page'] ? Number(flags['per-page']) : 25,
    cursor: flags.cursor
  };
  const { json } = await apiJson(`${API}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  print(json, flags);
}

async function cmdTranslate(format, query, flags) {
  const kind = String(format || '').toLowerCase();
  if (!['oql', 'oqo', 'oxurl'].includes(kind)) throw new Error('translate 格式必须是 oql | oqo | oxurl');
  const { json } = await apiJson(`${API}/query/${kind}/${encodeURIComponent(query)}`);
  print(json, flags);
}

async function cmdValidate(query, flags) {
  const { json } = await apiJson(withQuery(`${API}/validate`, { q: query }));
  print(json, flags);
}

async function cmdProperties(entity, flags) {
  const url = entity ? `${API}/properties/${assertEntity(entity)}` : `${API}/properties`;
  const { json } = await apiJson(url);
  if (flags.json || !entity) {
    print(json, { ...flags, json: true });
    return;
  }
  const bag = json.properties?.[assertEntity(entity)] || {};
  const filters = [];
  const groupBy = [];
  const sort = [];
  for (const [name, spec] of Object.entries(bag)) {
    const actions = spec.actions || [];
    if (actions.includes('filter')) filters.push(name);
    if (actions.includes('group_by')) groupBy.push(name);
    if (actions.includes('sort')) sort.push(name);
  }
  print({ entity: assertEntity(entity), filter: filters, group_by: groupBy, sort }, { json: true });
}

async function cmdGroup(entity, flags) {
  if (!flags['group-by'] && !flags.group_by) throw new Error('缺少 --group-by');
  await cmdList(entity, { ...flags, cursor: flags.cursor || '*' });
}

async function cmdCites(id, flags) {
  const { json } = await apiJson(withQuery(`${API}/works`, {
    ...listParams(flags),
    filter: `cites:${shortId(id)}`,
    sort: flags.sort || 'publication_date:desc'
  }));
  print(json, flags);
}

async function cmdCitedBy(id, flags) {
  const work = await apiJson(`${API}/works/${encodeURIComponent(id)}?select=id,display_name,referenced_works`);
  const ids = (work.json.referenced_works || []).slice(0, 100).map(shortId);
  if (!ids.length) {
    print({ meta: { count: 0 }, results: [] }, flags);
    return;
  }
  const { json } = await apiJson(withQuery(`${API}/works`, {
    ...listParams(flags),
    filter: `openalex:${ids.join('|')}`,
    per_page: Math.min(100, ids.length)
  }));
  print(json, flags);
}

async function cmdRelated(id, flags) {
  const { json } = await apiJson(withQuery(`${API}/works`, {
    ...listParams(flags),
    filter: `related_to:${shortId(id)}`
  }));
  print(json, flags);
}

async function cmdAbstract(id, flags) {
  const { json } = await apiJson(`${API}/works/${encodeURIComponent(id)}?select=id,display_name,doi,abstract_inverted_index`);
  print({
    id: json.id,
    display_name: json.display_name,
    doi: json.doi,
    abstract: reconstructAbstract(json.abstract_inverted_index)
  }, { json: true, ...flags });
}

async function cmdBatchDoi(dois, flags) {
  const values = dois.map((item) => String(item).replace(/^https?:\/\/doi.org\//i, '')).filter(Boolean);
  if (!values.length) throw new Error('缺少 DOI');
  if (values.length > 100) throw new Error('单次最多 100 个 DOI');
  const filter = `doi:${values.map((item) => `https://doi.org/${item}`).join('|')}`;
  const { json } = await apiJson(withQuery(`${API}/works`, {
    filter,
    per_page: Math.min(100, values.length),
    select: flags.select || 'id,doi,display_name,publication_year,cited_by_count,type,open_access'
  }));
  print(json, flags);
}

async function cmdVocab(name, flags) {
  const route = VOCAB[String(name || '').toLowerCase()];
  if (!route) throw new Error(`未知词表: ${name}。可用: ${Object.keys(VOCAB).join(', ')}`);
  const { json } = await apiJson(withQuery(`${API}${route}`, {
    search: flags.search,
    filter: flags.filter,
    per_page: flags['per-page'] || 100,
    page: flags.page
  }));
  print(json, flags);
}

async function cmdContent(kind, id, flags) {
  const format = String(kind || '').toLowerCase();
  if (format !== 'pdf' && format !== 'xml') throw new Error('content 只要 pdf 或 xml');
  if (!flags.yes) throw new Error('下载全文每次约 $0.01。确认后加 --yes，并提供 --out');
  const out = String(flags.out || '').trim();
  if (!out) throw new Error('缺少 --out');
  const workId = shortId(id);
  const ext = format === 'pdf' ? '.pdf' : '.grobid-xml';
  const url = `${CONTENT}/works/${workId}${ext}`;
  const res = await request(url, { timeoutMs: 120_000, headers: { Accept: '*/*' } });
  if (!res.ok) {
    const json = await readJson(res);
    fail(res, json);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const target = path.resolve(out);
  await mkdir(path.dirname(target), { recursive: true });
  const magic = buf.slice(0, 2);
  const unzipped = magic[0] === 0x1f && magic[1] === 0x8b ? gunzipSync(buf) : buf;
  await writeFile(target, unzipped);
  print({
    ok: true,
    id: workId,
    format,
    bytes: unzipped.length,
    out: target,
    credits_used: rateHeaders(res).used
  }, { json: true });
}

async function cmdCollections(action, rest, flags) {
  const verb = String(action || 'list').toLowerCase();
  if (verb === 'list') {
    const { json } = await apiJson(withQuery(`${USER}/me/collections`, {
      page: flags.page,
      per_page: flags['per-page'] || 25,
      entity_id: flags['entity-id']
    }));
    print(json, flags);
    return;
  }
  if (verb === 'create') {
    const body = {
      display_name: flags.name || flags['display-name'],
      entity_type: flags.type || flags['entity-type'] || 'works',
      description: flags.description || '',
      entity_ids: rest.length ? rest : undefined
    };
    if (!body.display_name) throw new Error('create 需要 --name');
    const { json } = await apiJson(`${USER}/me/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    print(json, flags);
    return;
  }
  const collectionId = rest[0];
  if (!collectionId) throw new Error('缺少 collection id');
  if (verb === 'get') {
    const { json } = await apiJson(`${USER}/collections/${collectionId}`);
    print(json, flags);
    return;
  }
  if (verb === 'entities') {
    const { json } = await apiJson(withQuery(`${USER}/collections/${collectionId}/entities`, {
      per_page: flags['per-page'] || 200,
      page: flags.page
    }));
    print(json, flags);
    return;
  }
  if (verb === 'add') {
    const ids = rest.slice(1);
    if (!ids.length) throw new Error('add 需要实体 ID');
    const { json } = await apiJson(`${USER}/me/collections/${collectionId}/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_ids: ids })
    });
    print(json, flags);
    return;
  }
  if (verb === 'remove') {
    const ids = rest.slice(1);
    if (!ids.length) throw new Error('remove 需要实体 ID');
    const { json } = await apiJson(`${USER}/me/collections/${collectionId}/entities`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_ids: ids })
    });
    print(json, flags);
    return;
  }
  if (verb === 'delete') {
    const { json } = await apiJson(`${USER}/me/collections/${collectionId}`, { method: 'DELETE' });
    print(json, flags);
    return;
  }
  if (verb === 'filter') {
    const entity = flags.entity || 'works';
    const { json } = await apiJson(withQuery(`${API}/${assertEntity(entity)}`, {
      ...listParams(flags),
      filter: [flags.filter, `collection:${collectionId}`].filter(Boolean).join(',')
    }));
    print(json, flags);
    return;
  }
  throw new Error(`未知 collections 动作: ${verb}`);
}

async function cmdCurate(flags) {
  if (!flags.yes) throw new Error('纠错会写入 OpenAlex。须用户明确要求后加 --yes');
  const body = {
    entity: flags.entity,
    entity_id: flags['entity-id'],
    property: flags.property,
    action: flags.action,
    value: flags.value
  };
  if (!body.entity || !body.entity_id || !body.property || !body.action || !body.value) {
    throw new Error('curate 需要 --entity --entity-id --property --action --value');
  }
  const { json } = await apiJson(`${USER}/curations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  print(json, flags);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  if (!command || command === 'help' || flags.help) {
    process.stdout.write(HELP);
    return;
  }
  switch (command) {
    case 'usage':
      await cmdUsage(flags);
      break;
    case 'get':
      await cmdGet(rest[0], rest.slice(1).join(' '), flags);
      break;
    case 'list':
      await cmdList(rest[0], flags);
      break;
    case 'search':
      await cmdSearch(rest[0], rest.slice(1).join(' '), flags);
      break;
    case 'semantic':
      await cmdSemantic(rest.join(' '), flags);
      break;
    case 'autocomplete':
    case 'resolve': {
      const maybeEntity = rest[0] && ENTITIES.has(rest[0]) ? rest.shift() : '';
      await cmdAutocomplete(maybeEntity, rest.join(' '), flags);
      break;
    }
    case 'oql':
      await cmdOql(rest.join(' '), flags);
      break;
    case 'oqo':
      await cmdOqo(rest.join(' '), flags);
      break;
    case 'translate':
      await cmdTranslate(rest[0], rest.slice(1).join(' '), flags);
      break;
    case 'validate':
      await cmdValidate(rest.join(' '), flags);
      break;
    case 'properties':
      await cmdProperties(rest[0], flags);
      break;
    case 'group':
      await cmdGroup(rest[0], flags);
      break;
    case 'cites':
      await cmdCites(rest[0], flags);
      break;
    case 'cited-by':
      await cmdCitedBy(rest[0], flags);
      break;
    case 'related':
      await cmdRelated(rest[0], flags);
      break;
    case 'abstract':
      await cmdAbstract(rest[0], flags);
      break;
    case 'batch-doi':
      await cmdBatchDoi(rest, flags);
      break;
    case 'vocab':
      await cmdVocab(rest[0], flags);
      break;
    case 'content':
      await cmdContent(rest[0], rest[1], flags);
      break;
    case 'collections':
      await cmdCollections(rest[0], rest.slice(1), flags);
      break;
    case 'curate':
      await cmdCurate(flags);
      break;
    default:
      throw new Error(`未知命令: ${command}\n${HELP}`);
  }
}

main().catch((error) => {
  const payload = {
    ok: false,
    error: error.message,
    status: error.status || null
  };
  if (error.json) payload.detail = error.json;
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
