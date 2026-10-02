import { all } from './db';
import type { SearchResult } from './search-index';
import { extractResearchDirections } from './mentor-retrieval';

const PROJECT_QUERY = /项目|科研|基金|资助|NSFC|负责人|课题|立项|grant/i;

function extractProjectPhrases(query: string, chatContext = '') {
  const haystack = `${query}\n${chatContext}`;
  const phrases = new Set<string>();
  for (const direction of extractResearchDirections(query, chatContext)) {
    phrases.add(direction);
  }
  for (const match of haystack.matchAll(/([\u4e00-\u9fa5]{2,20}(?:系统|能源|基金|计划|项目))/g)) {
    const phrase = match[1].replace(/相关的?$/, '').trim();
    if (phrase.length >= 4) phrases.add(phrase);
  }
  for (const term of ['综合能源', '国家自然科学基金', '国家重点研发', '吉林省科技', '惯量约束', '人工智能大模型']) {
    if (haystack.includes(term)) phrases.add(term);
  }
  for (const line of haystack.split('\n')) {
    const grant = line.match(/^延续资助方:\s*(.+)$/);
    if (grant?.[1]) phrases.add(grant[1].trim());
    const project = line.match(/^延续项目:\s*(.+)$/);
    if (project?.[1]) phrases.add(project[1].trim().slice(0, 40));
  }
  return [...phrases].slice(0, 8);
}

function extractGrantHint(query: string, chatContext = '') {
  const haystack = `${query}\n${chatContext}`;
  const match = haystack.match(/(吉林省|国家自然科学基金|NSFC|福建省|辽宁省)[^\n]{0,20}/);
  return match?.[0]?.trim() || '';
}

export function isProjectQuery(query: string, chatContext = '') {
  if (PROJECT_QUERY.test(query)) return true;
  return /项目|基金|资助/.test(chatContext.slice(-2000)) && /哪些|还有|同资助|负责人|类别/.test(query);
}

function makeProjectResult(row: Record<string, unknown>, score: number, reason: string): SearchResult {
  const body = Object.entries(row)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim())
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  return {
    recordId: `project:${row.project_key}`,
    sourceType: 'project',
    sourceKey: String(row.project_key || ''),
    title: String(row.project_name || row.project_name_en || row.project_key || '项目'),
    body,
    fields: row,
    score,
    snippet: body.slice(0, 420),
    matchReason: reason
  };
}

export async function projectRetrieve(query: string, chatContext = '', limit = 28): Promise<SearchResult[]> {
  if (!isProjectQuery(query, chatContext)) return [];

  const phrases = extractProjectPhrases(query, chatContext);
  const grantHint = extractGrantHint(query, chatContext);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  const pushRows = (rows: Record<string, unknown>[], baseScore: number, reason: string) => {
    for (const [index, row] of rows.entries()) {
      const key = String(row.project_key || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(makeProjectResult(row, baseScore - index, reason));
    }
  };

  for (const phrase of phrases) {
    const rows = await all<Record<string, unknown>>(
      `SELECT project_key, project_name, project_name_en, institution, principal_investigator,
              year, keywords, summary, grant_name, grant_category, amount, currency
       FROM projects
       WHERE project_name LIKE ? OR summary LIKE ? OR keywords LIKE ? OR grant_name LIKE ?
       ORDER BY year DESC LIMIT ?`,
      [`%${phrase}%`, `%${phrase}%`, `%${phrase}%`, `%${phrase}%`, Math.min(limit * 2, 40)]
    );
    pushRows(rows, 5800, `项目检索·${phrase}`);
  }

  if (grantHint) {
    const rows = await all<Record<string, unknown>>(
      `SELECT project_key, project_name, project_name_en, institution, principal_investigator,
              year, keywords, summary, grant_name, grant_category, amount, currency
       FROM projects
       WHERE grant_name LIKE ? OR institution LIKE ? OR summary LIKE ?
       ORDER BY year DESC LIMIT ?`,
      [`%${grantHint}%`, `%${grantHint}%`, `%${grantHint}%`, Math.min(limit * 2, 40)]
    );
    pushRows(rows, 5700, `项目检索·资助方(${grantHint})`);
  }

  const piMatch = query.match(/([\u4e00-\u9fa5]{2,4})负责/) || chatContext.match(/([\u4e00-\u9fa5]{2,4})负责/);
  const piName = piMatch?.[1];
  if (piName) {
    const rows = await all<Record<string, unknown>>(
      `SELECT project_key, project_name, project_name_en, institution, principal_investigator,
              year, keywords, summary, grant_name, grant_category, amount, currency
       FROM projects WHERE principal_investigator LIKE ? ORDER BY year DESC LIMIT ?`,
      [`%${piName}%`, 20]
    );
    pushRows(rows, 5900, `项目检索·负责人(${piName})`);
  }

  if (/这个项目|该项目的|此项目/.test(query)) {
    for (const match of chatContext.matchAll(/《([^》]{6,80})》|「([^」]{6,80})」|([\u4e00-\u9fa5（(]{8,60}研究)/g)) {
      const title = (match[1] || match[2] || match[3] || '').trim();
      if (title.length < 6) continue;
      const rows = await all<Record<string, unknown>>(
        `SELECT project_key, project_name, project_name_en, institution, principal_investigator,
                year, keywords, summary, grant_name, grant_category, amount, currency
         FROM projects WHERE project_name LIKE ? LIMIT 8`,
        [`%${title.slice(0, 24)}%`]
      );
      pushRows(rows, 5950, `项目检索·指代项目`);
    }
  }

  return results.sort((left, right) => right.score - left.score).slice(0, limit);
}

export function mergeProjectFirstResults(projectResults: SearchResult[], mergedResults: SearchResult[], limit: number) {
  if (!projectResults.length) return mergedResults.slice(0, limit);
  const keys = new Set(projectResults.map((r) => r.sourceKey || r.recordId));
  const rest = mergedResults.filter((r) => !keys.has(r.sourceKey) && !keys.has(r.recordId));
  return [...projectResults, ...rest].slice(0, limit);
}
