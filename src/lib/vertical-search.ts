import { all, get } from './db';
import { personRetrieve } from './person-retrieval';
import { projectRetrieve } from './project-retrieval';
import { readPaperBodyText } from './paper-body';
import { stampResult } from './content-provenance';
import type { SearchResult } from './search-index';

export type VerticalAnchorType = 'paper' | 'mentor' | 'project' | 'person' | 'auto';
export type VerticalInclude =
  | 'profile'
  | 'body_chunks'
  | 'body_full'
  | 'references'
  | 'citations'
  | 'related_projects'
  | 'related_papers'
  | 'graph';

export type VerticalSearchOptions = {
  anchor: string;
  anchorType?: VerticalAnchorType;
  query?: string;
  include?: VerticalInclude[];
  limit?: number;
};

function asResult(
  partial: Omit<SearchResult, 'score' | 'snippet'> & { score?: number; snippet?: string }
): SearchResult {
  return stampResult({
    recordId: partial.recordId,
    sourceType: partial.sourceType,
    sourceKey: partial.sourceKey,
    title: partial.title,
    body: partial.body,
    fields: partial.fields,
    score: partial.score ?? 5000,
    snippet: (partial.snippet || partial.body).replace(/\s+/g, ' ').slice(0, 420),
    matchReason: partial.matchReason || '纵向检索'
  });
}

async function resolvePaper(anchor: string) {
  return get<Record<string, unknown>>(
    'SELECT * FROM paper_documents WHERE paper_key = ? OR title LIKE ? ORDER BY updated_at DESC LIMIT 1',
    [anchor, `%${anchor.slice(0, 80)}%`]
  );
}

async function resolveMentor(anchor: string) {
  return get<Record<string, unknown>>(
    'SELECT * FROM mentor_profiles WHERE mentor_key = ? OR name LIKE ? LIMIT 1',
    [anchor, `%${anchor}%`]
  );
}

async function resolveProject(anchor: string) {
  return get<Record<string, unknown>>(
    'SELECT * FROM projects WHERE project_key = ? OR project_name LIKE ? ORDER BY year DESC LIMIT 1',
    [anchor, `%${anchor.slice(0, 60)}%`]
  );
}

function detectAnchorType(anchor: string, hint?: VerticalAnchorType): VerticalAnchorType {
  if (hint && hint !== 'auto') return hint;
  if (anchor.startsWith('paper:')) return 'paper';
  if (anchor.startsWith('mentor:') || /老师|教授|导师/.test(anchor)) return 'mentor';
  if (anchor.startsWith('project:') || /项目/.test(anchor)) return 'project';
  if (/《.+》/.test(anchor) || anchor.length > 12) return 'paper';
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(anchor)) return 'person';
  return 'paper';
}

async function verticalPaper(anchor: string, include: Set<VerticalInclude>, subQuery: string, limit: number) {
  const paper = await resolvePaper(anchor);
  if (!paper) return { results: [] as SearchResult[], graphSeedIds: [] as string[], summary: '未找到论文' };

  const paperKey = String(paper.paper_key);
  const results: SearchResult[] = [];
  const graphSeedIds = [paperKey];

  if (include.has('profile')) {
    results.push(asResult({
      recordId: `paper:${paperKey}`,
      sourceType: 'paper',
      sourceKey: paperKey,
      title: String(paper.title),
      body: [paper.authors, paper.abstract, paper.keywords].filter(Boolean).join('\n'),
      fields: { ...paper, contentKind: 'paper_abstract' },
      matchReason: '纵向·论文元数据'
    }));
  }

  if (include.has('body_full')) {
    const full = await readPaperBodyText(paperKey);
    if (full) {
      results.push(asResult({
        recordId: `paper:${paperKey}:fullbody`,
        sourceType: 'paper_chunk',
        sourceKey: paperKey,
        title: `${full.title} · 正文全文`,
        body: full.text,
        fields: { paper_key: paperKey, contentKind: 'paper_body_full', truncated: full.truncated, sectionCount: full.sectionCount },
        matchReason: '纵向·正文全文'
      }));
    }
  }

  if (include.has('body_chunks')) {
    const like = subQuery ? `%${subQuery.slice(0, 40)}%` : '%';
    const chunks = await all<Record<string, unknown>>(
      `SELECT c.chunk_key, c.text, c.section, c.chunk_role, c.chunk_index, p.title
       FROM paper_chunks c JOIN paper_documents p ON p.paper_key = c.paper_key
       WHERE c.paper_key = ? AND c.chunk_role = 'child'
         AND c.section != '参考文献' AND c.text LIKE ?
       ORDER BY c.chunk_index LIMIT ?`,
      [paperKey, like, limit]
    );
    for (const [i, row] of chunks.entries()) {
      results.push(asResult({
        recordId: `paper_chunk:${row.chunk_key}`,
        sourceType: 'paper_chunk',
        sourceKey: String(row.chunk_key),
        title: `${row.title} · ${row.section || '正文'}`,
        body: String(row.text),
        fields: row,
        score: 4800 - i,
        matchReason: '纵向·论文章节'
      }));
    }
  }

  if (include.has('references')) {
    const refs = await all<Record<string, unknown>>(
      `SELECT chunk_key, text FROM paper_chunks
       WHERE paper_key = ? AND (chunk_role = 'reference' OR section = '参考文献') LIMIT ?`,
      [paperKey, limit]
    );
    for (const [i, row] of refs.entries()) {
      results.push(asResult({
        recordId: `paper_ref:${row.chunk_key}`,
        sourceType: 'paper_reference',
        sourceKey: String(row.chunk_key),
        title: `${paper.title} · 参考文献`,
        body: String(row.text),
        fields: { ...row, paper_key: paperKey, contentKind: 'paper_reference' },
        score: 3000 - i,
        matchReason: '纵向·参考文献'
      }));
    }
  }

  if (include.has('citations') || include.has('graph')) {
    const edges = await all<Record<string, unknown>>(
      `SELECT source_key, target_key, relation, weight FROM edges
       WHERE source_key = ? OR target_key = ? ORDER BY weight DESC LIMIT ?`,
      [paperKey, paperKey, limit]
    );
    for (const [i, edge] of edges.entries()) {
      results.push(asResult({
        recordId: `edge:${edge.source_key}:${edge.target_key}`,
        sourceType: 'graph_edge',
        sourceKey: String(edge.target_key),
        title: `引用关系 · ${edge.relation}`,
        body: `${edge.source_key} --${edge.relation}--> ${edge.target_key}`,
        fields: edge,
        score: 2500 - i,
        matchReason: '纵向·引用图谱'
      }));
      graphSeedIds.push(String(edge.target_key));
    }
  }

  return {
    results,
    graphSeedIds: [...new Set(graphSeedIds)],
    summary: `论文「${paper.title}」纵向 ${results.length} 条`
  };
}

async function verticalMentor(anchor: string, include: Set<VerticalInclude>, subQuery: string, limit: number) {
  const mentor = await resolveMentor(anchor);
  if (!mentor) return { results: [] as SearchResult[], graphSeedIds: [] as string[], summary: '未找到导师' };

  const results: SearchResult[] = [];
  const name = String(mentor.name || '');

  if (include.has('profile')) {
    results.push(asResult({
      recordId: `mentor:${mentor.mentor_key}`,
      sourceType: 'mentor',
      sourceKey: String(mentor.mentor_key),
      title: `${name} · ${mentor.school || ''}`,
      body: String(mentor.content || ''),
      fields: mentor,
      matchReason: '纵向·导师档案'
    }));
  }

  if (include.has('related_projects')) {
    const projects = await all<Record<string, unknown>>(
      'SELECT * FROM projects WHERE principal_investigator LIKE ? ORDER BY year DESC LIMIT ?',
      [`%${name}%`, limit]
    );
    for (const [i, row] of projects.entries()) {
      results.push(asResult({
        recordId: `project:${row.project_key}`,
        sourceType: 'project',
        sourceKey: String(row.project_key),
        title: String(row.project_name),
        body: JSON.stringify(row),
        fields: row,
        score: 4000 - i,
        matchReason: '纵向·导师项目'
      }));
    }
  }

  if (include.has('related_papers') || include.has('body_chunks')) {
    const like = subQuery ? `%${subQuery}%` : `%${name}%`;
    const chunks = await all<Record<string, unknown>>(
      `SELECT c.chunk_key, c.text, c.section, p.title, p.paper_key
       FROM paper_chunks c JOIN paper_documents p ON p.paper_key = c.paper_key
       WHERE c.chunk_role = 'child' AND c.text LIKE ? LIMIT ?`,
      [like, limit]
    );
    for (const [i, row] of chunks.entries()) {
      results.push(asResult({
        recordId: `paper_chunk:${row.chunk_key}`,
        sourceType: 'paper_chunk',
        sourceKey: String(row.chunk_key),
        title: `${row.title} · 提及 ${name}`,
        body: String(row.text),
        fields: row,
        score: 3500 - i,
        matchReason: '纵向·相关论文片段'
      }));
    }
  }

  return { results, graphSeedIds: [], summary: `导师「${name}」纵向 ${results.length} 条` };
}

async function verticalProject(anchor: string, include: Set<VerticalInclude>, limit: number) {
  const project = await resolveProject(anchor);
  if (!project) return { results: [] as SearchResult[], graphSeedIds: [] as string[], summary: '未找到项目' };

  const results: SearchResult[] = [];
  if (include.has('profile')) {
    results.push(asResult({
      recordId: `project:${project.project_key}`,
      sourceType: 'project',
      sourceKey: String(project.project_key),
      title: String(project.project_name),
      body: JSON.stringify(project),
      fields: project,
      matchReason: '纵向·项目档案'
    }));
  }

  const pi = String(project.principal_investigator || '');
  if (pi && include.has('related_papers')) {
    const chunks = await all<Record<string, unknown>>(
      `SELECT c.chunk_key, c.text, p.title FROM paper_chunks c
       JOIN paper_documents p ON p.paper_key = c.paper_key
       WHERE c.text LIKE ? LIMIT ?`,
      [`%${pi}%`, limit]
    );
    for (const [i, row] of chunks.entries()) {
      results.push(asResult({
        recordId: `paper_chunk:${row.chunk_key}`,
        sourceType: 'paper_chunk',
        sourceKey: String(row.chunk_key),
        title: String(row.title),
        body: String(row.text),
        fields: row,
        score: 3200 - i,
        matchReason: '纵向·项目相关论文'
      }));
    }
  }

  return { results, graphSeedIds: [], summary: `项目「${project.project_name}」纵向 ${results.length} 条` };
}

async function verticalPerson(anchor: string, include: Set<VerticalInclude>, subQuery: string, limit: number) {
  const name = anchor.replace(/老师|教授|导师/g, '').trim();
  const personHits = await personRetrieve(subQuery || anchor, limit, name);
  const results: SearchResult[] = personHits.map((r, i) => stampResult({
    ...r,
    score: r.score || 4500 - i,
    matchReason: '纵向·人物'
  }));

  if (include.has('related_projects')) {
    const projects = await projectRetrieve(name, '', limit);
    for (const [i, row] of projects.entries()) {
      results.push(asResult({
        recordId: row.recordId,
        sourceType: row.sourceType,
        sourceKey: row.sourceKey,
        title: row.title,
        body: row.body,
        fields: row.fields,
        score: 3800 - i,
        matchReason: '纵向·人物项目'
      }));
    }
  }

  return { results, graphSeedIds: [], summary: `人物「${name}」纵向 ${results.length} 条` };
}

export async function verticalSearch(options: VerticalSearchOptions) {
  const anchor = String(options.anchor || '').trim();
  const anchorType = detectAnchorType(anchor, options.anchorType);
  const subQuery = String(options.query || '').trim();
  const limit = Math.min(32, Math.max(4, options.limit || 16));
  const include = new Set<VerticalInclude>(
    options.include?.length
      ? options.include
      : ['profile', 'body_chunks', 'references', 'citations']
  );

  if (!anchor) {
    return { results: [], graphSeedIds: [], summary: '缺少锚点 anchor', anchorType };
  }

  if (anchorType === 'mentor') return { ...(await verticalMentor(anchor, include, subQuery, limit)), anchorType };
  if (anchorType === 'project') return { ...(await verticalProject(anchor, include, limit)), anchorType };
  if (anchorType === 'person') return { ...(await verticalPerson(anchor, include, subQuery, limit)), anchorType };
  return { ...(await verticalPaper(anchor, include, subQuery, limit)), anchorType };
}
