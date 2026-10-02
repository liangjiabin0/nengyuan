import fs from 'node:fs';
import path from 'node:path';
import { all } from './db';
import { isMeaningfulTermName, normalizeTermName } from './kg/term-quality';
import { parseAuthorsFromRecord, isValidPersonName, authorsFieldLooksValid } from './paper-authors';
import { ensurePaperMetadataBackfilled } from './paper-metadata';

type PaperRow = {
  paper_key: string;
  title: string;
  authors?: string;
  keywords?: string;
  publish_year?: number;
  journal?: string;
  file_path?: string;
  pdf_path?: string;
};

type MetadataItem = {
  fileName?: string;
  title?: string;
  authors?: string;
  journal?: string;
  publishYear?: string | number;
};

export type AnalyticsOptions = {
  query?: string;
  yearFrom?: number;
  yearTo?: number;
  limit?: number;
  minCount?: number;
  minTeamSize?: number;
  refresh?: boolean;
};

let metadataCache: {
  byTitle: Map<string, MetadataItem>;
  byFile: Map<string, MetadataItem>;
} | null = null;

function normalizeTitle(value: string) {
  return String(value || '')
    .replace(/_[^_]+$/u, '')
    .replace(/\s+/g, '')
    .replace(/[_\-—–:："'“”']/g, '')
    .toLowerCase();
}

function loadMetadataMaps() {
  if (metadataCache) return metadataCache;
  const metadataPath = path.join(process.cwd(), 'outputs', 'spreadsheet-work', 'paper-metadata-cqvip.json');
  const byTitle = new Map<string, MetadataItem>();
  const byFile = new Map<string, MetadataItem>();
  if (!fs.existsSync(metadataPath)) {
    metadataCache = { byTitle, byFile };
    return metadataCache;
  }
  const payload = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { items?: MetadataItem[] };
  for (const item of payload.items || []) {
    if (item.title) byTitle.set(normalizeTitle(item.title), item);
    if (item.fileName) {
      const base = path.basename(item.fileName).toLowerCase();
      byFile.set(base, item);
      byFile.set(base.replace(/\.caj$/i, '.pdf'), item);
      byFile.set(base.replace(/\.pdf$/i, '.caj'), item);
    }
  }
  metadataCache = { byTitle, byFile };
  return metadataCache;
}

function resolvePaperAuthors(paper: PaperRow) {
  if (authorsFieldLooksValid(paper.authors || '')) return String(paper.authors || '');
  const maps = loadMetadataMaps();
  const base = path.basename(paper.file_path || paper.pdf_path || '').toLowerCase();
  const item = maps.byFile.get(base) || maps.byTitle.get(normalizeTitle(paper.title));
  if (item?.authors && authorsFieldLooksValid(item.authors)) return item.authors;
  return String(paper.authors || '');
}

async function loadPapers(options: AnalyticsOptions) {
  let enrichment = {
    available: true,
    items: 0,
    matched: 0,
    updated: 0,
    authorsFixed: 0
  };
  // 仅在显式刷新时尝试落盘回填，避免写锁拖慢常规分析查询。
  if (options.refresh) {
    try {
      enrichment = await ensurePaperMetadataBackfilled(true);
    } catch {
      enrichment = { available: false, items: 0, matched: 0, updated: 0, authorsFixed: 0 };
    }
  }

  const rows = (await all<PaperRow>(
    `SELECT paper_key, title, authors, keywords, publish_year, journal, file_path, pdf_path
     FROM paper_documents
     WHERE paper_key NOT LIKE 'patent:%' AND publish_year IS NOT NULL
     ORDER BY publish_year, title`
  )).map((paper) => ({
    ...paper,
    authors: resolvePaperAuthors(paper)
  }));

  const query = String(options.query || '').trim().toLowerCase();
  const filtered = rows.filter((paper) => {
    const year = Number(paper.publish_year);
    if (options.yearFrom && year < options.yearFrom) return false;
    if (options.yearTo && year > options.yearTo) return false;
    if (!query) return true;
    return `${paper.title} ${paper.authors || ''} ${paper.keywords || ''} ${paper.journal || ''}`.toLowerCase().includes(query);
  });
  const coverage = (await all<{ total: number; with_year: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN publish_year IS NOT NULL THEN 1 ELSE 0 END) AS with_year
     FROM paper_documents WHERE paper_key NOT LIKE 'patent:%'`
  ))[0] || { total: 0, with_year: 0 };
  return { papers: filtered, enrichment, coverage };
}

async function countTermsByYear(papers: PaperRow[]) {
  const paperSet = new Set(papers.map((paper) => paper.paper_key));
  const yearByPaper = new Map(papers.map((paper) => [paper.paper_key, Number(paper.publish_year)]));
  const rows = await all<{ paper_key: string; name: string }>(
    `SELECT ed.source_key AS paper_key, e.name
     FROM edges ed
     JOIN entities e ON e.entity_key = ed.target_key
     WHERE ed.relation = 'has_keyword'
       AND e.type IN ('keyword', 'discipline')`
  );
  const counts = new Map<string, Map<number, number>>();
  for (const row of rows) {
    if (!paperSet.has(row.paper_key)) continue;
    const term = normalizeTermName(row.name);
    if (!isMeaningfulTermName(term, 'keyword')) continue;
    const year = yearByPaper.get(row.paper_key);
    if (!year) continue;
    const yearly = counts.get(term) || new Map<number, number>();
    yearly.set(year, (yearly.get(year) || 0) + 1);
    counts.set(term, yearly);
  }
  return counts;
}

export async function getTimelineAnalytics(options: AnalyticsOptions = {}) {
  const { papers, enrichment, coverage } = await loadPapers(options);
  const years = [...new Set(papers.map((paper) => Number(paper.publish_year)))].sort((a, b) => a - b);
  const paperCounts = new Map<number, number>();
  for (const paper of papers) {
    const year = Number(paper.publish_year);
    paperCounts.set(year, (paperCounts.get(year) || 0) + 1);
  }
  const termCounts = await countTermsByYear(papers);
  const rankedTerms = [...termCounts.entries()]
    .map(([term, yearly]) => ({ term, total: [...yearly.values()].reduce((sum, value) => sum + value, 0), yearly }))
    .sort((a, b) => b.total - a.total);
  const toPoints = (yearly: Map<number, number>) => years.map((year) => ({ year, count: yearly.get(year) || 0 }));
  return {
    meta: { enrichment, coverage, paperCount: papers.length, yearCount: years.length, keywordCount: termCounts.size },
    years,
    publications: years.map((year) => ({ year, count: paperCounts.get(year) || 0 })),
    topics: rankedTerms.slice(0, 6).map((item) => ({ term: item.term, total: item.total, points: toPoints(item.yearly) })),
    heatmap: rankedTerms.slice(0, Math.min(12, options.limit || 10)).map((item) => ({ term: item.term, points: toPoints(item.yearly) }))
  };
}

export async function getBurstAnalytics(options: AnalyticsOptions = {}) {
  const { papers, enrichment, coverage } = await loadPapers(options);
  const keywordKeys = new Map((await all<{ entity_key: string; name: string }>("SELECT entity_key, name FROM entities WHERE type IN ('keyword', 'discipline')")).map((row) => [normalizeTermName(row.name), row.entity_key]));
  const years = [...new Set(papers.map((paper) => Number(paper.publish_year)))].sort((a, b) => a - b);
  const maxYear = years.at(-1) || new Date().getFullYear();
  const recentFrom = Math.max(years[0] || maxYear, maxYear - 1);
  const baselineYears = years.filter((year) => year < recentFrom);
  const termCounts = await countTermsByYear(papers);
  const minCount = Math.max(1, options.minCount || 2);
  const items = [...termCounts.entries()].map(([term, yearly]) => {
    const activeYears = [...yearly.keys()].sort((a, b) => a - b);
    const total = [...yearly.values()].reduce((sum, value) => sum + value, 0);
    const recentCount = activeYears.filter((year) => year >= recentFrom).reduce((sum, year) => sum + (yearly.get(year) || 0), 0);
    const baselineCount = baselineYears.reduce((sum, year) => sum + (yearly.get(year) || 0), 0);
    const baselineAvg = baselineCount / Math.max(1, baselineYears.length);
    const score = Number((((recentCount + 1) / (baselineAvg + 1)) * Math.log2(total + 1)).toFixed(2));
    return {
      key: keywordKeys.get(term) || `keyword:${encodeURIComponent(term)}`,
      term,
      total,
      recentCount,
      baselineAvg: Number(baselineAvg.toFixed(2)),
      growthRate: Number(((recentCount + 1) / (baselineAvg + 1)).toFixed(2)),
      score,
      firstYear: activeYears[0],
      lastYear: activeYears.at(-1),
      points: years.map((year) => ({ year, count: yearly.get(year) || 0 }))
    };
  }).filter((item) => item.total >= minCount).sort((a, b) => b.score - a.score || b.recentCount - a.recentCount);
  return {
    meta: { enrichment, coverage, paperCount: papers.length, recentFrom, maxYear },
    years,
    items: items.slice(0, Math.min(50, options.limit || 20))
  };
}

async function buildAuthorNetwork(options: AnalyticsOptions = {}) {
  const { papers, enrichment, coverage } = await loadPapers(options);
  const personRows = await all<{ entity_key: string; name: string }>("SELECT entity_key, name FROM entities WHERE type='person'");
  const personKeyByName = new Map(
    personRows.filter((row) => isValidPersonName(row.name)).map((row) => [row.name, row.entity_key])
  );
  const authorPapers = new Map<string, Set<string>>();
  const authorYears = new Map<string, number[]>();
  const authorKeywords = new Map<string, string[]>();
  const paperByKey = new Map(papers.map((paper) => [paper.paper_key, paper]));
  const pairWeights = new Map<string, { sourceName: string; targetName: string; weight: number }>();
  const paperTerms = await countTermsByYear(papers);
  const termsByPaper = new Map<string, string[]>();
  const keywordRows = await all<{ paper_key: string; name: string }>(
    `SELECT ed.source_key AS paper_key, e.name
     FROM edges ed
     JOIN entities e ON e.entity_key = ed.target_key
     WHERE ed.relation = 'has_keyword' AND e.type IN ('keyword', 'discipline')`
  );
  for (const row of keywordRows) {
    const term = normalizeTermName(row.name);
    if (!isMeaningfulTermName(term, 'keyword')) continue;
    const list = termsByPaper.get(row.paper_key) || [];
    list.push(term);
    termsByPaper.set(row.paper_key, list);
  }

  for (const paper of papers) {
    const authors = [...new Set(parseAuthorsFromRecord(paper.authors || '').filter(isValidPersonName))].slice(0, 12);
    const keywords = [...new Set(termsByPaper.get(paper.paper_key) || [])].slice(0, 12);
    for (const author of authors) {
      const set = authorPapers.get(author) || new Set<string>();
      set.add(paper.paper_key);
      authorPapers.set(author, set);
      authorYears.set(author, [...(authorYears.get(author) || []), Number(paper.publish_year)]);
      authorKeywords.set(author, [...(authorKeywords.get(author) || []), ...keywords]);
    }
    for (let left = 0; left < authors.length; left += 1) {
      for (let right = left + 1; right < authors.length; right += 1) {
        const [sourceName, targetName] = [authors[left], authors[right]].sort((a, b) => a.localeCompare(b, 'zh-CN'));
        const key = `${sourceName}\u0000${targetName}`;
        const current = pairWeights.get(key);
        pairWeights.set(key, { sourceName, targetName, weight: (current?.weight || 0) + 1 });
      }
    }
  }

  const minCount = Math.max(1, options.minCount || 1);
  const limit = Math.min(160, Math.max(20, options.limit || 100));
  const seedNames = [...authorPapers.keys()]
    .filter((name) => isValidPersonName(name) && (authorPapers.get(name)?.size || 0) >= minCount)
    .sort((a, b) => (authorPapers.get(b)?.size || 0) - (authorPapers.get(a)?.size || 0))
    .slice(0, Math.max(12, Math.floor(limit / 2)));
  const keep = new Set(seedNames);
  for (const seed of seedNames) {
    const related = [...pairWeights.values()]
      .filter((edge) => edge.sourceName === seed || edge.targetName === seed)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 8);
    for (const edge of related) {
      keep.add(edge.sourceName);
      keep.add(edge.targetName);
      if (keep.size >= limit) break;
    }
    if (keep.size >= limit) break;
  }
  const rankedNames = [...keep]
    .filter((name) => isValidPersonName(name))
    .sort((a, b) => (authorPapers.get(b)?.size || 0) - (authorPapers.get(a)?.size || 0))
    .slice(0, limit);
  const finalKeep = new Set(rankedNames);
  const edges = [...pairWeights.values()]
    .filter((edge) => finalKeep.has(edge.sourceName) && finalKeep.has(edge.targetName))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit * 4)
    .map((edge) => ({
      source: personKeyByName.get(edge.sourceName) || `author:${encodeURIComponent(edge.sourceName)}`,
      target: personKeyByName.get(edge.targetName) || `author:${encodeURIComponent(edge.targetName)}`,
      weight: edge.weight,
      relation: 'co_authored'
    }));
  const collaboratorCount = new Map<string, number>();
  for (const edge of pairWeights.values()) {
    collaboratorCount.set(edge.sourceName, (collaboratorCount.get(edge.sourceName) || 0) + 1);
    collaboratorCount.set(edge.targetName, (collaboratorCount.get(edge.targetName) || 0) + 1);
  }
  const nodes = rankedNames.map((name) => {
    const years = authorYears.get(name) || [];
    const termCount = new Map<string, number>();
    for (const term of authorKeywords.get(name) || []) termCount.set(term, (termCount.get(term) || 0) + 1);
    return {
      key: personKeyByName.get(name) || `author:${encodeURIComponent(name)}`,
      name,
      paperCount: authorPapers.get(name)?.size || 0,
      collaboratorCount: collaboratorCount.get(name) || 0,
      firstYear: Math.min(...years),
      lastYear: Math.max(...years),
      keywords: [...termCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([term]) => term),
      paperKeys: [...(authorPapers.get(name) || [])]
    };
  });
  return {
    meta: { enrichment, coverage, paperCount: papers.length, authorCount: nodes.length, keywordCount: paperTerms.size },
    nodes,
    edges,
    paperByKey,
    pairWeights
  };
}

export async function getAuthorAnalytics(options: AnalyticsOptions = {}) {
  const network = await buildAuthorNetwork(options);
  return { meta: network.meta, nodes: network.nodes, edges: network.edges };
}

export async function getTeamAnalytics(options: AnalyticsOptions = {}) {
  const network = await buildAuthorNetwork({ ...options, limit: Math.max(120, options.limit || 100), minCount: Math.max(1, options.minCount || 1) });
  const minTeamSize = Math.max(2, options.minTeamSize || 3);
  const unassigned = new Set(network.nodes.map((node) => node.name));
  const nodeByName = new Map(network.nodes.map((node) => [node.name, node]));
  const neighbors = new Map<string, Array<{ name: string; weight: number }>>();
  for (const pair of network.pairWeights.values()) {
    neighbors.set(pair.sourceName, [...(neighbors.get(pair.sourceName) || []), { name: pair.targetName, weight: pair.weight }]);
    neighbors.set(pair.targetName, [...(neighbors.get(pair.targetName) || []), { name: pair.sourceName, weight: pair.weight }]);
  }
  const leaders = [...network.nodes].sort((a, b) => b.paperCount - a.paperCount || b.collaboratorCount - a.collaboratorCount);
  const teams: Array<Record<string, unknown>> = [];
  for (const leader of leaders) {
    if (!unassigned.has(leader.name)) continue;
    const members = [leader.name, ...(neighbors.get(leader.name) || [])
      .filter((item) => unassigned.has(item.name))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 7)
      .map((item) => item.name)];
    if (members.length < minTeamSize) continue;
    members.forEach((name) => unassigned.delete(name));
    const memberNodes = members.map((name) => nodeByName.get(name)).filter(Boolean) as typeof network.nodes;
    const paperKeys = new Set(memberNodes.flatMap((node) => node.paperKeys));
    const years = memberNodes.flatMap((node) => [node.firstYear, node.lastYear]).filter(Number.isFinite);
    const keywordCounts = new Map<string, number>();
    for (const keyword of memberNodes.flatMap((node) => node.keywords)) keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1);
    const collaborationStrength = [...network.pairWeights.values()]
      .filter((pair) => members.includes(pair.sourceName) && members.includes(pair.targetName))
      .reduce((sum, pair) => sum + pair.weight, 0);
    teams.push({
      id: `team:${teams.length + 1}`,
      label: `${leader.name}团队`,
      leader: leader.name,
      members,
      memberKeys: memberNodes.map((node) => node.key),
      paperCount: paperKeys.size,
      collaborationStrength,
      firstYear: Math.min(...years),
      lastYear: Math.max(...years),
      keywords: [...keywordCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([term]) => term)
    });
    if (teams.length >= 20) break;
  }
  return { meta: network.meta, teams };
}
