import fs from 'node:fs';
import path from 'node:path';
import { createChatConversation } from '../src/lib/chat-history';
import { storeResearchReviewUpload } from '../src/lib/research-review/attachments';
import { RESEARCH_REVIEW_KIND } from '../src/lib/research-review/constants';
import { buildResearchReviewDocx } from '../src/lib/research-review/export';

const zipPath =
  process.argv[2]
  || 'c:\\Users\\Lenovo\\Documents\\xwechat_files\\wxid_o4nwipkfsukc12_5966\\msg\\file\\2026-08\\微网韧性相关文献.zip';

async function main() {
  if (!fs.existsSync(zipPath)) {
    throw new Error(`ZIP not found: ${zipPath}`);
  }

  const conversationId = crypto.randomUUID();
  await createChatConversation(conversationId, '综述测试', undefined, undefined, RESEARCH_REVIEW_KIND);
  console.log('conversationId', conversationId);
  console.log('loading zip…', zipPath, fs.statSync(zipPath).size);

  const buffer = fs.readFileSync(zipPath);
  const started = Date.now();
  const result = await storeResearchReviewUpload(conversationId, {
    name: path.basename(zipPath),
    type: 'application/zip',
    buffer
  });

  console.log(JSON.stringify({
    ms: Date.now() - started,
    ready: result.attachments.length,
    failed: result.failed.length,
    extractedFromZip: result.extractedFromZip,
    names: result.attachments.slice(0, 30).map((item) => item.name),
    failedSample: result.failed.slice(0, 15)
  }, null, 2));

  const sampleDocx = await buildResearchReviewDocx(
    [
      '# 微网韧性综述（导出自检）',
      '',
      '本文用于验证 DOCX 导出链路。文中引用示例见下[1]。',
      '',
      '## 文献回顾',
      '',
      '现有研究围绕微网韧性评估与提升路径展开。'
    ].join('\n'),
    '微网韧性综述自检'
  );
  const out = path.join(process.cwd(), 'outputs', 'research-review-export-smoke.docx');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, sampleDocx);
  console.log('docx written', out, sampleDocx.length);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
