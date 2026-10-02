import { buildChatContexts } from '../src/lib/chat-context';

const history = [
  { role: 'user', content: '牛泽原是谁' },
  { role: 'assistant', content: '牛泽原是论文作者…[E1][E2]' },
  { role: 'user', content: '他还有哪些论文' },
  { role: 'assistant', content: '还有虚拟电厂相关研究…[E3]' },
  { role: 'user', content: '李兆泽是谁' },
  { role: 'assistant', content: '李兆泽是…[E4]' },
  { role: 'user', content: '157.95 MW 出自哪篇' },
  { role: 'assistant', content: '出自李兆泽论文…[E5][E6]' }
];

function mockPairs(count: number) {
  const messages: Array<{ role: string; content: string }> = [];
  for (let index = 0; index < count; index += 1) {
    messages.push({ role: 'user', content: `问题${index + 1}：关于电力系统算法与项目检索` });
    messages.push({ role: 'assistant', content: `回答${index + 1}：这是较长的助手回复，包含一些技术细节与证据引用[E${index + 1}]。`.repeat(8) });
  }
  return messages;
}

for (const count of [4, 60, 120, 250]) {
  const msgs = mockPairs(count);
  const built = buildChatContexts(msgs, '继续追问');
  console.log(`\n=== ${count} 轮 === tier:${built.meta.tier} chars:${built.meta.chars}`);
}

const built = buildChatContexts([...history, { role: 'user', content: '这篇论文讲了什么' }], '这篇论文讲了什么', 6);
console.log('\n=== 指代追问 ===');
console.log('tier:', built.meta.tier, 'pairs:', built.meta.turnPairs, 'chars:', built.meta.chars);
