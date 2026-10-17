/**
 * End-to-end: ask knowledge-qa about 巨云涛 via web_search.
 * Usage: npx tsx scripts/test-mentor-ju-yuntao.ts
 */
import assert from 'node:assert/strict';
import { runOpenCodeChat } from '../src/lib/opencode/chat';
import { getOpenCodeHealth } from '../src/lib/opencode/runtime';

async function main() {
  const health = await getOpenCodeHealth();
  console.log('opencode health:', JSON.stringify(health));
  assert.equal(Boolean(health.healthy ?? (health as { ok?: boolean }).ok), true, 'OpenCode sidecar must be healthy');

  const steps: Array<{ type: string; tool?: string; content: string }> = [];
  const result = await runOpenCodeChat('请检索并介绍导师巨云涛的档案（学校、职称、研究方向等）', {
    conversationId: `mentor-web-${Date.now()}`,
    onAgentStep: (step) => {
      steps.push({ type: step.type, tool: step.tool, content: String(step.content || '').slice(0, 200) });
      if (step.type === 'tool_call') {
        console.log(`[tool] ${step.tool}: ${String(step.content || '').slice(0, 160)}`);
      }
    },
    onStatus: (status) => console.log(`[status] ${status.phase}: ${status.detail}`)
  });

  const usedWeb = steps.some((step) => step.tool === 'web_search' || step.tool === 'webfetch');
  const usedLocalMentors = steps.some(
    (step) =>
      /knowledge-corpus\/mentors/.test(JSON.stringify(step))
      || (step.tool === 'grep' && /mentors/.test(step.content))
  );

  console.log('\n--- answer ---\n');
  console.log(result.answer);
  console.log('\n--- checks ---');
  console.log({ usedWeb, usedLocalMentors, answerLen: result.answer.length });

  assert.equal(usedLocalMentors, false, 'must not search local mentors corpus');
  assert.equal(usedWeb, true, 'must call web_search or webfetch');
  assert.match(result.answer, /巨云涛/);
  assert.match(result.answer, /中国农业大学|农大|信电|副教授|清华/);
  console.log('\nOK');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
