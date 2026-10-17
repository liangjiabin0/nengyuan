import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const componentPath = join(process.cwd(), 'src', 'components', 'chat-workbench.tsx');
const source = readFileSync(componentPath, 'utf8');

function assertIncludes(needle: string, message: string) {
  if (!source.includes(needle)) {
    throw new Error(message);
  }
}

assertIncludes('function GraphNetworkView', 'Knowledge graph modal should include a visual network component.');
assertIncludes('<svg', 'Knowledge graph modal should render an SVG network before textual details.');
assertIncludes('graph.edges.slice(0, 32)', 'Knowledge graph modal should cap visible network edges to avoid pill-list clutter.');
assertIncludes('<GraphNetworkView graph={graph} />', 'Knowledge graph modal should render the network view before node and edge lists.');

console.log('Graph visual UI checks passed.');
