import fs from 'node:fs';
import path from 'node:path';
import { enqueueJob, isJobQueueEnabled } from '../jobs/queue';
import { cancelPaperReviewLocally, isPaperReviewRunning, startPaperReview } from './runner';
import { appendPaperReviewEvent, createPaperReviewTask, getPaperReviewTask, updatePaperReviewTask } from './store';
import { optionsSchema, PAPER_REVIEW_STAGES, type InputFile, type PaperReviewOptions, type PaperReviewStage } from './types';
import { ensureTaskDirs, safeFileName, sha256File, taskDir, writeFileAtomic } from './workspace';
import { buildPackage } from './stages-package';
import { freezeSkillsForTask } from './skills';
import { resolvePaperReviewPython } from './python';
import type { Ctx } from './stage-kit';

export const PAPER_REVIEW_MAX_FILE_BYTES = 200 * 1024 * 1024;
export const PAPER_REVIEW_MAX_FILES = 20;
const PAPER_EXT = new Set(['.pdf', '.docx', '.tex', '.txt', '.md']);
const OTHER_EXT = new Set(['.pdf', '.docx', '.tex', '.txt', '.md', '.zip', '.csv', '.json', '.xlsx', '.py', '.m', '.ipynb']);
const ROLES = new Set<InputFile['role']>(['paper', 'supplement', 'code', 'data', 'previous_review', 'author_response']);

/** 简单的文件内容嗅探，防止改扩展名上传。 */
function sniffOk(ext: string, head: Buffer) {
  if (ext === '.pdf') return head.subarray(0, 5).toString('latin1') === '%PDF-';
  if (ext === '.docx' || ext === '.xlsx' || ext === '.zip') return head[0] === 0x50 && head[1] === 0x4b;
  return true;
}

export async function createTaskFromUpload(userId: string, files: Array<{ name: string; role: string; buffer: Buffer }>, rawOptions: unknown) {
  const parsed = optionsSchema.safeParse(rawOptions || {});
  if (!parsed.success) throw new Error('评审设置不合法');
  const options: PaperReviewOptions = parsed.data;
  if (!files.length) throw new Error('请至少上传一篇论文');
  if (files.length > PAPER_REVIEW_MAX_FILES) throw new Error(`一次最多上传 ${PAPER_REVIEW_MAX_FILES} 个文件`);
  const papers = files.filter((f) => f.role === 'paper');
  if (papers.length !== 1) throw new Error('需要且只能指定一篇主论文（批量评审请分别创建任务）');
  const id = (await import('node:crypto')).randomUUID();
  const root = ensureTaskDirs(id);
  const inputs: InputFile[] = [];
  try {
    for (const [i, f] of files.entries()) {
      const role = (ROLES.has(f.role as InputFile['role']) ? f.role : 'supplement') as InputFile['role'];
      const ext = path.extname(f.name).toLowerCase();
      if (!(role === 'paper' ? PAPER_EXT : OTHER_EXT).has(ext)) throw new Error(`不支持的文件类型：${f.name}`);
      if (f.buffer.length > PAPER_REVIEW_MAX_FILE_BYTES) throw new Error(`文件超过 200 MB：${f.name}`);
      if (!sniffOk(ext, f.buffer)) throw new Error(`文件内容与扩展名不符：${f.name}`);
      const rel = `inputs/${String(i + 1).padStart(2, '0')}_${role}_${safeFileName(f.name, `file${ext}`)}`;
      writeFileAtomic(path.join(root, rel), f.buffer);
      inputs.push({ id: String(i + 1), role, name: f.name, size: f.buffer.length, sha256: sha256File(path.join(root, rel)), path: rel });
    }
    const paper = inputs.find((x) => x.role === 'paper')!;
    const task = await createPaperReviewTask({ id, userId, title: path.parse(paper.name).name.slice(0, 200), options, inputs, paperSha256: paper.sha256 });
    // 立即冻结技能快照，任务从创建起就固定用这一版技能
    await updatePaperReviewTask(id, { skills: freezeSkillsForTask(root) });
    await appendPaperReviewEvent(id, { text: `已创建任务：${inputs.length} 个文件，主论文 ${paper.name}` });
    return task;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** 开始/恢复/重跑。默认交给 worker 队列；没开队列时在当前进程后台运行。 */
export async function runTask(id: string, opts: { fromStage?: PaperReviewStage; force?: boolean } = {}) {
  const task = await getPaperReviewTask(id);
  if (!task) throw new Error('任务不存在');
  if (['queued', 'running'].includes(task.status) || isPaperReviewRunning(id)) return { mode: 'already-running' as const };
  if (opts.fromStage && !PAPER_REVIEW_STAGES.includes(opts.fromStage)) throw new Error('阶段不合法');
  await updatePaperReviewTask(id, { status: 'queued', error: null, cancelRequested: false });
  await appendPaperReviewEvent(id, { text: opts.fromStage ? `从「${opts.fromStage}」阶段重新运行` : '已排队，等待执行' });
  if (isJobQueueEnabled()) {
    const job = await enqueueJob('paper-review', { taskId: id, fromStage: opts.fromStage, force: opts.force === true });
    return { mode: 'queued' as const, jobId: job.id };
  }
  void startPaperReview(id, opts);
  return { mode: 'inline' as const };
}

export async function cancelTask(id: string) {
  await updatePaperReviewTask(id, { cancelRequested: true });
  const local = cancelPaperReviewLocally(id);
  const task = await getPaperReviewTask(id);
  if (task && task.status === 'queued' && !local) {
    await updatePaperReviewTask(id, { status: 'cancelled', cancelRequested: false, error: '用户已取消' });
  }
  await appendPaperReviewEvent(id, { level: 'warn', text: '已请求取消，正在停止当前步骤和子进程' });
}

/** 用户主动导出“部分成果草稿包”（门禁未全部通过时）。 */
export async function exportDraftPackage(id: string) {
  const task = (await getPaperReviewTask(id))!;
  const root = taskDir(id);
  const ctx = { task, root, signal: new AbortController().signal, python: resolvePaperReviewPython(), endpoint: null as never, log: async () => undefined } as Ctx;
  const result = await buildPackage(ctx, { draft: true });
  return result;
}
