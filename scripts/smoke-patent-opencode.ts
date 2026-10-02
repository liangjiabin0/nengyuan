import fs from 'node:fs';
import path from 'node:path';
import { parsePatentSource } from '../src/lib/patent-generation/source-parser';
import {
  createPatentProject,
  updatePatentProject
} from '../src/lib/patent-generation/store';
import {
  PATENT_OPENCODE_SESSION_FILE,
  patentWorkspaceAbsolute,
  preparePatentOpenCodeWorkspace,
  readPatentWorkspaceStatus
} from '../src/lib/opencode/patent';
import { runOpenCodeQuestion } from '../src/lib/opencode/runtime';

async function main() {
  const text = Array.from({ length: 40 }, (_, i) =>
    `本发明涉及电力系统调度方法。步骤${i + 1}：采集负荷数据，构建优化模型，求解调度方案并输出控制指令。`
  ).join('\n');
  const buffer = Buffer.from(`# 测试发明交底\n\n申请人：测试单位\n发明人：张三\n\n${text}`, 'utf8');
  const parsed = await parsePatentSource('smoke-patent.md', buffer);
  parsed.metadata.applicant = '测试单位有限公司';
  parsed.metadata.authors = ['张三'];

  let project = await createPatentProject({
    name: 'smoke-patent.md',
    mediaType: 'text/markdown',
    buffer,
    parsed
  });
  project = updatePatentProject(project!.id, {
    applicant: '测试单位有限公司',
    inventors: ['张三']
  })!;

  console.log('project', project.id, 'blockers', project.blockers.map((b) => `${b.id}:${b.resolved}`));

  const { relativeDir } = preparePatentOpenCodeWorkspace({
    project,
    priorArt: {
      queries: ['测试'],
      ipcCandidates: [],
      candidates: [],
      noveltyRisks: ['摘要级检索，未证明新颖性'],
      searchLimitations: ['smoke']
    }
  });
  const sourceExists = fs.existsSync(path.join(patentWorkspaceAbsolute(project.id), 'SOURCE.md'));
  console.log('workspace', relativeDir, sourceExists);

  const steps: string[] = [];
  const result = await runOpenCodeQuestion(
    [
      `这是冒烟测试。工作区：${relativeDir}/`,
      '请：1) 用 list 工具列出该工作区目录；2) 用 read 读取 SOURCE.md（limit=40）；3) 加载 skill patent-clarification；',
      `4) 用 write 写入 ${relativeDir}/blockers.json（一个 P0 技术问题）和 ${relativeDir}/STATUS.json 为 {"status":"needs_input"}；`,
      '5) 用一句中文确认完成。禁止 bash。不要撰写完整专利。'
    ].join('\n'),
    {
      conversationId: `patent-smoke:${project.id}:${Date.now()}`,
      sessionTitle: '专利冒烟',
      sessionMapFile: PATENT_OPENCODE_SESSION_FILE,
      agent: 'patent-drafter',
      skipCorpusCheck: true,
      rawPrompt: true,
      timeoutMs: 300_000,
      tools: {
        read: true,
        list: true,
        glob: true,
        grep: true,
        bash: false,
        edit: true,
        write: true,
        skill: true,
        task: false,
        webfetch: false,
        websearch: false,
        todowrite: false,
        lsp: false
      },
      onStep: (step) => {
        steps.push(`${step.type}${step.tool ? `:${step.tool}` : ''}`);
        process.stdout.write('.');
      }
    }
  );

  console.log('\nanswer', (result.answer || '').slice(0, 300));
  console.log('steps', steps.slice(0, 40).join(', '));
  const status = readPatentWorkspaceStatus(project.id);
  console.log('STATUS', status);
  console.log(
    'blockers file',
    fs.existsSync(path.join(patentWorkspaceAbsolute(project.id), 'blockers.json'))
  );
  if (!status?.status) {
    throw new Error('冒烟失败：未写入 STATUS.json');
  }
  console.log('smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
