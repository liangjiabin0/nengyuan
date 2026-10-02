import assert from 'node:assert/strict';
import { buildConversationState } from '../src/lib/agent/conversation-state';
import { buildChatContexts } from '../src/lib/chat-context';

const pairedHistory = [
  { role: 'user' as const, content: '介绍一下张三老师' },
  {
    role: 'assistant' as const,
    content: '张三老师研究电力系统，相关论文有《配电网优化》。[E2]',
    sources: [{ id: 'E7' }]
  },
  { role: 'user' as const, content: '本轮问题' }
];
const paired = buildConversationState(pairedHistory, '本轮问题', 3);
assert.equal(paired.turnPairs.length, 1, '当前问题不应重复计入历史 pair');
assert.equal(paired.maxEvidence, 7, '应统一读取正文和 sources 中的最大证据号');
assert.equal(paired.evidenceOffset, 7, '过期的请求 offset 不应覆盖历史最大证据号');

const switched = buildConversationState(
  pairedHistory.slice(0, 2),
  '先不谈这个，换个话题聊点别的'
);
assert.equal(switched.topicShift.kind, 'explicit_reset');
assert.equal(switched.topicShift.inheritMemory, false);
assert.equal(switched.memory.resolvedPerson, undefined, '切换话题后应清除旧人物锚点');
assert.equal(switched.memory.focusPaper, undefined, '切换话题后应清除旧论文锚点');
assert.deepEqual(switched.memory.activeEntities, []);
const switchedToPerson = buildConversationState(
  pairedHistory.slice(0, 2),
  '先不谈这个，李四是谁'
);
assert.equal(switchedToPerson.memory.resolvedPerson, '李四');
assert.equal(
  switchedToPerson.memory.activeEntities.some((entity) => entity.name === '张三'),
  false,
  '显式切换后只应保留本轮新锚点'
);

const peopleHistory = [
  { role: 'user' as const, content: '有哪些相关老师' },
  { role: 'assistant' as const, content: '候选人为张三、李四、王五。' }
];
const ambiguousPerson = buildConversationState(peopleHistory, '他研究什么');
assert.equal(ambiguousPerson.referent.needsClarification, true);
assert.deepEqual(
  ambiguousPerson.memory.referentCandidates.map((entity) => entity.name),
  ['张三', '李四', '王五']
);
const ordinalPerson = buildConversationState(peopleHistory, '第二位研究什么');
assert.equal(ordinalPerson.referent.resolvedPerson, '李四');
assert.equal(ordinalPerson.referent.needsClarification, false);
const pluralPeople = buildConversationState(peopleHistory, '他们分别研究什么');
assert.equal(pluralPeople.referent.needsClarification, false);
assert.equal(pluralPeople.memory.referentCandidates.length, 3);

const mentorFollowUp = buildChatContexts(
  [
    { role: 'user', content: '找几位研究电力系统的导师' },
    { role: 'assistant', content: '已为你找到若干电力系统方向导师。' }
  ],
  '他们分别在哪些学校？'
);
assert.equal(mentorFollowUp.sessionMemory.topicFocus, 'mentor');
assert.match(mentorFollowUp.retrievalContext, /延续话题: 导师/);

const papersHistory = [
  { role: 'user' as const, content: '比较两篇论文' },
  { role: 'assistant' as const, content: '可比较《论文甲》和《论文乙》。' }
];
const ambiguousPaper = buildConversationState(papersHistory, '这篇用了什么方法');
assert.equal(ambiguousPaper.referent.needsClarification, true);
assert.deepEqual(
  ambiguousPaper.memory.referentCandidates.map((entity) => entity.name),
  ['论文甲', '论文乙']
);
const secondPaper = buildConversationState(papersHistory, '第二篇用了什么方法');
assert.equal(secondPaper.referent.focusPaper, '论文乙');

const longHistory = Array.from({ length: 40 }, (_, index) => [
  { role: 'user' as const, content: `问题${index + 1}：分析研究对象` },
  {
    role: 'assistant' as const,
    content: `回答${index + 1}：张三老师讨论《论文${index + 1}》的结论。`.repeat(80)
  }
]).flat();
const longContext = buildChatContexts(longHistory, '继续');
assert.equal(longContext.meta.tier, 'deep');
assert.match(longContext.llmContext, /较早轮次结构化提要/);
assert.match(longContext.llmContext, /人物: 张三/);
assert.match(longContext.llmContext, /论文: 《论文1》/);
assert.equal(longContext.state.conversationContext.text, longContext.llmContext);
assert.equal(longContext.meta.turnPairs, longContext.state.turnPairs.length);

console.log('conversation-state tests passed');
