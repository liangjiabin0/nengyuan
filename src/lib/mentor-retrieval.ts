import { all } from './db';
import type { SearchResult } from './search-index';
import { generateSearchTerms, tokenizeText } from './text';
import { extractInstitutionNames } from './institution-extract';

const TEACHER_PATTERN = /导师|老师|教师|教授|博士生导师|硕士生导师|博导|硕导/;
const CONTINUATION_PATTERN = /还有|哪些|其他|另外|再|继续|以及|还有哪些|有没有别的/;
const DIRECTION_PATTERN = /研究方向[为是：:]\s*([^？?。．,，；;\n]+)|([\u4e00-\u9fa5A-Za-z0-9、与及和]{4,36})方向(?:的)?(?:老师|教师|导师|教授)?/g;

export function isMentorListQuery(query: string) {
  return TEACHER_PATTERN.test(query) && (/哪些|那些|还有|列出|其他|谁|哪位|有没有|多少/.test(query) || DIRECTION_PATTERN.test(query));
}

export function isContinuationQuery(query: string) {
  return CONTINUATION_PATTERN.test(query);
}

export function isMentorContinuationQuery(query: string, chatContext = '') {
  if (TEACHER_PATTERN.test(query)) return true;
  const tail = chatContext.slice(-2800);
  if (!/导师|老师|mentor_profiles|延续导师/.test(tail)) return false;
  return /邮箱|联系方式|电话|列出来|补充|子方向|具体研究|同校|哪位/.test(query)
    || (/他|她/.test(query) && /子方向|具体研究|研究什么/.test(query))
    || (/还有|哪些/.test(query) && /大学|学院/.test(query));
}

export function extractMentorSchoolHint(query: string, chatContext = '') {
  const fromQuery = extractInstitutionNames(query)[0];
  if (fromQuery) return fromQuery;
  for (const line of chatContext.split('\n')) {
    const continued = line.match(/^延续机构:\s*(.+)$/);
    if (continued?.[1]) return extractInstitutionNames(continued[1])[0] || continued[1].trim();
  }
  const priorUserQuestions = [...chatContext.matchAll(/用户:\s*\n?([^\n]+)/g)]
    .map((match) => match[1].trim());
  const priorInstitutions = extractInstitutionNames(priorUserQuestions.at(-1) || '');
  return priorInstitutions.length === 1 ? priorInstitutions[0] : '';
}

export function extractResearchDirections(query: string, chatContext = '') {
  const haystack = `${query}\n${chatContext}`;
  const directions = new Set<string>();

  for (const match of haystack.matchAll(DIRECTION_PATTERN)) {
    const phrase = String(match[1] || match[2] || '').trim();
    if (phrase.length >= 4) {
      directions.add(
        phrase
          .replace(/还有哪些(?:老师|教师|导师|教授)$/, '')
          .replace(/(?:的)?(?:老师|教师|导师|教授)$/, '')
          .replace(/的$/, '')
          .trim()
      );
    }
  }

  for (const match of haystack.matchAll(/人工智能.{0,8}电力系统/g)) {
    directions.add(match[0].trim().replace(/[、,，].*$/, ''));
  }
  for (const match of haystack.matchAll(/涉及([\u4e00-\u9fa5A-Za-z0-9、与及和]{2,20})/g)) {
    const phrase = match[1].replace(/[？?。．,，；;的]+$/, '').trim();
    if (phrase.length >= 2) directions.add(phrase);
  }
  const domainTerms = [
    '虚拟电厂', '综合能源系统', '能源互联网', '数字孪生', '大语言模型', '电力系统',
    '新能源', '配电网', '微电网', '需求响应', '电力市场', 'MMC', 'HVDC', 'VSG', '光热发电',
    '人工智能', 'SiC', '碳化硅', '宽禁带', '功率半导体', '功率器件'
  ];
  for (const term of domainTerms) {
    if (haystack.includes(term)) directions.add(term);
  }

  const blocklist = new Set(['可沿用研究', '共享研究', '本轮焦点', '检索目标', '话题切换']);
  return [...directions]
    .filter((direction) => !blocklist.has(direction))
    .filter((direction) => /人工智能|电力系统|能源|配电网|大模型|虚拟电厂/.test(direction) || direction.length >= 8)
    .slice(0, 6);
}

const TERM_BLOCKLIST = new Set([
  '还有哪些', '老师', '教师', '教授', '导师', '方向', '研究', '什么', '怎么', '用户', '助手',
  'edu', 'cn', 'com', 'http', 'https', 'www', '硕士', '研究生', '大学', '学院', '邮箱'
]);

function normalizeTerms(terms: Iterable<string>) {
  return [...new Set(terms)]
    .filter((term) => term.length >= 2 && term.length <= 24)
    .filter((term) => !TERM_BLOCKLIST.has(term))
    .filter((term) => !/^[为向与及]/.test(term) && !/的$/.test(term) && !/^\d+$/.test(term))
    .slice(0, 12);
}

export function extractMentorSearchTerms(query: string, chatContext = '') {
  const terms = new Set<string>();

  for (const term of tokenizeText(query)) terms.add(term);
  for (const term of generateSearchTerms(query, 1, 12).map((item) => item.term)) terms.add(term);

  for (const direction of extractResearchDirections(query, chatContext)) {
    terms.add(direction);
    for (const part of direction.split(/[、,，/|与及和\s]+/).filter((item) => item.length >= 2)) {
      terms.add(part);
    }
  }

  return normalizeTerms(terms);
}

export function extractCoreDirectionTerms(directions: string[]) {
  const cores = new Set<string>();
  const knownTerms = [
    '人工智能', '电力系统', '虚拟电厂', '大模型', '数字孪生',
    'SiC', '碳化硅', '宽禁带', '功率半导体', '功率器件'
  ];
  for (const direction of directions) {
    for (const term of knownTerms) {
      if (direction.includes(term)) cores.add(term);
    }
  }
  return [...cores];
}

function makeMentorResult(
  row: {
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
  },
  score: number,
  matchReason: string
): SearchResult {
  const body = [
    `mentor_key: ${row.mentor_key}`,
    `name: ${row.name}`,
    `school: ${row.school || ''}`,
    `college: ${row.college || ''}`,
    `major: ${row.major || ''}`,
    `title: ${row.title || ''}`,
    `email: ${row.email || ''}`,
    `file_path: ${row.file_path}`,
    row.content
  ].join('\n');

  return {
    recordId: `mentor:${row.mentor_key}`,
    sourceType: 'mentor',
    sourceKey: row.mentor_key,
    title: `${row.name} · ${row.school || ''} · ${row.college || ''}`,
    body,
    fields: {
      mentor_key: row.mentor_key,
      name: row.name,
      school: row.school,
      college: row.college,
      file_path: row.file_path,
      mentor_match: true
    },
    score,
    snippet: row.content.replace(/\s+/g, ' ').slice(0, 420),
    matchReason
  };
}

function directionMatchesContent(direction: string, content: string) {
  if (content.toLowerCase().includes(direction.toLowerCase())) return true;
  if (/人工智能.{0,8}电力系统|电力系统.{0,8}人工智能/.test(direction)) {
    return /人工智能.{0,8}电力系统|电力系统.{0,8}人工智能|人工智能及其电力系统/.test(content);
  }
  const flexible = direction.replace(/([与和及])/g, '(?:$1|及其)');
  try {
    return new RegExp(flexible).test(content);
  } catch {
    return false;
  }
}

function scoreMentorMatch(content: string, directions: string[], terms: string[]) {
  let score = 0;
  let reason = '';

  for (const [index, direction] of directions.entries()) {
    if (directionMatchesContent(direction, content)) {
      score = Math.max(score, 5780 - index * 20);
      reason = `研究方向精确匹配(${direction})`;
    }
  }

  const coreTerms = terms.filter((term) =>
    /人工智能|电力系统|虚拟电厂|大模型|数字孪生|SiC|碳化硅|宽禁带|功率半导体|功率器件/i.test(term)
  );
  const normalizedContent = content.toLowerCase();
  if (coreTerms.length >= 2 && coreTerms.every((term) => normalizedContent.includes(term.toLowerCase()))) {
    score = Math.max(score, 5400);
    reason = reason || `研究方向关键词共现(${coreTerms.join(' + ')})`;
  } else if (coreTerms.length === 1 && normalizedContent.includes(coreTerms[0].toLowerCase())) {
    score = Math.max(score, 5520);
    reason = reason || `研究方向关键词(${coreTerms[0]})`;
  }

  const hitTerms = terms.filter((term) => normalizedContent.includes(term.toLowerCase()));
  if (hitTerms.length) {
    score = Math.max(score, 4800 + hitTerms.length * 40);
    reason = reason || `导师档案命中(${hitTerms.slice(0, 3).join('、')})`;
  }

  return { score, reason };
}

export async function mentorDirectionRetrieve(query: string, chatContext = '', limit = 30): Promise<SearchResult[]> {
  const directions = extractResearchDirections(query, chatContext);
  const terms = extractMentorSearchTerms(query, chatContext);
  const schoolHint = extractMentorSchoolHint(query, chatContext);
  const mentionedMentors = [...chatContext.matchAll(/([\u4e00-\u9fa5]{2,4})[（(][\u4e00-\u9fa5]{2,12}(?:大学|学院)/g)]
    .map((match) => match[1])
    .filter((name) => name.length >= 2 && name.length <= 4);
  const namedMentor = query.match(/^([\u4e00-\u9fa5]{2,4})导师/)?.[1]
    || query.match(/([\u4e00-\u9fa5]{2,4})导师的研究/)?.[1]
    || chatContext.match(/延续人物:\s*([\u4e00-\u9fa5]{2,4})/)?.[1]
    || chatContext.match(/([\u4e00-\u9fa5]{2,4})[（(][\u4e00-\u9fa5]{2,12}大学/)?.[1];
  if (
    !isMentorListQuery(query)
    && !isMentorContinuationQuery(query, chatContext)
    && !directions.length
    && !terms.length
    && !schoolHint
    && !namedMentor
    && !mentionedMentors.length
  ) {
    return [];
  }

  const coreTerms = extractCoreDirectionTerms(directions);
  if (!directions.length && !terms.length && !schoolHint && !namedMentor && !mentionedMentors.length) return [];

  const queries: Array<{ sql: string; params: unknown[]; reason: string }> = [];

  const mentorNames = [...new Set([namedMentor, ...mentionedMentors].filter(Boolean))] as string[];
  for (const mentorName of mentorNames) {
    queries.push({
      sql: `SELECT mentor_key, name, school, college, major, email, phone, title, file_path, content
            FROM mentor_profiles WHERE name = ? OR name LIKE ? OR content LIKE ?
            LIMIT 12`,
      params: [mentorName, `%${mentorName}%`, `%${mentorName}%`],
      reason: `named-mentor:${mentorName}`
    });
  }

  for (const direction of directions) {
    queries.push({
      sql: 'SELECT mentor_key, name, school, college, major, email, phone, title, file_path, content FROM mentor_profiles WHERE content LIKE ? LIMIT 40',
      params: [`%${direction}%`],
      reason: `exact-direction:${direction}`
    });
  }

  if (coreTerms.length >= 2) {
    const where = coreTerms.map(() => 'content LIKE ?').join(' AND ');
    queries.push({
      sql: `SELECT mentor_key, name, school, college, major, email, phone, title, file_path, content FROM mentor_profiles WHERE ${where} LIMIT 60`,
      params: coreTerms.map((term) => `%${term}%`),
      reason: `core-and:${coreTerms.join('+')}`
    });
  } else if (coreTerms.length === 1) {
    queries.push({
      sql: 'SELECT mentor_key, name, school, college, major, email, phone, title, file_path, content FROM mentor_profiles WHERE content LIKE ? LIMIT 80',
      params: [`%${coreTerms[0]}%`],
      reason: `core-single:${coreTerms[0]}`
    });
  }

  if (schoolHint) {
    queries.push({
      sql: 'SELECT mentor_key, name, school, college, major, email, phone, title, file_path, content FROM mentor_profiles WHERE school LIKE ? OR college LIKE ? OR content LIKE ? LIMIT 60',
      params: [`%${schoolHint}%`, `%${schoolHint}%`, `%${schoolHint}%`],
      reason: `school:${schoolHint}`
    });
    if (coreTerms.length >= 1) {
      const coreWhere = coreTerms.map(() => 'content LIKE ?').join(' AND ');
      queries.push({
        sql: `SELECT mentor_key, name, school, college, major, email, phone, title, file_path, content
              FROM mentor_profiles
              WHERE (school LIKE ? OR college LIKE ?) AND ${coreWhere}
              LIMIT 24`,
        params: [`%${schoolHint}%`, `%${schoolHint}%`, ...coreTerms.map((term) => `%${term}%`)],
        reason: `school-core:${schoolHint}+${coreTerms.join('+')}`
      });
    }
  }

  const fallbackTerms = terms.filter((term) => !coreTerms.includes(term)).slice(0, 6);
  if (fallbackTerms.length) {
    const where = fallbackTerms.map(() => 'content LIKE ?').join(' OR ');
    queries.push({
      sql: `SELECT mentor_key, name, school, college, major, email, phone, title, file_path, content FROM mentor_profiles WHERE ${where} LIMIT 40`,
      params: fallbackTerms.map((term) => `%${term}%`),
      reason: `fallback-or:${fallbackTerms.join('|')}`
    });
  }

  const rowMap = new Map<string, {
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
    queryReason: string;
  }>();

  for (const entry of queries) {
    const rows = await all<Omit<typeof rowMap extends Map<string, infer V> ? V : never, 'queryReason'>>(entry.sql, entry.params);
    for (const row of rows) {
      if (!rowMap.has(row.mentor_key)) {
        rowMap.set(row.mentor_key, { ...row, queryReason: entry.reason });
      }
    }
  }

  const scored = [...rowMap.values()]
    .filter((row) =>
      !schoolHint || `${row.school || ''}${row.college || ''}`.includes(schoolHint)
    )
    .map((row) => {
      const { score, reason } = scoreMentorMatch(row.content, directions, [...terms, ...coreTerms]);
      let boosted = row.queryReason.startsWith('exact-direction:') ? score + 120 : row.queryReason.startsWith('core-and:') ? score + 60 : score;
      if (row.queryReason.startsWith('core-single:')) boosted = Math.max(boosted, score + 80);
      if (row.queryReason.startsWith('named-mentor:')) boosted = Math.max(boosted, 5800);
      if (mentorNames.some((mentorName) => row.name.includes(mentorName))) boosted = Math.max(boosted, 5900);
      if (schoolHint && (`${row.school}${row.college}`).includes(schoolHint)) boosted += 100;
      if (row.queryReason.startsWith('school-core:')) boosted = Math.max(boosted, 5920);
      if (
        schoolHint
        && coreTerms.length >= 2
        && coreTerms.every((term) => row.content.includes(term))
        && (`${row.school}${row.college}`).includes(schoolHint)
      ) {
        boosted = Math.max(boosted, 5910);
      }
      const finalReason = reason || `导师方向检索(${row.queryReason})`;
      const sqlMatched = /^(exact-direction|core-and|core-single|school|school-core):/.test(row.queryReason);
      const finalScore = sqlMatched ? Math.max(boosted, 5650) : boosted;
      return finalScore > 0 || sqlMatched ? makeMentorResult(row, finalScore, finalReason) : null;
    })
    .filter((item): item is SearchResult => Boolean(item))
    .sort((left, right) => {
      const leftMentioned = mentionedMentors.some((name) => left.title.includes(name)) ? 1 : 0;
      const rightMentioned = mentionedMentors.some((name) => right.title.includes(name)) ? 1 : 0;
      if (rightMentioned !== leftMentioned) return rightMentioned - leftMentioned;
      return right.score - left.score;
    });

  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const item of scored) {
    if (seen.has(item.sourceKey)) continue;
    seen.add(item.sourceKey);
    unique.push(item);
    if (unique.length >= limit) break;
  }

  return unique;
}

export function mergeMentorFirstResults(mentorResults: SearchResult[], mergedResults: SearchResult[], limit: number) {
  if (!mentorResults.length) return mergedResults.slice(0, limit);
  const mentorIds = new Set(mentorResults.map((result) => result.recordId));
  const rest = mergedResults.filter((result) => !mentorIds.has(result.recordId));
  return [...mentorResults, ...rest].slice(0, limit);
}
