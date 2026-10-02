import { buildSessionMemory } from '../src/lib/agent/session-memory';

const msgs = [
  { role: 'user' as const, content: '巨云涛是谁' },
  { role: 'assistant' as const, content: '巨云涛是某某大学的导师，研究方向为电力系统。' }
];

const memory = buildSessionMemory(msgs, '他写过什么论文');

console.log('resolvedPerson:', memory.resolvedPerson);
console.log('recommendedTool:', memory.searchPlan.recommendedTool);
console.log('recommendedArgs:', memory.searchPlan.recommendedArgs);
console.log('suggestedQuery:', memory.searchPlan.suggestedQuery);

if (memory.resolvedPerson !== '巨云涛') {
  console.error('FAIL: resolvedPerson');
  process.exit(1);
}
if (memory.searchPlan.recommendedTool !== 'domain.papers.by_author') {
  console.error('FAIL: recommendedTool');
  process.exit(1);
}
console.log('OK');
