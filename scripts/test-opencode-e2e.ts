import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getDb } from '../src/lib/db';
import { runOpenCodeChat } from '../src/lib/opencode/chat';
import { getOpenCodeHealth } from '../src/lib/opencode/runtime';

type ApiStreamEvent =
  | { type: 'meta'; conversationId: string; sources?: unknown[] }
  | { type: 'agent_step'; step: { type: string; tool?: string; content: string } }
  | { type: 'chunk'; content: string }
  | { type: 'answer_reset' }
  | { type: 'answer_replace'; content: string }
  | { type: 'done' }
  | { type: 'error'; error: string }
  | { type: 'status' };

function assembleStreamedAnswer(events: ApiStreamEvent[]) {
  let answer = '';
  for (const event of events) {
    if (event.type === 'chunk') answer += event.content;
    else if (event.type === 'answer_reset') answer = '';
    else if (event.type === 'answer_replace') answer = event.content;
  }
  return answer;
}

async function ask(
  conversationId: string,
  question: string,
  llmContext = ''
) {
  const statuses: Array<{ phase: string; detail: string }> = [];
  const liveSteps: Array<{ type: string; tool?: string; content: string }> = [];
  const textDeltas: string[] = [];
  let streamedAnswer = '';
  let completed = false;
  const result = await runOpenCodeChat(question, {
    conversationId,
    conversationContext: llmContext,
    onStatus: (status) => statuses.push(status),
    onAgentStep: (step) => liveSteps.push(step),
    onTextDelta: (delta) => {
      assert.equal(completed, false, 'text delta arrived after OpenCode completion');
      textDeltas.push(delta);
      streamedAnswer += delta;
    },
    onAnswerReset: () => {
      assert.equal(completed, false, 'answer reset arrived after OpenCode completion');
      streamedAnswer = '';
    },
    onAnswerReplace: (content) => {
      assert.equal(completed, false, 'answer replace arrived after OpenCode completion');
      streamedAnswer = content;
    }
  });
  completed = true;
  assert.ok(result.answer.trim(), `empty answer for: ${question}`);
  assert.ok(
    textDeltas.length >= 1 || streamedAnswer === result.answer,
    `expected OpenCode text deltas or answer replace, got deltas=${textDeltas.length}`
  );
  assert.equal(streamedAnswer, result.answer, 'streamed answer protocol must equal the final OpenCode answer');
  // Intermediate public progress may exist in the trace but must not leak into the final reply.
  const progressTexts = liveSteps
    .filter((step) => step.type === 'public_text')
    .map((step) => step.content.trim())
    .filter(Boolean);
  if (progressTexts.length > 1) {
    const earlier = progressTexts.slice(0, -1).join('\n');
    assert.equal(
      result.answer.includes(earlier) && earlier !== result.answer.trim(),
      false,
      `final answer still contains earlier OpenCode progress text for: ${question}`
    );
  }
  assert.ok(
    liveSteps.some((step) => step.type === 'public_text'),
    `no public OpenCode text events for: ${question}`
  );
  assert.doesNotMatch(result.answer, /"answer"\s*:|"citations"\s*:|"limitations"\s*:/);
  assert.ok(
    result.sources.length > 0,
    `no validated Markdown citations for: ${question}\nanswer=${result.answer}\nreasons=${result.metrics.evidenceReasons.join(' | ')}`
  );
  assert.ok(result.agentSteps.length > 0, `no OpenCode steps for: ${question}`);
  assert.ok(
    result.agentSteps.some((step) => step.type === 'tool_call' && ['grep', 'glob', 'read', 'list', 'bash'].includes(step.tool || '')),
    `no filesystem tool call for: ${question}`
  );
  assert.ok(
    result.agentSteps.some((step) =>
      step.type === 'observation'
      && ['grep', 'glob', 'read', 'list', 'bash'].includes(step.tool || '')
      && step.content.trim().length > 0
    ),
    `no successful filesystem observation for: ${question}`
  );
  assert.equal(
    result.agentSteps.some((step) => /unavailable tool|Available tools:\s*\./i.test(step.content)),
    false,
    `filesystem tools remained disabled after session resume: ${question}`
  );
  assert.ok(result.metrics.toolCalls > 0, `toolCalls=0 for: ${question}`);
  assert.ok(result.metrics.modelRounds > 0, `modelRounds=0 for: ${question}`);
  return { question, result, statuses, liveSteps, textDeltas };
}

async function readApiEvents(response: Response) {
  assert.equal(response.ok, true, `API failed: ${response.status} ${await response.text()}`);
  assert.ok(response.body, 'API returned no stream');
  const events: ApiStreamEvent[] = [];
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let pending = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) events.push(JSON.parse(line) as ApiStreamEvent);
    }
  }
  if (pending.trim()) events.push(JSON.parse(pending) as ApiStreamEvent);
  return events;
}

async function testApiStreamingOwnership() {
  const conversationId = crypto.randomUUID();
  const response = await fetch('http://127.0.0.1:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      question: '巨云涛是谁？请给出可核验的语料路径和行号。',
      messages: []
    })
  });
  const events = await readApiEvents(response);

  const chunks = events.filter((event): event is Extract<ApiStreamEvent, { type: 'chunk' }> => event.type === 'chunk');
  const answer = assembleStreamedAnswer(events);
  const doneIndex = events.findIndex((event) => event.type === 'done');
  const firstChunkIndex = events.findIndex((event) => event.type === 'chunk' || event.type === 'answer_replace');
  assert.ok(chunks.length >= 1 || events.some((event) => event.type === 'answer_replace'), 'API must forward OpenCode answer text');
  assert.ok(firstChunkIndex >= 0 && firstChunkIndex < doneIndex, 'answer deltas must arrive before done');
  assert.ok(
    events.some((event) => event.type === 'agent_step' && event.step.type === 'public_text'),
    'API stream has no public OpenCode text trace'
  );
  assert.ok(
    events.some((event) => event.type === 'agent_step' && event.step.type === 'tool_call'),
    'API stream has no OpenCode tool call'
  );
  assert.equal(events.some((event) => event.type === 'error'), false, 'API stream emitted an error');
  assert.doesNotMatch(answer, /"answer"\s*:|"limitations"\s*:|抱歉，查询失败/);
  assert.ok(answer.trim(), 'assembled final answer is empty');

  const historyResponse = await fetch(
    `http://127.0.0.1:3000/api/chat/conversations/${encodeURIComponent(conversationId)}`
  );
  assert.equal(historyResponse.ok, true, `history reload failed: ${historyResponse.status}`);
  const history = await historyResponse.json() as {
    messages: Array<{ role: string; content: string; sources?: unknown[]; agentSteps?: Array<{ type: string; content?: string }> }>;
  };
  const assistant = [...history.messages].reverse().find((message) => message.role === 'assistant');
  assert.ok(assistant, 'persisted assistant message missing');
  assert.equal(assistant.content, answer, 'persisted answer must equal the assembled final OpenCode answer');
  const progressTexts = (assistant.agentSteps || [])
    .filter((step) => step.type === 'public_text')
    .map((step) => String(step.content || '').trim())
    .filter(Boolean);
  if (progressTexts.length > 1) {
    const earlier = progressTexts.slice(0, -1).join('\n');
    assert.equal(
      assistant.content.includes(earlier) && earlier !== assistant.content.trim(),
      false,
      'persisted final reply still contains earlier OpenCode progress text'
    );
  }
  assert.ok(assistant.sources?.length, 'passive citation cards were not persisted');
  assert.ok(
    assistant.agentSteps?.some((step) => step.type === 'public_text'),
    'public text trace was not persisted'
  );

  return { conversationId, answer, chunks: chunks.length, eventCount: events.length };
}

async function testCancellation() {
  const controller = new AbortController();
  let sawToolCall = false;
  await assert.rejects(
    runOpenCodeChat(
      '读取 MANIFEST 并说明语料规模；必须先调用 read 工具。',
      {
        conversationId: crypto.randomUUID(),
        signal: controller.signal,
        onAgentStep: (step) => {
          if (step.type === 'tool_call') {
            sawToolCall = true;
            controller.abort();
          }
        }
      }
    ),
    /取消/
  );
  assert.equal(sawToolCall, true, 'cancellation did not interrupt an active OpenCode tool flow');
  return { cancelled: true };
}

async function testAttachmentFlow() {
  const marker = `STREAM-ATTACHMENT-${Date.now()}`;
  const form = new FormData();
  form.append(
    'files',
    new File(
      [`这是纯 OpenCode 附件流测试。唯一验证代号是 ${marker}。`],
      'pure-streaming-check.txt',
      { type: 'text/plain' }
    )
  );
  const upload = await fetch('http://127.0.0.1:3000/api/chat/attachments', {
    method: 'POST',
    body: form
  });
  assert.equal(upload.ok, true, `attachment upload failed: ${upload.status} ${await upload.text()}`);
  const uploaded = await upload.json() as {
    conversationId: string;
    attachments: Array<{ id: string; status: string }>;
  };
  assert.equal(uploaded.attachments[0]?.status, 'ready', 'attachment parsing did not complete');

  const response = await fetch('http://127.0.0.1:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: uploaded.conversationId,
      question: '附件中的唯一验证代号是什么？请读取附件 Markdown 并附路径行号。',
      attachmentIds: [uploaded.attachments[0].id],
      messages: []
    })
  });
  const events = await readApiEvents(response);
  const answer = events
    .filter((event): event is Extract<ApiStreamEvent, { type: 'chunk' }> => event.type === 'chunk')
    .map((event) => event.content)
    .join('');
  const finalMeta = [...events]
    .reverse()
    .find((event): event is Extract<ApiStreamEvent, { type: 'meta' }> => event.type === 'meta');
  assert.match(answer, new RegExp(marker));
  assert.ok(finalMeta?.sources?.length, 'attachment citation card was not derived passively');
  assert.ok(
    events.some((event) =>
      event.type === 'agent_step'
      && event.step.type === 'tool_call'
      && ['read', 'grep', 'bash'].includes(event.step.tool || '')
    ),
    'OpenCode did not read or grep the attachment Markdown'
  );
  return { conversationId: uploaded.conversationId, marker, answer };
}

async function main() {
  getDb();
  assert.equal(
    fs.existsSync(path.join(process.cwd(), '.opencode', 'agents', 'answer-finalizer.md')),
    false,
    'answer-finalizer agent must not exist'
  );
  const health = await getOpenCodeHealth();
  assert.equal(health.healthy, true, 'OpenCode sidecar must be healthy');
  if (process.argv.includes('--api')) {
    const result = await testApiStreamingOwnership();
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  if (process.argv.includes('--cancel')) {
    console.log(JSON.stringify({ ok: true, ...await testCancellation() }, null, 2));
    return;
  }
  if (process.argv.includes('--attachment')) {
    console.log(JSON.stringify({ ok: true, ...await testAttachmentFlow() }, null, 2));
    return;
  }
  const resumeIndex = process.argv.indexOf('--resume');
  if (resumeIndex >= 0) {
    const conversationId = String(process.argv[resumeIndex + 1] || '').trim();
    assert.ok(conversationId, '--resume requires a conversation id');
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(process.cwd(), 'scripts', 'opencode-sidecar.ps1'),
        'restart'
      ],
      {
        cwd: process.cwd(),
        // A long-lived sidecar can keep captured pipe handles open on Windows.
        // Ignoring stdio lets the management script return after spawning it.
        stdio: 'ignore',
        timeout: 30_000
      }
    );
    assert.equal((await getOpenCodeHealth()).healthy, true, 'sidecar must recover after restart');
    const followUp = await ask(
      conversationId,
      '他发过哪些文章？必须重新执行 grep/read 核验，列出目前语料能核实的题名，并严格区分全文收录与参考文献著录。'
    );
    assert.match(followUp.result.answer, /巨云涛|参考文献|著录|文章/);
    console.log(JSON.stringify({
      ok: true,
      resumedConversationId: conversationId,
      sessionId: followUp.result.metrics.sessionId,
      answer: followUp.result.answer,
      sources: followUp.result.sources.map((source) => source.matchReason),
      metrics: followUp.result.metrics,
      steps: followUp.result.agentSteps
    }, null, 2));
    return;
  }
  if (process.argv.includes('--count')) {
    const count = await ask(
      crypto.randomUUID(),
      '库里有几个清华大学的老师？请用阿拉伯数字给出精确数量，并说明 grep 范围。'
    );
    const oracle = Number(
      (getDb().prepare("SELECT COUNT(*) AS c FROM mentor_profiles WHERE school = '清华大学'").get() as { c: number }).c
    );
    assert.ok(
      count.result.answer.includes(String(oracle)),
      `OpenCode count did not match SQLite oracle ${oracle}: ${count.result.answer}`
    );
    console.log(JSON.stringify({
      ok: true,
      oracleTsinghuaMentors: oracle,
      answer: count.result.answer,
      sources: count.result.sources.map((source) => source.matchReason),
      metrics: count.result.metrics,
      steps: count.result.agentSteps
    }, null, 2));
    return;
  }

  const personConversation = crypto.randomUUID();
  const person = await ask(personConversation, '巨云涛是谁？请严格区分人物档案、正文作者、参考文献作者和普通提及。');
  assert.match(person.result.answer, /巨云涛/);
  assert.match(person.result.answer, /参考文献|著录|档案|证据/);
  if (process.argv.includes('--smoke')) {
    console.log(JSON.stringify({
      ok: true,
      opencodeVersion: health.version,
      question: person.question,
      answer: person.result.answer,
      sources: person.result.sources.map((source) => source.matchReason),
      metrics: person.result.metrics,
      steps: person.result.agentSteps
    }, null, 2));
    return;
  }
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(process.cwd(), 'scripts', 'opencode-sidecar.ps1'),
      'restart'
    ],
    {
      cwd: process.cwd(),
      stdio: 'ignore',
      timeout: 30_000
    }
  );
  assert.equal((await getOpenCodeHealth()).healthy, true, 'sidecar must recover after restart');

  const followUpContext = [
    `用户：${person.question}`,
    `助手：${person.result.answer}`
  ].join('\n');
  const works = await ask(
    personConversation,
    '他发过哪些文章？必须重新执行 grep/read 核验，并列出目前语料能核实的题名。',
    followUpContext
  );
  assert.match(works.result.answer, /巨云涛|他/);
  assert.match(works.result.answer, /基于|主动配电网|虚拟同步机|文章|文献/);
  assert.equal(
    works.result.metrics.sessionId,
    person.result.metrics.sessionId,
    'multi-turn conversation must reuse one OpenCode session'
  );
  if (process.argv.includes('--recovery')) {
    console.log(JSON.stringify({
      ok: true,
      recoveredConversationId: personConversation,
      sessionId: works.result.metrics.sessionId,
      firstAnswer: person.result.answer,
      followUpAnswer: works.result.answer,
      followUpSources: works.result.sources.map((source) => source.matchReason),
      followUpMetrics: works.result.metrics,
      followUpSteps: works.result.agentSteps
    }, null, 2));
    return;
  }

  const countConversation = crypto.randomUUID();
  const count = await ask(countConversation, '库里有几个清华大学的老师？请用阿拉伯数字给出精确数量，并说明 grep 范围。');
  const oracle = Number(
    (getDb().prepare("SELECT COUNT(*) AS c FROM mentor_profiles WHERE school = '清华大学'").get() as { c: number }).c
  );
  assert.ok(
    count.result.answer.includes(String(oracle)),
    `OpenCode count did not match SQLite oracle ${oracle}: ${count.result.answer}`
  );

  const inventoryConversation = crypto.randomUUID();
  const inventory = await ask(
    inventoryConversation,
    '当前 Markdown 语料分别有多少人物实体、导师、论文和专利？读取 MANIFEST 后逐项回答。'
  );
  const inventoryOracle = [
    Number((getDb().prepare("SELECT COUNT(*) AS c FROM entities WHERE type='person'").get() as { c: number }).c),
    Number((getDb().prepare('SELECT COUNT(*) AS c FROM mentor_profiles').get() as { c: number }).c),
    Number((getDb().prepare("SELECT COUNT(*) AS c FROM paper_documents WHERE paper_key NOT LIKE 'patent:%'").get() as { c: number }).c),
    Number((getDb().prepare("SELECT COUNT(*) AS c FROM paper_documents WHERE paper_key LIKE 'patent:%'").get() as { c: number }).c)
  ];
  for (const expected of inventoryOracle) {
    assert.ok(inventory.result.answer.includes(String(expected)), `inventory answer missing ${expected}`);
  }

  const runs = [person, works, count, inventory];
  console.log(JSON.stringify({
    ok: true,
    opencodeVersion: health.version,
    oracleTsinghuaMentors: oracle,
    runs: runs.map((run) => ({
      question: run.question,
      answer: run.result.answer,
      sources: run.result.sources.map((source) => source.matchReason),
      metrics: run.result.metrics,
      steps: run.result.agentSteps.map((step) => ({
        type: step.type,
        tool: step.tool,
        content: step.content,
        durationMs: step.durationMs
      }))
    }))
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
