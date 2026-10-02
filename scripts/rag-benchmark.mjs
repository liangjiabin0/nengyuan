/**
 * RAG 分级测试：20 题，调用 /api/chat 流式接口
 * 用法: node scripts/rag-benchmark.mjs [baseUrl]
 */

const BASE = process.argv[2] || 'http://localhost:3000';

const CASES = [
  { id: 'L0-1', level: 'L0 闲聊', question: '你好' },
  { id: 'L0-2', level: 'L0 闲聊', question: '你能做什么' },
  { id: 'L1-1', level: 'L1 简单', question: '数据库里一共有多少个项目？' },
  { id: 'L1-2', level: 'L1 简单', question: '有哪些机构出现在项目数据里？' },
  { id: 'L1-3', level: 'L1 简单', question: '项目数据里有没有关于综合能源的内容？' },
  { id: 'L2-1', level: 'L2 列表', question: '2026 年中国综合能源系统相关项目有哪些？' },
  { id: 'L2-2', level: 'L2 列表', question: '列出与光热发电相关的项目' },
  { id: 'L2-3', level: 'L2 列表', question: '有哪些成果或论文标题里包含 MPPC？' },
  { id: 'L2-4', level: 'L2 列表', question: '请列举虚拟电厂相关的研究项目' },
  { id: 'L3-1', level: 'L3 论文', question: 'MPPC 模型预测控制出现在哪些论文或文件里？' },
  { id: 'L3-2', level: 'L3 论文', question: '有哪些论文讨论了构网型变流器或 GFM？' },
  { id: 'L3-3', level: 'L3 论文', question: '请解释某篇论文里用到的损失函数或评价指标（基于已导入正文）' },
  { id: 'L3-4', level: 'L3 论文', question: '电力现货市场调度优化在文献中怎么描述的？' },
  { id: 'L4-1', level: 'L4 引用', question: '已导入论文之间存在交叉引用关系吗？请基于证据说明' },
  { id: 'L4-2', level: 'L4 引用', question: '哪些论文的参考文献里提到了光热或 CSP 相关内容？' },
  { id: 'L5-1', level: 'L5 统计', question: '项目数据里 2024 和 2025 年的项目数量各有多少？' },
  { id: 'L5-2', level: 'L5 统计', question: '按机构统计，哪个机构出现的项目最多？' },
  { id: 'L6-1', level: 'L6 语义', question: 'concentrated solar power 相关研究有哪些？（不要用中文关键词）' },
  { id: 'L6-2', level: 'L6 语义', question: 'VPP 虚拟电厂 和 需求响应 在项目或论文里有什么关联？' },
  { id: 'L6-3', level: 'L6 综合', question: '对比综合能源系统与光热发电两类项目的主要研究方向差异' }
];

async function askOne(testCase) {
  const started = Date.now();
  let firstChunkMs = null;
  let answer = '';
  let sources = 0;
  let confidence = '';
  let intent = '';
  let error = '';
  let statusPhases = [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);

  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: testCase.question, messages: [] }),
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === 'status') statusPhases.push(event.phase);
        if (event.type === 'meta') {
          sources = Array.isArray(event.sources) ? event.sources.length : 0;
          confidence = event.confidence || '';
          intent = event.intent || '';
        }
        if (event.type === 'chunk') {
          if (firstChunkMs === null) firstChunkMs = Date.now() - started;
          answer += event.content || '';
        }
        if (event.type === 'error') error = event.error || 'unknown';
      }
      if (done) break;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  const totalMs = Date.now() - started;
  const noResult = /没有找到|没有生成|证据不足且未检索/.test(answer) || (sources === 0 && !/你好|不客气|我是研究院/.test(answer.slice(0, 40)));

  return {
    ...testCase,
    ok: !error,
    totalMs,
    firstChunkMs: firstChunkMs ?? totalMs,
    sources,
    confidence,
    intent,
    statusPhases: [...new Set(statusPhases)].join('→'),
    answerPreview: answer.replace(/\s+/g, ' ').slice(0, 120),
    answerLen: answer.length,
    noResult,
    error: error.slice(0, 120)
  };
}

async function main() {
  console.log(`RAG benchmark @ ${BASE}\n`);
  try {
    const health = await fetch(`${BASE}/api/stats`, { signal: AbortSignal.timeout(30000) });
    if (!health.ok) throw new Error(`stats ${health.status}`);
    const stats = await health.json();
    console.log('Stats:', JSON.stringify(stats));
  } catch (e) {
    console.error('服务不可用，请先 npm run dev:', e.message);
    process.exit(1);
  }

  const results = [];
  for (const testCase of CASES) {
    process.stdout.write(`[${testCase.id}] ${testCase.question.slice(0, 36)}… `);
    const result = await askOne(testCase);
    results.push(result);
    const flag = !result.ok ? 'ERR' : result.noResult ? 'MISS' : 'OK';
    console.log(`${flag} ${(result.totalMs / 1000).toFixed(1)}s src=${result.sources} ${result.confidence || '-'}`);
  }

  console.log('\n--- 汇总 ---');
  const ok = results.filter((r) => r.ok && !r.noResult).length;
  const miss = results.filter((r) => r.ok && r.noResult).length;
  const err = results.filter((r) => !r.ok).length;
  const avgMs = Math.round(results.reduce((s, r) => s + r.totalMs, 0) / results.length);
  console.log(`通过(有证据回答): ${ok}/20 | 空结果: ${miss} | 错误: ${err} | 平均耗时: ${(avgMs / 1000).toFixed(1)}s`);

  console.log('\n--- 明细 ---');
  console.table(
    results.map((r) => ({
      id: r.id,
      level: r.level,
      ok: r.ok && !r.noResult ? '✓' : r.ok ? '△' : '✗',
      s: r.totalMs,
      src: r.sources,
      conf: r.confidence || '-',
      intent: r.intent || '-',
      preview: r.answerPreview
    }))
  );

  const outPath = new URL('../storage/rag-benchmark-latest.json', import.meta.url);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname } = await import('node:path');
  const outFile = fileURLToPath(outPath);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));
  console.log(`\n完整结果: ${outFile}`);
}

main();
