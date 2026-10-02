import Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path/unweighted';
import { connectedComponents } from 'graphology-components';
import { all } from '../db';

export type EngineNode = {
  key: string;
  label: string;
  type: string;
};

export type EngineEdge = {
  source: string;
  target: string;
  relation: string;
  weight: number;
};

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

async function loadNeighborhoodEdges(seeds: string[], hops: number, edgeLimit: number, relations?: string[]) {
  let frontier = new Set(seeds);
  const visited = new Set(seeds);
  const collected: EngineEdge[] = [];
  const relationFilter = relations?.filter(Boolean) || [];

  for (let hop = 0; hop < hops && frontier.size && collected.length < edgeLimit; hop += 1) {
    const keys = [...frontier];
    const placeholders = keys.map(() => '?').join(',');
    const relationClause =
      relationFilter.length > 0 ? ` AND relation IN (${relationFilter.map(() => '?').join(',')})` : '';
    const rows = await all<{ source: string; target: string; relation: string; weight: number }>(
      `SELECT source_key as source, target_key as target, relation, weight
       FROM edges
       WHERE (source_key IN (${placeholders}) OR target_key IN (${placeholders}))${relationClause}
       ORDER BY weight DESC
       LIMIT ?`,
      [...keys, ...keys, ...relationFilter, Math.min(edgeLimit * 2, 800)]
    );

    const next = new Set<string>();
    for (const row of rows) {
      if (collected.length >= edgeLimit) break;
      collected.push({
        source: row.source,
        target: row.target,
        relation: row.relation,
        weight: Number(row.weight || 0)
      });
      for (const node of [row.source, row.target]) {
        if (!visited.has(node)) {
          visited.add(node);
          next.add(node);
        }
      }
    }
    frontier = next;
  }

  return { edges: collected, nodeKeys: [...visited] };
}

export function buildGraphology(nodes: string[], edges: EngineEdge[]) {
  const graph = new Graph({ multi: true, type: 'undirected', allowSelfLoops: false });
  for (const key of nodes) {
    if (!graph.hasNode(key)) graph.addNode(key);
  }
  for (const edge of edges) {
    if (!graph.hasNode(edge.source)) graph.addNode(edge.source);
    if (!graph.hasNode(edge.target)) graph.addNode(edge.target);
    try {
      graph.addEdge(edge.source, edge.target, { relation: edge.relation, weight: edge.weight });
    } catch {
      // ignore duplicate multi-edge collisions
    }
  }
  return graph;
}

export async function expandSubgraph(options: {
  seeds: string[];
  hops?: number;
  limit?: number;
  relations?: string[];
}) {
  const seeds = uniqueKeys(options.seeds, 40);
  const hops = Math.min(3, Math.max(1, options.hops ?? 1));
  const limit = Math.min(300, Math.max(1, options.limit ?? 80));
  if (!seeds.length) {
    const rows = await all<{ source: string; target: string; relation: string; weight: number }>(
      `SELECT source_key as source, target_key as target, relation, weight
       FROM edges ORDER BY weight DESC LIMIT ?`,
      [limit]
    );
    const edges = rows.map((row) => ({
      source: row.source,
      target: row.target,
      relation: row.relation,
      weight: Number(row.weight || 0)
    }));
    const nodeKeys = uniqueKeys(edges.flatMap((e) => [e.source, e.target]), 200);
    return { seeds, hops, edges, nodeKeys, graph: buildGraphology(nodeKeys, edges) };
  }

  const { edges, nodeKeys } = await loadNeighborhoodEdges(seeds, hops, limit, options.relations);
  return { seeds, hops, edges, nodeKeys, graph: buildGraphology(nodeKeys, edges) };
}

export async function shortestPathBetween(from: string, to: string, hops = 3, limit = 200) {
  if (!from || !to) return { path: [] as string[], edges: [] as EngineEdge[] };
  const { edges, nodeKeys, graph } = await expandSubgraph({ seeds: [from, to], hops, limit });
  if (!graph.hasNode(from) || !graph.hasNode(to)) {
    return { path: [] as string[], edges };
  }
  const path = bidirectional(graph, from, to) || [];
  const pathSet = new Set(path);
  const pathEdges = edges.filter((e) => pathSet.has(e.source) && pathSet.has(e.target));
  return { path, edges: pathEdges, nodeKeys };
}

export async function communitySummary(seeds: string[], hops = 2, limit = 150) {
  const { edges, nodeKeys, graph } = await expandSubgraph({ seeds, hops, limit });
  const components = connectedComponents(graph) as string[][];
  const ranked = components
    .map((component) => ({ size: component.length, nodes: component.slice(0, 20) }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 12);
  return { components: ranked, nodeCount: nodeKeys.length, edgeCount: edges.length, edges: edges.slice(0, 80) };
}
