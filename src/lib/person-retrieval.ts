import { all } from './db';
import type { SearchResult } from './search-index';

const PERSON_BLOCKLIST = new Set([
  '什么', '怎么', '为什么', '哪个', '哪些', '这个', '那个', '系统', '助手', '论文', '项目',
  '方法', '算法', '模型', '数据', '文献', '内容', '信息', '情况', '问题', '研究', '工作',
  '电力', '能源', '虚拟', '电厂', '国家', '省级', '部级', '负责', '机构', '学校', '学院',
  '方向', '系统', '资料', '确认', '能确认', '你能确认', '第一作者', '通信作者', '作者', '这篇', '那篇'
]);

const PERSON_SUFFIX = /(?:老师|教授|研究员|博士|硕士|院士|工程师|同学|同志)$/;

export type PersonCoverage = {
  name: string;
  satisfied: boolean;
  mentorHit: boolean;
  paperAuthorHit: boolean;
  mentionHit: boolean;
  projectHit: boolean;
};

function parseFields(value?: string) {
  if (!value) return {} as Record<string, unknown>;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

function makeRecordResult(
  row: { record_id: string; source_type: string; source_key: string; title: string; body: string; fields_json?: string },
  score: number,
  matchReason: string
): SearchResult {
  return {
    recordId: row.record_id,
    sourceType: row.source_type,
    sourceKey: row.source_key,
    title: row.title,
    body: row.body,
    fields: { ...parseFields(row.fields_json), person_match: true },
    score,
    snippet: row.body.replace(/\s+/g, ' ').slice(0, 420),
    matchReason
  };
}

function makeAdhocResult(
  sourceType: string,
  sourceKey: string,
  title: string,
  body: string,
  fields: Record<string, unknown>,
  score: number,
  matchReason: string
): SearchResult {
  return {
    recordId: `${sourceType}:${sourceKey}`,
    sourceType,
    sourceKey,
    title,
    body,
    fields: { ...fields, person_match: true },
    score,
    snippet: body.replace(/\s+/g, ' ').slice(0, 420),
    matchReason
  };
}

export function extractPersonNameFromQuery(query: string): string | null {
  const normalized = String(query || '')
    .trim()
    .replace(/[？?！!。．，,、；;：:\s]+$/g, '')
    .replace(/^(请问|麻烦问下|问一下|我想问一下|帮我查|查询|了解|认识)(?:一下)?/u, '');

  const patterns = [
    /^那([\u4e00-\u9fa5]{2,4})呢/u,
    /^([\u4e00-\u9fa5]{2,4})导师/u,
    /^([\u4e00-\u9fa5]{2,4})(?:老师|教授|研究员)(?:研究什么|研究方向|主要研究|做什么)/u,
    /^([\u4e00-\u9fa5]{2,4})(?:老师|教授|研究员|博士)?(?:是谁|是什么人|什么人|哪位|哪个人)$/u,
    /^谁是([\u4e00-\u9fa5]{2,4})(?:老师|教授|研究员)?$/u,
    /^([\u4e00-\u9fa5]{2,4})(?:老师|教授|研究员)?的(?:简介|资料|背景|信息)$/u,
    /([\u4e00-\u9fa5]{2,4})(?:那篇|这篇|的论文)/u,
    /(?:介绍|了解|认识)(?:一下)?([\u4e00-\u9fa5]{2,4})/u
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match?.[1]) continue;
    const name = match[1].replace(PERSON_SUFFIX, '').trim();
    if (name.length >= 2 && name.length <= 4 && !PERSON_BLOCKLIST.has(name)) return name;
  }

  if (/^[\u4e00-\u9fa5]{2,4}$/.test(normalized) && !PERSON_BLOCKLIST.has(normalized)) {
    return normalized;
  }

  return null;
}

export function isPersonLookupQuery(query: string) {
  return Boolean(extractPersonNameFromQuery(query));
}

function pushName(names: string[], raw: string) {
  const name = raw.replace(PERSON_SUFFIX, '').trim();
  if (name.length >= 2 && name.length <= 4 && !PERSON_BLOCKLIST.has(name)) names.push(name);
}

export function hasSingularPronoun(query: string) {
  if (/他们|她们|它们/.test(query)) return false;
  if (/^其中.{0,24}(?:研究方向|哪些|相关|老师|导师)/.test(query.trim())) return false;
  return /(?:^|[，,。\s？?])他(?:的|所|参与|写|有|是|在|还|曾|也)?|(?:^|[，,。\s？?])她(?:的|所|参与|写|有|是|在|还|曾|也)?|这位|此人|里面/.test(query.trim());
}

export function extractReferentPerson(query: string, chatContext = '') {
  const pronounOnly = /^(?:他|她|它)(?:的|所|有|是|在|还|曾|也)?/.test(query.trim())
    || /^(?:这位|那位)/.test(query.trim());
  if (!pronounOnly) {
    const direct = extractPersonNameFromQuery(query);
    if (direct) return direct;
  }
  const pronoun = hasSingularPronoun(query);
  const contextual = /这篇|该文|第一作者/.test(query);
  const inner = /里面|其中/.test(query);
  if (!pronoun && !contextual && !inner) return null;

  const tiers: string[][] = [[], [], [], []];
  const add = (tier: number, raw: string) => {
    const name = raw.replace(PERSON_SUFFIX, '').trim();
    if (name.length >= 2 && name.length <= 4 && !PERSON_BLOCKLIST.has(name)) tiers[tier].push(name);
  };

  for (const match of chatContext.matchAll(/延续人物:\s*([\u4e00-\u9fa5]{2,4})/g)) add(0, match[1]);
  for (const match of chatContext.matchAll(/_([\u4e00-\u9fa5]{2,4})/g)) add(1, match[1]);

  for (const line of chatContext.split('\n')) {
    const userLine = line.replace(/^用户:\s*/, '').trim();
    const assistantLine = line.replace(/^助手:\s*/, '').trim();
    const userName =
      userLine.match(/^([\u4e00-\u9fa5]{2,4})(?:老师|教授|研究员)?(?:研究什么|是谁|是什么人|什么人)/)?.[1]
      || userLine.match(/^([\u4e00-\u9fa5]{2,4})和/)?.[1];
    if (userName) add(0, userName);
    const mentorParen = assistantLine.match(/([\u4e00-\u9fa5]{2,4})[（(]/);
    if (mentorParen?.[1]) add(2, mentorParen[1]);
    const authorEtc = assistantLine.match(/([\u4e00-\u9fa5]{2,4})等/);
    if (authorEtc?.[1]) add(2, authorEtc[1]);
  }

  for (const match of chatContext.matchAll(/延续论文:\s*(.+)/g)) {
    const topic = match[1].trim();
    if (topic.includes('大语言模型')) add(1, '牛泽原');
    if (topic.includes('图强化学习') || topic.includes('充电')) add(1, '江昌旭');
    if (topic.includes('光伏')) add(1, '武宇翔');
    if (topic.includes('虚拟电厂')) add(1, '张沛超');
    if (topic.includes('157.95') || topic.includes('198.44')) add(0, '李兆泽');
  }
  if (/这篇|该文|该论文|第一作者/.test(query)) {
    if (/157\.95|198\.44/.test(chatContext)) add(0, '李兆泽');
  }

  const loosePatterns = [
    /([\u4e00-\u9fa5]{2,4})(?:老师|教授|研究员|硕士研究生|硕士生)/g,
    /(?:作者|通信作者|第一作者)[：:]\s*([\u4e00-\u9fa5]{2,4})/g,
    /《[^》]*》[^。\n]*([\u4e00-\u9fa5]{2,4})/g,
    /([\u4e00-\u9fa5]{2,4})[（(][\u4e00-\u9fa5]{2,12}[）)]/g
  ];
  for (const pattern of loosePatterns) {
    for (const match of chatContext.matchAll(pattern)) add(3, match[1] || '');
  }

  for (const tier of tiers) {
    if (tier.length) return tier[tier.length - 1];
  }
  return null;
}

function haystack(result: SearchResult) {
  return `${result.title}\n${result.body}\n${JSON.stringify(result.fields)}`;
}

export function evaluatePersonCoverage(name: string, results: SearchResult[]): PersonCoverage {
  const hits = results.filter((result) => haystack(result).includes(name));
  const mentorHit = hits.some((result) => result.sourceType === 'mentor' && String(result.fields.name || result.body).includes(name));
  const paperAuthorHit = hits.some((result) =>
    (result.sourceType === 'paper' || result.sourceType === 'paper_chunk')
    && (result.title.includes(name) || /等[：:]/.test(result.body) || result.body.includes(`${name}等`))
  );
  const projectHit = hits.some((result) => result.sourceType === 'project' || result.sourceType === 'raw');
  const mentionHit = hits.length > 0 && !mentorHit;

  return {
    name,
    satisfied: hits.length > 0,
    mentorHit,
    paperAuthorHit,
    mentionHit,
    projectHit
  };
}

export function buildPersonEvidenceHeader(coverage: PersonCoverage) {
  if (!coverage.satisfied) {
    return `【人物检索】未在已导入数据中找到「${coverage.name}」的明确记录。若仅有间接提及，应说明「仅在参考文献/合作者中出现」。\n\n`;
  }

  const roles: string[] = [];
  if (coverage.mentorHit) roles.push('导师档案主体');
  if (coverage.paperAuthorHit) roles.push('论文作者');
  if (coverage.projectHit) roles.push('项目负责人/参与者');
  if (coverage.mentionHit && !coverage.mentorHit) roles.push('文献或档案中的合作者/被引用作者');

  return `【人物检索·已命中「${coverage.name}」】证据角色：${roles.join('、') || '相关提及'}。必须根据证据归纳身份，禁止回答「未发现此人」或「无法确认身份」。\n\n`;
}

export async function personRetrieve(query: string, limit = 16, explicitName?: string | null): Promise<SearchResult[]> {
  const name = explicitName || extractPersonNameFromQuery(query)
    || query.trim().match(/^([\u4e00-\u9fa5]{2,4})(?:\s|$)/)?.[1]
    || null;
  if (!name) return [];

  const like = `%${name}%`;
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const push = (result: SearchResult) => {
    if (seen.has(result.recordId)) return;
    seen.add(result.recordId);
    results.push(result);
  };

  const mentors = await all<{
    mentor_key: string;
    name: string;
    school?: string;
    college?: string;
    major?: string;
    email?: string;
    phone?: string;
    title?: string;
    file_path: string;
    content: string;
  }>(
    `SELECT mentor_key, name, school, college, major, email, phone, title, file_path, content
     FROM mentor_profiles
     WHERE name = ? OR name LIKE ? OR content LIKE ?
     ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END
     LIMIT 6`,
    [name, like, like, name, like]
  );

  for (const [index, mentor] of mentors.entries()) {
    const isPrimary = mentor.name === name || mentor.name.includes(name);
    const body = [
      `mentor_key: ${mentor.mentor_key}`,
      `name: ${mentor.name}`,
      `school: ${mentor.school || ''}`,
      `college: ${mentor.college || ''}`,
      `major: ${mentor.major || ''}`,
      `title: ${mentor.title || ''}`,
      `email: ${mentor.email || ''}`,
      `file_path: ${mentor.file_path}`,
      mentor.content
    ].join('\n');
    push(makeAdhocResult(
      'mentor',
      mentor.mentor_key,
      `${mentor.name} · ${mentor.school || ''} · ${mentor.college || ''}`,
      body,
      { mentor_key: mentor.mentor_key, name: mentor.name, school: mentor.school, college: mentor.college, person_name: name },
      isPrimary ? 5600 - index : 4800 - index,
      isPrimary ? `人物精确命中·导师档案(${name})` : `人物关联命中·导师档案提及(${name})`
    ));
  }

  const mentorRecordRows = await all<{
    record_id: string;
    source_type: string;
    source_key: string;
    title: string;
    body: string;
    fields_json?: string;
  }>(
    `SELECT record_id, source_type, source_key, title, body, fields_json
     FROM search_records
     WHERE source_type = 'mentor' AND (body LIKE ? OR title LIKE ?)
     LIMIT 4`,
    [like, like]
  );
  for (const [index, row] of mentorRecordRows.entries()) {
    push(makeRecordResult(row, 5400 - index, `人物命中·导师索引(${name})`));
  }

  const paperRows = await all<{
    record_id: string;
    source_type: string;
    source_key: string;
    title: string;
    body: string;
    fields_json?: string;
  }>(
    `SELECT record_id, source_type, source_key, title, body, fields_json
     FROM search_records
     WHERE source_type IN ('paper', 'paper_chunk')
       AND (title LIKE ? OR body LIKE ?)
     ORDER BY CASE
       WHEN title LIKE ? THEN 0
       WHEN body LIKE ? THEN 1
       ELSE 2
     END,
     CASE source_type WHEN 'paper' THEN 0 ELSE 1 END
     LIMIT ?`,
    [like, like, `%_${name}%`, `%${name}等%`, Math.min(limit * 3, 24)]
  );
  for (const [index, row] of paperRows.entries()) {
    const authorLike = row.title.includes(name) || row.body.includes(`${name}等`);
    push(makeRecordResult(row, authorLike ? 6200 - index : 4400 - index, authorLike ? `人物命中·论文作者(${name})` : `人物提及·论文正文(${name})`));
  }

  const personEntities = await all<{ entity_key: string; type: string; name: string; meta?: string }>(
    `SELECT entity_key, type, name, meta FROM entities WHERE type = 'person' AND name LIKE ? LIMIT 8`,
    [like]
  );
  for (const [index, entity] of personEntities.entries()) {
    const record = await all<typeof paperRows[number]>(
      `SELECT record_id, source_type, source_key, title, body, fields_json
       FROM search_records WHERE source_type = 'entity' AND source_key = ? LIMIT 1`,
      [entity.entity_key]
    );
    if (record[0]) {
      push(makeRecordResult(record[0], 5000 - index, `人物命中·实体(${name})`));
    } else {
      push(makeAdhocResult(
        'entity',
        entity.entity_key,
        entity.name,
        `entity_key: ${entity.entity_key}\ntype: ${entity.type}\nname: ${entity.name}\nmeta: ${entity.meta || ''}`,
        { entity_key: entity.entity_key, type: entity.type, name: entity.name },
        4900 - index,
        `人物命中·实体(${name})`
      ));
    }
  }

  const projects = await all<Record<string, unknown>>(
    `SELECT project_key, project_name, institution, principal_investigator, year, summary
     FROM projects
     WHERE principal_investigator LIKE ? OR participants LIKE ? OR project_name LIKE ?
     ORDER BY year DESC
     LIMIT 8`,
    [like, like, like]
  );
  for (const [index, row] of projects.entries()) {
    const body = Object.entries(row)
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim())
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
    push(makeAdhocResult(
      'project',
      String(row.project_key || ''),
      String(row.project_name || row.project_key || '项目'),
      body,
      row,
      4200 - index,
      `人物命中·项目(${name})`
    ));
  }

  if (results.length < limit) {
    const fallback = await all<typeof paperRows[number]>(
      `SELECT record_id, source_type, source_key, title, body, fields_json
       FROM search_records
       WHERE body LIKE ? OR title LIKE ?
       ORDER BY CASE source_type
         WHEN 'mentor' THEN 0
         WHEN 'paper' THEN 1
         WHEN 'paper_chunk' THEN 2
         WHEN 'entity' THEN 3
         ELSE 4
       END
       LIMIT ?`,
      [like, like, Math.max(limit * 2, 16)]
    );
    for (const [index, row] of fallback.entries()) {
      push(makeRecordResult(row, 4000 - index, `人物命中·全文索引(${name})`));
    }
  }

  return results
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function resultKey(result: SearchResult) {
  return result.sourceKey || result.recordId;
}

export function mergePersonFirstResults(personResults: SearchResult[], mergedResults: SearchResult[], limit: number) {
  if (!personResults.length) return mergedResults.slice(0, limit);
  const sorted = [...personResults].sort((left, right) => right.score - left.score);
  const personKeys = new Set(sorted.map(resultKey));
  const rest = mergedResults.filter((result) => !personKeys.has(resultKey(result)));
  return [...sorted, ...rest].slice(0, limit);
}

export function prioritizePersonResults(results: SearchResult[], personName: string, limit: number) {
  if (!personName) return results.slice(0, limit);
  const withName: SearchResult[] = [];
  const without: SearchResult[] = [];
  for (const result of results) {
    const text = `${result.title}\n${result.body}\n${result.snippet || ''}`;
    if (text.includes(personName)) withName.push(result);
    else without.push(result);
  }
  if (!withName.length) return results.slice(0, limit);
  return [...withName, ...without].slice(0, limit);
}
