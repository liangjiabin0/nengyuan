import { buildSessionMemory } from '../src/lib/agent/session-memory';
import { executeTool } from '../src/lib/tools/registry';

async function main() {
  const msgs = [
    { role: 'user' as const, content: '巨云涛写过什么论文' },
    {
      role: 'assistant' as const,
      content: '（上一轮误列了引用论文，已修复）'
    },
    {
      role: 'user' as const,
      content: '新型配电系统分布式资源调度研究现状与展望讲了什么内容'
    },
    {
      role: 'assistant' as const,
      content: '《新型配电系统分布式资源调度研究现状与展望》主要讨论分布式资源调度...'
    }
  ];

  const q = '这篇论文巨云涛是第几作者';
  const memory = buildSessionMemory(msgs, q);
  console.log('focusPaper:', memory.focusPaper);
  console.log('searchPlan:', memory.searchPlan.recommendedTool, memory.searchPlan.recommendedArgs);

  const ctx = { question: q, llmContext: '', retrievalContext: '', evidenceOffset: 0, sessionMemory: memory };
  const byAuthor = await executeTool('domain.papers.by_author', { author: '巨云涛' }, ctx);
  console.log('\nby_author:', byAuthor.summary);

  const pos = await executeTool(
    'domain.papers.author_position',
    { anchor: memory.focusPaper, author: '巨云涛' },
    ctx
  );
  console.log('author_position:', pos.summary);
}
main();
