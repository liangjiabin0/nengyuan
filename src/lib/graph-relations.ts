import { all } from './db';
import { expandSubgraph } from './kg/graph-engine';
import { isMeaningfulTermName, normalizeTermName } from './kg/term-quality';

export type GraphNode = {
  key: string;
  label: string;
  type: 'paper' | 'mentor' | 'project' | 'entity' | 'unknown';
  entityType?: string;
  cluster?: number;
  clusterLabel?: string;
};

export type GraphEdge = {
  source: string;
  target: string;
  relation: string;
  weight: number;
};

export type GraphRelations = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hops?: number;
  seeds?: string[];
  clusters?: GraphCluster[];
};

export type GraphCluster = {
  id: number;
  label: string;
  nodeKeys: string[];
};

const GRAPH_CLUSTER_COUNT = 7;
const GRAPH_MIN_KEYWORDS_PER_CLUSTER = 6;
const GRAPH_TERMS_PER_PAPER = 48;

export type GraphPaperResult = {
  paperKey: string;
  title: string;
  authors: string;
  updatedAt: string;
};

export type GraphPaperPage = {
  papers: GraphPaperResult[];
  total: number;
  page: number;
  pageSize: number;
};

type TermRow = {
  source_key: string;
  term_key: string;
  type: string;
  name: string;
  weight: number;
};

function termTypeRank(type: string) {
  return type === 'keyword' ? 0 : type === 'discipline' ? 1 : 2;
}

function buildCooccurrencePairs(termsBySource: Map<string, TermRow[]>, termKeys: Set<string>, termsPerSource: number) {
  const pairWeights = new Map<string, { source: string; target: string; weight: number }>();
  for (const sourceTerms of termsBySource.values()) {
    const terms = [...sourceTerms]
      .filter((row) => termKeys.has(row.term_key))
      .sort((a, b) => termTypeRank(a.type) - termTypeRank(b.type) || b.weight - a.weight)
      .slice(0, termsPerSource);
    for (let left = 0; left < terms.length; left += 1) {
      for (let right = left + 1; right < terms.length; right += 1) {
        const [source, target] = [terms[left].term_key, terms[right].term_key].sort();
        const pairKey = `${source}\u0000${target}`;
        const current = pairWeights.get(pairKey);
        const weight = Math.max(1, Math.min(terms[left].weight, terms[right].weight));
        pairWeights.set(pairKey, { source, target, weight: (current?.weight || 0) + weight });
      }
    }
  }
  return pairWeights;
}

function mergeTermRows(target: Map<string, TermRow>, rows: TermRow[]) {
  for (const row of rows) {
    if (!isMeaningfulTermName(row.name, row.type)) continue;
    const normalized = { ...row, name: normalizeTermName(row.name) };
    const key = `${normalized.source_key}\u0000${normalized.term_key}`;
    const current = target.get(key);
    if (!current || normalized.weight > current.weight) target.set(key, normalized);
  }
}

function rankExpansionTermKeys(rows: TermRow[], excluded: Set<string>, limit: number) {
  const scores = new Map<string, { key: string; type: string; weight: number; sources: Set<string> }>();
  for (const row of rows) {
    if (excluded.has(row.term_key) || !isMeaningfulTermName(row.name, row.type)) continue;
    const current = scores.get(row.term_key) || {
      key: row.term_key,
      type: row.type,
      weight: 0,
      sources: new Set<string>()
    };
    current.weight += Math.max(1, row.weight);
    current.sources.add(row.source_key);
    scores.set(row.term_key, current);
  }
  return [...scores.values()]
    .sort((left, right) =>
      termTypeRank(left.type) - termTypeRank(right.type)
      || right.sources.size - left.sources.size
      || right.weight - left.weight
    )
    .slice(0, limit)
    .map((item) => item.key);
}

function selectConnectedTermKeys(
  pairWeights: Map<string, { source: string; target: string; weight: number }>,
  preferredRoots: string[],
  maxSize: number
) {
  const edges = [...pairWeights.values()].sort((left, right) => right.weight - left.weight);
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + edge.weight);
    degree.set(edge.target, (degree.get(edge.target) || 0) + edge.weight);
  }

  const root = preferredRoots.find((key) => degree.has(key))
    || [...degree.keys()].sort((left, right) => (degree.get(right) || 0) - (degree.get(left) || 0))[0];
  const selected = new Set<string>();
  if (!root) return selected;
  selected.add(root);

  while (selected.size < maxSize) {
    let best: { key: string; score: number } | null = null;
    for (const edge of edges) {
      const sourceSelected = selected.has(edge.source);
      const targetSelected = selected.has(edge.target);
      if (sourceSelected === targetSelected) continue;
      const key = sourceSelected ? edge.target : edge.source;
      const score = edge.weight * 1000 + (degree.get(key) || 0);
      if (!best || score > best.score) best = { key, score };
    }
    if (!best) break;
    selected.add(best.key);
  }

  return selected;
}

function selectConnectedEdges(
  pairWeights: Map<string, { source: string; target: string; weight: number }>,
  keepKeys: Set<string>,
  minCount: number,
  edgeLimit: number
) {
  const candidates = [...pairWeights.values()]
    .filter((edge) => keepKeys.has(edge.source) && keepKeys.has(edge.target))
    .sort((left, right) => right.weight - left.weight);
  const parent = new Map<string, string>([...keepKeys].map((key) => [key, key]));
  const findRoot = (key: string): string => {
    const current = parent.get(key) || key;
    if (current === key) return key;
    const root = findRoot(current);
    parent.set(key, root);
    return root;
  };
  const backbone: typeof candidates = [];
  const backboneKeys = new Set<string>();

  for (const edge of candidates) {
    const sourceRoot = findRoot(edge.source);
    const targetRoot = findRoot(edge.target);
    if (sourceRoot === targetRoot) continue;
    parent.set(sourceRoot, targetRoot);
    backbone.push(edge);
    backboneKeys.add(`${edge.source}\u0000${edge.target}`);
  }

  const supplemental = candidates.filter((edge) =>
    edge.weight >= Math.max(1, minCount)
    && !backboneKeys.has(`${edge.source}\u0000${edge.target}`)
  );
  return [...backbone, ...supplemental].slice(0, edgeLimit);
}

function uniqueKeys(keys: string[], limit: number) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of keys) {
    const value = String(key || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

async function fetchLabels(keys: string[]) {
  if (!keys.length) return new Map<string, GraphNode>();
  const placeholders = keys.map(() => '?').join(',');
  const labels = new Map<string, GraphNode>();

  const papers = await all<{ paper_key: string; title: string }>(
    `SELECT paper_key, title FROM paper_documents WHERE paper_key IN (${placeholders})`,
    keys
  );
  for (const paper of papers) {
    labels.set(paper.paper_key, { key: paper.paper_key, label: paper.title || paper.paper_key, type: 'paper' });
  }

  const mentors = await all<{ mentor_key: string; name: string; school?: string }>(
    `SELECT mentor_key, name, school FROM mentor_profiles WHERE mentor_key IN (${placeholders})`,
    keys
  );
  for (const mentor of mentors) {
    const suffix = mentor.school ? ` · ${mentor.school}` : '';
    labels.set(mentor.mentor_key, { key: mentor.mentor_key, label: `${mentor.name}${suffix}`, type: 'mentor' });
  }

  const projects = await all<{ project_key: string; project_name?: string }>(
    `SELECT project_key, project_name FROM projects WHERE project_key IN (${placeholders})`,
    keys
  );
  for (const project of projects) {
    labels.set(project.project_key, {
      key: project.project_key,
      label: project.project_name || project.project_key,
      type: 'project'
    });
  }

  const entities = await all<{ entity_key: string; type: string; name: string }>(
    `SELECT entity_key, type, name FROM entities WHERE entity_key IN (${placeholders})`,
    keys
  );
  for (const entity of entities) {
    labels.set(entity.entity_key, {
      key: entity.entity_key,
      label: entity.name || entity.entity_key,
      type: 'entity',
      entityType: entity.type
    });
  }

  return labels;
}

function assignTermClusters(nodes: GraphNode[], edges: GraphEdge[]) {
  if (!nodes.length) return { nodes, clusters: [] as GraphCluster[] };
  const adjacency = new Map<string, Map<string, number>>();
  const degree = new Map<string, number>();
  for (const node of nodes) adjacency.set(node.key, new Map());
  for (const edge of edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
    adjacency.get(edge.source)!.set(edge.target, (adjacency.get(edge.source)!.get(edge.target) || 0) + edge.weight);
    adjacency.get(edge.target)!.set(edge.source, (adjacency.get(edge.target)!.get(edge.source) || 0) + edge.weight);
    degree.set(edge.source, (degree.get(edge.source) || 0) + edge.weight);
    degree.set(edge.target, (degree.get(edge.target) || 0) + edge.weight);
  }

  const clusterCount = Math.min(
    nodes.length,
    nodes.length >= GRAPH_CLUSTER_COUNT * GRAPH_MIN_KEYWORDS_PER_CLUSTER
      ? GRAPH_CLUSTER_COUNT
      : Math.max(3, Math.floor(nodes.length / GRAPH_MIN_KEYWORDS_PER_CLUSTER))
  );
  const rankedKeys = nodes.map((node) => node.key).sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0));
  const anchors: string[] = [];
  while (anchors.length < clusterCount && anchors.length < rankedKeys.length) {
    const remaining = rankedKeys.filter((key) => !anchors.includes(key));
    remaining.sort((a, b) => {
      const strongestAnchorLink = (key: string) => Math.max(0, ...anchors.map((anchor) => adjacency.get(key)?.get(anchor) || 0));
      const aScore = (degree.get(a) || 0) / (1 + strongestAnchorLink(a) * 3);
      const bScore = (degree.get(b) || 0) / (1 + strongestAnchorLink(b) * 3);
      return bScore - aScore;
    });
    if (remaining[0]) anchors.push(remaining[0]);
    else break;
  }

  const assignment = new Map<string, number>();
  anchors.forEach((key, index) => assignment.set(key, index));
  const clusterSizes = Array.from({ length: anchors.length }, () => 1);
  const maxClusterSize = Math.max(
    GRAPH_MIN_KEYWORDS_PER_CLUSTER + 2,
    Math.ceil((nodes.length / Math.max(1, anchors.length)) * 2.4)
  );
  const unassigned = new Set(nodes.map((node) => node.key).filter((key) => !assignment.has(key)));
  for (let round = 0; round < nodes.length && unassigned.size; round += 1) {
    const pending: Array<{ key: string; scores: Array<[number, number]>; score: number }> = [];
    for (const key of unassigned) {
      const scores = new Map<number, number>();
      for (const [neighbor, weight] of adjacency.get(key) || []) {
        const cluster = assignment.get(neighbor);
        if (cluster === undefined) continue;
        scores.set(cluster, (scores.get(cluster) || 0) + weight);
      }
      const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
      if (ranked[0]) pending.push({ key, scores: ranked, score: ranked[0][1] });
    }
    if (!pending.length) break;
    pending.sort((a, b) => b.score - a.score);
    for (const item of pending) {
      const available = item.scores.find(([cluster]) => clusterSizes[cluster] < maxClusterSize);
      const cluster = available?.[0] ?? clusterSizes.indexOf(Math.min(...clusterSizes));
      assignment.set(item.key, cluster);
      clusterSizes[cluster] += 1;
      unassigned.delete(item.key);
    }
  }

  for (const key of unassigned) {
    const smallest = clusterSizes.indexOf(Math.min(...clusterSizes));
    assignment.set(key, smallest);
    clusterSizes[smallest] += 1;
  }

  const labels = new Map<number, string>();
  const clusters: GraphCluster[] = anchors.map((_, id) => {
    const members = nodes
      .filter((node) => assignment.get(node.key) === id)
      .sort((a, b) => (degree.get(b.key) || 0) - (degree.get(a.key) || 0));
    const label = members.slice(0, 5).map((node) => node.label).join(' · ') || `方向 ${id + 1}`;
    labels.set(id, label);
    return { id, label, nodeKeys: members.map((node) => node.key) };
  });

  return {
    nodes: nodes.map((node) => {
      const cluster = assignment.get(node.key) || 0;
      return { ...node, cluster, clusterLabel: labels.get(cluster) };
    }),
    clusters
  };
}

export type FetchGraphOptions = {
  hops?: number;
  limit?: number;
  relations?: string[];
  types?: string[];
};

export async function fetchGraphRelations(
  seedKeys: string[],
  limitOrOptions: number | FetchGraphOptions = 40
): Promise<GraphRelations> {
  const options: FetchGraphOptions =
    typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : limitOrOptions || {};
  const hops = Math.min(3, Math.max(1, options.hops ?? 1));
  const limit = Math.min(300, Math.max(1, options.limit ?? 40));
  const seeds = uniqueKeys(seedKeys, 40);

  const expanded = await expandSubgraph({
    seeds,
    hops,
    limit,
    relations: options.relations
  });

  let edges = expanded.edges;
  let nodeKeys = uniqueKeys([...seeds, ...expanded.nodeKeys], 240);

  if (options.types?.length) {
    const labelsPreview = await fetchLabels(nodeKeys);
    const allowed = new Set(options.types);
    nodeKeys = nodeKeys.filter((key) => {
      if (seeds.includes(key)) return true;
      const node = labelsPreview.get(key);
      if (!node) return allowed.has('unknown');
      if (node.type === 'entity') return allowed.has('entity') || (node.entityType ? allowed.has(node.entityType) : false);
      return allowed.has(node.type);
    });
    const keep = new Set(nodeKeys);
    edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  }

  const labels = await fetchLabels(nodeKeys);
  return {
    nodes: nodeKeys.map((key) => labels.get(key) || { key, label: key, type: 'unknown' }),
    edges,
    hops,
    seeds
  };
}

/**
 * 将论文/项目共同标注的关键词折叠为术语共现网络。
 * 论文等业务记录只作为隐含连接依据，不再充当唯一中心节点。
 */
export async function fetchTermCooccurrenceGraph(query = '', limit = 100, yearFrom?: number, yearTo?: number, minCount = 1): Promise<GraphRelations> {
  const nodeLimit = Math.min(200, Math.max(30, Math.round(limit)));
  const edgeLimit = Math.min(520, Math.max(90, limit * 3));
  const normalizedQuery = normalizeTermName(query);
  const queryParts = [...new Set([
    normalizedQuery,
    ...normalizedQuery.split(/[\s,，、;；|/]+/u)
  ].map((part) => part.trim()).filter((part) => part.length >= 2))].slice(0, 6);

  let seedRows: Array<{ entity_key: string; type: string; name: string }> = [];
  if (queryParts.length) {
    const clauses = queryParts.map(() => 'name LIKE ?').join(' OR ');
    seedRows = await all<{ entity_key: string; type: string; name: string }>(
      `SELECT entity_key, type, name
       FROM entities
       WHERE type IN ('keyword', 'discipline')
         AND (${clauses})
       LIMIT 80`,
      queryParts.map((part) => `%${part}%`)
    );
    seedRows = seedRows
      .filter((row) => isMeaningfulTermName(row.name, row.type))
      .sort((a, b) => {
        const aName = normalizeTermName(a.name).toLowerCase();
        const bName = normalizeTermName(b.name).toLowerCase();
        const target = normalizedQuery.toLowerCase();
        const rank = (name: string) => name === target ? 0 : name.startsWith(target) ? 1 : name.includes(target) ? 2 : 3;
        const typeRank = (type: string) => type === 'keyword' ? 0 : type === 'discipline' ? 1 : 2;
        return rank(aName) - rank(bName) || typeRank(a.type) - typeRank(b.type) || aName.length - bName.length;
      })
      .slice(0, 10);
  }

  const primarySeedRows = seedRows.slice(0, 1);
  const seedKeys = primarySeedRows.map((row) => row.entity_key);
  const termsPerPaper = seedKeys.length ? GRAPH_TERMS_PER_PAPER : 28;
  const yearClauses: string[] = [];
  const yearParams: number[] = [];
  if (yearFrom) {
    yearClauses.push('publish_year >= ?');
    yearParams.push(yearFrom);
  }
  if (yearTo) {
    yearClauses.push('publish_year <= ?');
    yearParams.push(yearTo);
  }
  const sourceYearScope = yearClauses.length
    ? `AND ed.source_key IN (SELECT paper_key FROM paper_documents WHERE ${yearClauses.join(' AND ')})`
    : '';

  const loadRowsForTerms = async (scopeKeys: string[]) => {
    const sourceScope = scopeKeys.length
      ? `AND ed.source_key IN (
           SELECT DISTINCT source_key
           FROM edges
           WHERE target_key IN (${scopeKeys.map(() => '?').join(',')})
             AND relation IN ('has_keyword', 'in_discipline')
         )`
      : '';
    return all<TermRow>(
      `SELECT ed.source_key, ed.target_key AS term_key, e.type, e.name, ed.weight
       FROM edges ed
       JOIN entities e ON e.entity_key = ed.target_key
       WHERE e.type IN ('keyword', 'discipline')
         AND ed.relation IN ('has_keyword', 'in_discipline')
         ${sourceScope}
         ${sourceYearScope}
       ORDER BY CASE e.type WHEN 'keyword' THEN 0 WHEN 'discipline' THEN 1 ELSE 2 END, ed.weight DESC
       LIMIT 6000`,
      [...scopeKeys, ...yearParams]
    );
  };

  const rowMap = new Map<string, TermRow>();
  if (seedKeys.length) {
    const expandedScopes = new Set(seedKeys);
    let frontier = [...seedKeys];
    const targetTermCount = Math.min(nodeLimit, Math.max(45, Math.round(limit * 0.8)));

    for (let depth = 0; depth < 4 && frontier.length; depth += 1) {
      mergeTermRows(rowMap, await loadRowsForTerms(frontier));
      const mergedRows = [...rowMap.values()];
      const visibleTermCount = new Set(mergedRows.map((row) => row.term_key)).size;
      if (depth >= 1 && visibleTermCount >= targetTermCount) break;
      frontier = rankExpansionTermKeys(mergedRows, expandedScopes, depth === 0 ? 20 : 14);
      for (const key of frontier) expandedScopes.add(key);
    }
  } else {
    mergeTermRows(rowMap, await loadRowsForTerms([]));
  }
  if (!rowMap.size) mergeTermRows(rowMap, await loadRowsForTerms([]));
  const rows = [...rowMap.values()];

  const termsBySource = new Map<string, TermRow[]>();
  const termByKey = new Map<string, TermRow>();
  for (const row of rows) {
    if (!isMeaningfulTermName(row.name, row.type)) continue;
    const normalized = { ...row, name: normalizeTermName(row.name) };
    termByKey.set(row.term_key, normalized);
    const sourceTerms = termsBySource.get(row.source_key) || [];
    if (!sourceTerms.some((item) => item.term_key === row.term_key)) sourceTerms.push(normalized);
    termsBySource.set(row.source_key, sourceTerms);
  }
  for (const seed of primarySeedRows) {
    if (!termByKey.has(seed.entity_key)) {
      termByKey.set(seed.entity_key, {
        source_key: '',
        term_key: seed.entity_key,
        type: seed.type,
        name: normalizeTermName(seed.name),
        weight: 1
      });
    }
  }

  const pairWeights = buildCooccurrencePairs(termsBySource, new Set(termByKey.keys()), termsPerPaper);
  const keepKeys = selectConnectedTermKeys(pairWeights, seedKeys, nodeLimit);
  const edges = selectConnectedEdges(pairWeights, keepKeys, minCount, edgeLimit);
  const connectedKeys = new Set(edges.flatMap((edge) => [edge.source, edge.target]));

  const graphEdges = edges.map((edge) => ({ ...edge, relation: 'co_occurs' }));
  const baseNodes = [...keepKeys]
    .filter((key) => connectedKeys.has(key))
    .map((key) => {
      const term = termByKey.get(key);
      return {
        key,
        label: term?.name || key,
        type: 'entity' as const,
        entityType: term?.type || 'keyword'
      };
    });
  const clustered = assignTermClusters(baseNodes, graphEdges);

  return {
    nodes: clustered.nodes,
    edges: graphEdges,
    hops: seedKeys.length ? 3 : 1,
    seeds: seedKeys,
    clusters: clustered.clusters
  };
}

/** 按名称搜索可作为种子的节点 */
export async function searchGraphSeeds(query: string, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [] as GraphNode[];
  const like = `%${q}%`;
  const mentors = await all<{ mentor_key: string; name: string; school?: string }>(
    `SELECT mentor_key, name, school FROM mentor_profiles WHERE name LIKE ? OR school LIKE ? LIMIT ?`,
    [like, like, limit]
  );
  const projects = await all<{ project_key: string; project_name?: string }>(
    `SELECT project_key, project_name FROM projects WHERE project_name LIKE ? OR principal_investigator LIKE ? LIMIT ?`,
    [like, like, limit]
  );
  const papers = await all<{ paper_key: string; title: string }>(
    `SELECT paper_key, title FROM paper_documents WHERE title LIKE ? OR authors LIKE ? LIMIT ?`,
    [like, like, limit]
  );
  const entities = await all<{ entity_key: string; type: string; name: string }>(
    `SELECT entity_key, type, name FROM entities WHERE name LIKE ? LIMIT ?`,
    [like, limit]
  );

  const nodes: GraphNode[] = [
    ...mentors.map((m) => ({
      key: m.mentor_key,
      label: m.school ? `${m.name} · ${m.school}` : m.name,
      type: 'mentor' as const
    })),
    ...projects.map((p) => ({
      key: p.project_key,
      label: p.project_name || p.project_key,
      type: 'project' as const
    })),
    ...papers.map((p) => ({ key: p.paper_key, label: p.title, type: 'paper' as const })),
    ...entities.map((e) => ({
      key: e.entity_key,
      label: e.name,
      type: 'entity' as const,
      entityType: e.type
    }))
  ];
  return nodes.slice(0, limit);
}

/** 查询与图谱节点直接相连或在检索记录中共同出现的论文 */
export async function findPapersForGraphNode(nodeKey: string, page = 1, pageSize = 8, nodeLabel = ''): Promise<GraphPaperPage> {
  const safePage = Math.max(1, Math.floor(page));
  const safePageSize = Math.min(20, Math.max(1, Math.floor(pageSize)));
  const offset = (safePage - 1) * safePageSize;
  const linkedPaperKeys = `
    WITH mentioned_records AS (
      SELECT sr.source_type, sr.source_key
      FROM entity_mentions em
      JOIN search_records sr ON sr.record_id = em.record_id
      WHERE em.entity_key = ?
    ),
    linked_papers AS (
      SELECT source_key AS paper_key
      FROM mentioned_records
      WHERE source_type = 'paper'
      UNION
      SELECT pc.paper_key
      FROM mentioned_records mr
      JOIN paper_chunks pc ON mr.source_type = 'paper_chunk' AND mr.source_key = pc.chunk_key
      UNION
      SELECT CASE WHEN e.source_key = ? THEN e.target_key ELSE e.source_key END AS paper_key
      FROM edges e
      WHERE e.source_key = ? OR e.target_key = ?
      UNION
      SELECT ? AS paper_key
      UNION
      SELECT paper_key
      FROM paper_documents
      WHERE ? <> '' AND (title LIKE ? OR authors LIKE ? OR keywords LIKE ?)
    )
  `;
  const likeLabel = `%${nodeLabel.trim()}%`;
  const params = [nodeKey, nodeKey, nodeKey, nodeKey, nodeKey, nodeLabel.trim(), likeLabel, likeLabel, likeLabel];
  const countRows = await all<{ total: number }>(
    `${linkedPaperKeys}
     SELECT COUNT(*) AS total
     FROM paper_documents p
     JOIN linked_papers lp ON lp.paper_key = p.paper_key`,
    params
  );
  const papers = await all<{ paper_key: string; title: string; authors?: string; updated_at: string }>(
    `${linkedPaperKeys}
     SELECT p.paper_key, p.title, p.authors, p.updated_at
     FROM paper_documents p
     JOIN linked_papers lp ON lp.paper_key = p.paper_key
     ORDER BY p.updated_at DESC, p.title ASC
     LIMIT ? OFFSET ?`,
    [...params, safePageSize, offset]
  );
  return {
    papers: papers.map((paper) => ({
      paperKey: paper.paper_key,
      title: paper.title,
      authors: paper.authors || '作者信息未收录',
      updatedAt: paper.updated_at
    })),
    total: Number(countRows[0]?.total || 0),
    page: safePage,
    pageSize: safePageSize
  };
}
