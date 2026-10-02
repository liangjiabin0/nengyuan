import assert from 'node:assert/strict';
import { getAgentTools } from '../src/lib/agent/tool-catalog';
import { get, run } from '../src/lib/db';
import { fetchGraphRelations } from '../src/lib/graph-relations';

async function main() {
  const toolNames = getAgentTools().map((tool) => tool.name);

  for (const expected of ['graph.expand', 'graph.neighbors', 'graph.mentions', 'graph.path_between']) {
    assert.ok(toolNames.includes(expected), `expected agent tool catalog to include ${expected}`);
  }

  const existingEdge = get<{ source_key: string; target_key: string; relation: string }>(
    'SELECT source_key, target_key, relation FROM edges LIMIT 1'
  );

  let seed = existingEdge?.source_key;

  if (!seed) {
    run(
      `INSERT OR REPLACE INTO edges(edge_key, source_key, target_key, relation, weight, meta, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      ['test-graph-restore-edge', 'test-graph-source', 'test-graph-target', 'test_relation', 1, '{}']
    );
    seed = 'test-graph-source';
  }

  const graph = await fetchGraphRelations([seed], 20);

  assert.ok(graph.nodes.length >= 2, 'expected graph relation query to return connected nodes');
  assert.ok(graph.edges.length >= 1, 'expected graph relation query to return at least one edge');
  assert.ok(graph.nodes.some((node) => node.key === seed), 'expected graph nodes to include the requested seed');
  assert.ok(graph.edges.some((edge) => edge.source === seed || edge.target === seed), 'expected graph edges to include the requested seed');

  const overview = await fetchGraphRelations([], 20);
  assert.ok(overview.nodes.length >= 2, 'expected graph overview to return connected nodes');
  assert.ok(overview.edges.length >= 1, 'expected graph overview to return at least one edge');

  console.log('graph restore checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
