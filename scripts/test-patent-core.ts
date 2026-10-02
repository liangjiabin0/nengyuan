import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createPatentProject,
  deletePatentProject,
  getPatentProjectDirectory,
  updatePatentProject
} from '../src/lib/patent-generation/store';
import {
  appendPatentRunEvent,
  claimPatentRun,
  createPatentRun,
  finishPatentRun,
  getPatentRun,
  requestPatentRunCancel
} from '../src/lib/patent-generation/run-store';
import { normalizePatentDraft } from '../src/lib/patent-generation/pipeline';
import { parsePatentSource } from '../src/lib/patent-generation/source-parser';
import { isLocalAdminHost } from '../src/lib/auth/request';

async function main() {
  const previousBypass = process.env.ALLOW_LOCAL_ADMIN_BYPASS;
  delete process.env.ALLOW_LOCAL_ADMIN_BYPASS;
  assert.equal(
    isLocalAdminHost(new Request('http://attacker.example/api', {
      headers: { host: 'attacker.example', 'x-forwarded-host': 'localhost' }
    })),
    false,
    '伪造 X-Forwarded-Host 不得获得本机管理员权限'
  );
  if (previousBypass === undefined) delete process.env.ALLOW_LOCAL_ADMIN_BYPASS;
  else process.env.ALLOW_LOCAL_ADMIN_BYPASS = previousBypass;

  const unrelated = normalizePatentDraft({
    title: '发明名称：花粉采样装置',
    abstract: '说明书摘要：一种花粉采样装置。',
    abstractFigure: '无',
    claims: '权利要求书\n1. 一种花粉采样装置，其特征在于，包括采样腔。',
    technicalField: '技术领域：环境监测',
    backgroundArt: '背景技术：现有采样器容易堵塞。',
    inventionSummary: '发明内容：通过可拆卸滤网减少堵塞。',
    drawingDescription: '附图说明：无',
    embodiments: '具体实施方式：采样腔内设置可拆卸滤网。\n\n采样腔内设置可拆卸滤网。'
  });
  assert.equal(unrelated.title, '花粉采样装置');
  assert.equal(
    unrelated.embodiments.match(/采样腔内设置可拆卸滤网/g)?.length,
    1,
    '格式归一只能去重，不能添加领域内容'
  );
  assert.doesNotMatch(JSON.stringify(unrelated), /数据中心|算力|热阻|排队冗余/);

  await assert.rejects(
    () => parsePatentSource('fake.pdf', Buffer.from('not a pdf')),
    /不是有效的 PDF/
  );
  await assert.rejects(
    () => parsePatentSource('fake.docx', Buffer.from('not a docx')),
    /不是有效的 Office/
  );

  const source = Buffer.from('# 一种花粉采样装置\n\n通过采样腔和可拆卸滤网采集空气中的花粉颗粒。');
  const parsed = await parsePatentSource('flower.md', source);
  assert.equal(parsed.metadata.title, '一种花粉采样装置');
  const project = await createPatentProject({
    name: 'flower.md',
    mediaType: 'text/markdown',
    buffer: source,
    parsed,
    userId: 'core-test-user'
  });
  assert.ok(project);

  try {
    const first = await createPatentRun(project!.id);
    const duplicate = await createPatentRun(project!.id);
    assert.equal(duplicate.id, first.id, '重复启动必须返回同一活动任务');
    assert.equal(claimPatentRun(first.id), true);
    assert.equal(claimPatentRun(first.id), false, '任务只能被一个执行器原子抢占');
    appendPatentRunEvent(first.id, {
      type: 'status',
      stage: 'disclosure',
      progress: 20,
      detail: '正在分析'
    });
    assert.equal(getPatentRun(first.id)?.progress, 20);
    requestPatentRunCancel(project!.id);
    assert.equal(getPatentRun(first.id)?.cancelRequested, true);
    finishPatentRun(first.id, 'cancelled', { detail: '测试取消' });

    const workspace = path.join(getPatentProjectDirectory(project!.id), 'opencode');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'STATUS.json'), '{"status":"ready"}');
    updatePatentProject(project!.id, { answers: { 'technical-boundary': '仅采用源文档明确方案' } });
    assert.equal(fs.existsSync(workspace), false, '技术答复变化必须清理旧 OpenCode 工作区');
  } finally {
    await deletePatentProject(project!.id);
  }

  console.log('PATENT_CORE_TEST=PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
