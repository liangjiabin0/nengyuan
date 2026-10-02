import { runOpenCodeQuestion } from './runtime';
import {
  listReadyGridGuideAttachmentRows
} from '@/lib/grid-guide/attachments';
import {
  GRID_GUIDE_AGENT,
  GRID_GUIDE_SESSION_FILE,
  GRID_GUIDE_SKILL_NAME,
  GRID_GUIDE_SMALL_THINKING
} from '@/lib/grid-guide/constants';
import type { GridGuideProject } from '@/lib/grid-guide/types';
import { formatMissingDeliverables, listMissingDerivedFiles } from '@/lib/grid-guide/v7-manifest';
import type { GridGuideLiteratureIngest } from '@/lib/grid-guide/literature-ingest';
import {
  assessTaskDeliverables,
  prepareGridGuideWorkspace,
  resolveTaskFolderName,
  materializeGridGuideDerived,
  gridGuideTaskDirectory
} from '@/lib/grid-guide/workspace';

const GRID_GUIDE_TOOL_POLICY = {
  read: true,
  list: true,
  glob: true,
  grep: true,
  bash: true,
  edit: true,
  write: true,
  skill: true,
  task: false,
  webfetch: true,
  websearch: true,
  todowrite: true,
  lsp: false
} as const;

export type GridGuideSkillStatus = {
  phase: string;
  detail: string;
};

function buildSkillPrompt(input: {
  project: GridGuideProject;
  instruction: string;
  selection?: string;
  suggestedTaskName: string;
  attachmentPaths: Array<{ name: string; relativePath: string; originalRelativePath?: string }>;
  existingTaskFolder?: string;
  literature?: GridGuideLiteratureIngest;
}) {
  const selection = input.selection?.trim()
    ? `用户在预览中选中的原文：\n<selection>\n${input.selection.trim()}\n</selection>`
    : '';
  const literature = input.literature;
  const attachments = input.attachmentPaths.length
    ? [
        literature?.documentCount
          ? `附件已解压并抽取全文 ${literature.documentCount} 份，先 read literature/extracted/INDEX.md 与任务文件夹中的 01_全文提取。`
          : '附件已放入 literature/。',
        ...input.attachmentPaths
          .slice(0, 12)
          .map((item, index) => `${index + 1}. ${item.name} → ${item.originalRelativePath || item.relativePath}`)
      ].join('\n')
    : '本轮没有附件。';
  const taskRule = input.existingTaskFolder
    ? `已有任务文件夹 \`./${input.existingTaskFolder}/\`。本轮是修订：在该目录内更新文件，不要另建平行任务文件夹。`
    : `任务文件夹已预创建为 \`./${input.suggestedTaskName}/\`。禁止另建平行文件夹。读完 TASK.md 后立刻扩写 \`./${input.suggestedTaskName}/00_项目总体/01_输入与范围/范围说明.md\`，然后再检索。`;
  const rewriteRule = literature?.manuscriptRelative
    ? [
        '本轮主交付是证据接地的重写稿，不是 800 字七段填空。',
        '先完整阅读 `literature/extracted/manuscript.md` 与足够多的 `01_全文提取` 全文。',
        '把重写稿写入 `05_正式成果/重写稿.md`：保持原稿结构，重点扩写第一、二章（第二章蓝色给定正文基本保持，2.3以后不改），按主题综合文献，禁止页眉/基金项目/题录切片。汉字不得低于原稿，第一、二章须写成综述级，不是骨架填空。',
        '决策版研究综述同步写成综述级深度。七段指南与 guide.json 仍要写，字段必须是 functional_requirements / key_technologies / topics[].metrics.performance|validation|outputs。'
      ].join('\n')
    : '按 V7 清单编制正式指南。高密度总结必须读完全文后写，禁止用页眉或基金项目充数。';

  return [
    '你正在「国网指南设计」中编制总部科技项目指南 V7 全量成果树。偷懒、空骨架、合并多篇总结、用文件名当标题，一律视为失败。',
    `必须先用 skill 工具加载 \`${GRID_GUIDE_SKILL_NAME}\`，再读 refs/v7-required-deliverables.md、refs/dense-single-document-summary.md、refs/corpus-hits.md。其余 refs 按需再读，禁止先把全部参考读完再检索。`,
    '当前工作目录=本项目隔离目录。先 read TASK.md 和 INDEX.md。',
    taskRule,
    rewriteRule,
    [
      '检索与阅读纪律：',
      '- 先 read `refs/corpus-hits.md` 列出的 `knowledge-corpus/...` 文件。没有命中再 grep `knowledge-corpus/papers`。',
      '- 有文献抽取时，优先 read `literature/extracted/INDEX.md` 和 `01_全文提取`，不要只看文件名。',
      '- 禁止 `patents/patents`、禁止 `../../knowledge-corpus`、禁止 glob `*`、禁止 list 语料根。',
      '- 同一 path 失败一次立即换分域或改 web_search，禁止反复重试。',
      '- 读多少由你根据证据需要自行决定；read 不会被系统截断。不要因为怕长而不读全文。',
      '- 读到的每份资料都要同时写详细版、高密度 V7、一页版，资料 ID 完全一致。高密度必须正式中文题名 + 核心结论 + 恰好 5 个二级专章，正文不少于 1500 汉字，复杂资料可以更长。'
    ].join('\n'),
    '本轮必须按清单逐一落盘 V7 必须成果：总体证据系统、每份资料的详细版/高密度V7/一页版、每个课题的综述/设计/指南/证据映射、以及 05_正式成果 的可编辑源文件。缺一项不得宣称完成。',
    '格式、体例、课题—需求—技术对应关系必须与 V7 样例一致；正式成果保持 Markdown/JSON/DOCX/XLSX 可修改，禁止 V6 副本、page-*.png、contact sheet 和渲染底稿。',
    '用户构想 + 知识库 + 附件即可出正式指南，不要因为缺少单独的研究方向文件而停止。',
    `建议任务名：${input.suggestedTaskName}`,
    `用户构想：\n${input.project.idea}`,
    `本轮要求：\n${input.instruction}`,
    selection,
    `附件：\n${attachments}`,
    '每完成一阶段立刻 write/edit 落盘。公开回复只写中文摘要：任务文件夹、课题数、关键路径、未完成项。'
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildFillPrompt(taskFolder: string, idea: string, missing: string, literature?: GridGuideLiteratureIngest) {
  const rewrite = literature?.manuscriptRelative
    ? '若重写稿或决策版偏短，继续基于 01_全文提取 扩写，不要另起空骨架。'
    : '';
  return [
    `已有任务文件夹 \`./${taskFolder}/\`。本轮只补齐缺失的 V7 必须成果，不要另建平行文件夹。`,
    '先 read refs/v7-required-deliverables.md 和 literature/extracted/INDEX.md（若存在），再按下列缺失项逐一 write/edit。',
    missing || '请补齐课题综述、高密度总结、guide.json 与正式成果源文件。',
    rewrite,
    '保持已有文件的格式、体例和课题对应关系；禁止 V6 副本与 page-*.png。高密度总结禁止页眉/基金项目切片。',
    `用户构想：\n${idea}`
  ].join('\n\n');
}

function buildDeepenPrompt(taskFolder: string, idea: string, missing: string, literature?: GridGuideLiteratureIngest) {
  return [
    `已有任务文件夹 \`./${taskFolder}/\`。本轮是加深，不是交差。禁止用空骨架或预检索题录冒充完成。`,
    literature?.manuscriptRelative
      ? '主任务：基于 literature/extracted 与 原稿.md，把 05_正式成果/重写稿.md 写到综述级深度（第一、二章按主题综合文献，汉字不得低于原稿），同步加深决策版研究综述和各课题综述。'
      : '主任务：把高密度总结、决策版综述和课题综述写到真正读完全文后的深度。',
    '缺失或质量问题：',
    missing,
    'read 需要的全文，再 write/edit。不要再穷举检索。',
    `用户构想：\n${idea}`
  ].join('\n\n');
}

export async function runGridGuideSkillTask(input: {
  project: GridGuideProject;
  instruction: string;
  selection?: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, detail: string) => void;
}): Promise<{
  summary: string;
  taskFolder: string;
  fileCount: number;
}> {
  input.onProgress?.(4, '正在准备隔离工作区');
  const rows = await listReadyGridGuideAttachmentRows(input.project.id);
  const existingTaskFolder = resolveTaskFolderName(input.project.id, input.project.taskFolder);
  const { workingDirectory, attachmentPaths, suggestedTaskName, literature } = prepareGridGuideWorkspace(
    input.project.id,
    input.project.idea,
    rows,
    {
      suggestedTaskName: existingTaskFolder || input.project.taskFolder || input.project.title,
      onProgress: (status) => input.onProgress?.(8, status.detail)
    }
  );

  const runPass = async (
    prompt: string,
    conversationId: string,
    sessionTitle: string,
    progress: number
  ) => {
    await runOpenCodeQuestion(prompt, {
      conversationId,
      sessionTitle,
      sessionMapFile: GRID_GUIDE_SESSION_FILE,
      agent: GRID_GUIDE_AGENT,
      workingDirectory,
      rawPrompt: true,
      skipCorpusCheck: true,
      modelRole: 'small',
      smallThinking: GRID_GUIDE_SMALL_THINKING,
      signal: input.signal,
      timeoutMs: 0,
      tools: { ...GRID_GUIDE_TOOL_POLICY },
      onStatus: ({ detail }) => input.onProgress?.(progress, detail || sessionTitle),
      onStep: (step) => {
        const tool = String(step.tool || '').toLowerCase();
        if (step.type === 'tool_call' && (tool === 'write' || tool === 'edit')) {
          const current = assessTaskDeliverables(input.project.id, existingTaskFolder);
          input.onProgress?.(progress, `正在写入成果文件 · 已落盘 ${current.fileCount} 个`);
        }
      }
    });
  };

  let observedSteps = 0;
  input.onProgress?.(12, '正在加载指南编制 skill');
  let result: { answer: string };
  try {
    result = await runOpenCodeQuestion(
      buildSkillPrompt({
        project: input.project,
        instruction: input.instruction,
        selection: input.selection,
        suggestedTaskName,
        attachmentPaths,
        existingTaskFolder,
        literature
      }),
      {
        conversationId: `grid-guide:${input.project.id}`,
        sessionTitle: '国网指南设计',
        sessionMapFile: GRID_GUIDE_SESSION_FILE,
        agent: GRID_GUIDE_AGENT,
        workingDirectory,
        rawPrompt: true,
        skipCorpusCheck: true,
        modelRole: 'small',
        smallThinking: GRID_GUIDE_SMALL_THINKING,
        signal: input.signal,
        timeoutMs: 0,
        tools: { ...GRID_GUIDE_TOOL_POLICY },
        onStatus: ({ detail }) => input.onProgress?.(14, detail || '正在分析项目构想'),
        onStep: (step) => {
          observedSteps += 1;
          const assessment = assessTaskDeliverables(input.project.id, existingTaskFolder);
          const fileBoost = Math.min(18, assessment.fileCount);
          const progress =
            step.type === 'synthesis'
              ? Math.min(88, 70 + fileBoost)
              : Math.min(68, 16 + observedSteps * (step.type === 'tool_call' ? 3 : 2) + fileBoost);
          const tool = String(step.tool || '').toLowerCase();
          const detail =
            step.type === 'tool_call'
              ? tool === 'skill'
                ? '正在加载指南编制规范'
                : tool === 'write' || tool === 'edit'
                  ? `正在写入成果文件${assessment.fileCount ? ` · 已落盘 ${assessment.fileCount} 个` : ''}`
                  : tool.includes('web')
                    ? '正在检索网络公开技术与标准'
                    : `正在检索和分析资料${step.tool ? ` · ${step.tool}` : ''}`
              : step.type === 'synthesis'
                ? '正在汇总本轮成果'
                : '正在整理证据与课题设计';
          input.onProgress?.(progress, detail);
        }
      }
    );
  } catch (error) {
    input.onProgress?.(
      85,
      `能元首轮未完整结束，改为按已落盘文件补齐。${
        error instanceof Error ? error.message.slice(0, 80) : ''
      }`
    );
    result = { answer: '' };
  }

  input.onProgress?.(86, '正在核对 V7 必须成果');
  const taskFolder = resolveTaskFolderName(input.project.id, existingTaskFolder || suggestedTaskName);
  if (!taskFolder) {
    throw new Error('能元未在工作目录下创建本次任务文件夹。');
  }
  const taskDir = gridGuideTaskDirectory(input.project.id, taskFolder);
  if (taskDir) {
    input.onProgress?.(88, '正在生成可编辑派生成果');
    try {
      const built = await materializeGridGuideDerived(taskDir);
      if (built.attempted && built.error && !built.output) {
        input.onProgress?.(89, '固定版式 Word 将保留 JSON，可稍后生成');
      }
    } catch (error) {
      input.onProgress?.(
        89,
        `派生成果部分失败，继续按已落盘文件核对。${
          error instanceof Error ? error.message.slice(0, 80) : ''
        }`
      );
    }
  }
  let assessment = assessTaskDeliverables(input.project.id, taskFolder);
  if (taskDir && !assessment.ready) {
    const missing = formatMissingDeliverables(assessment);
    input.onProgress?.(90, `正在补齐缺失的必须成果（${assessment.missing.length} 项）`);
    try {
      await runPass(
        buildFillPrompt(taskFolder, input.project.idea, missing, literature),
        `grid-guide:${input.project.id}:fill`,
        '国网指南补齐',
        91
      );
    } catch {
      // 补齐失败仍走加深，而不是模板交差。
    }
    try {
      await materializeGridGuideDerived(taskDir);
    } catch {
      // 派生失败不阻断加深。
    }
    assessment = assessTaskDeliverables(input.project.id, taskFolder);
  }
  if (taskDir && !assessment.ready) {
    const missing = formatMissingDeliverables(assessment);
    input.onProgress?.(93, '正在按全文加深重写，禁止用模板交差');
    try {
      await runPass(
        buildDeepenPrompt(taskFolder, input.project.idea, missing, literature),
        `grid-guide:${input.project.id}:deepen`,
        '国网指南加深',
        94
      );
    } catch {
      // 加深失败后按真实质量门禁报错。
    }
    try {
      await materializeGridGuideDerived(taskDir);
    } catch {
      // 派生失败仍按门禁报真实缺项。
    }
    assessment = assessTaskDeliverables(input.project.id, taskFolder);
  }
  const derivedMissing = taskDir ? listMissingDerivedFiles(taskDir) : ['05_正式成果/指南建议稿.docx'];
  if (!assessment.ready || derivedMissing.length) {
    const detail = [formatMissingDeliverables(assessment), ...derivedMissing.map((item) => `派生文件：${item}`)]
      .filter(Boolean)
      .join('\n');
    throw new Error(`V7 必须成果未齐：\n${detail || '成果树不完整'}`);
  }

  const summary =
    result.answer.replace(/\s+/g, ' ').trim() ||
    (existingTaskFolder
      ? `已根据你的意见更新任务文件夹「${taskFolder}」。`
      : `已在任务文件夹「${taskFolder}」写入指南成果。`);

  return {
    summary,
    taskFolder,
    fileCount: assessTaskDeliverables(input.project.id, taskFolder).fileCount
  };
}
