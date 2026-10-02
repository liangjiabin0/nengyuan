import { generateGridGuide, normalizeGridGuideDocument, reviseGridGuideQuick } from './generator';
import { runGridGuideSkillTask } from '@/lib/opencode/grid-guide';
import {
  getStringAtPath,
  setStringAtPath,
  type DocumentPath
} from './document-paths';
import {
  addGridGuideMessage,
  getGridGuideProject,
  saveGridGuideDocument,
  saveGridGuideTaskResult,
  setGridGuideProgress,
  setGridGuideStatus
} from './store';
import { enqueueJob, hasActiveGridGuideJob, cancelQueuedGridGuideJobs, isJobQueueEnabled } from '@/lib/jobs/queue';
import type { GridGuideDocument } from './types';
import { readGeneratedProjectTitle, workspaceExists } from './workspace';

type ActiveTask = {
  promise: Promise<void>;
};

const globalTasks = globalThis as typeof globalThis & {
  __gridGuideTasks?: Map<string, ActiveTask>;
};

const tasks = globalTasks.__gridGuideTasks || new Map<string, ActiveTask>();
globalTasks.__gridGuideTasks = tasks;

export function isGridGuideTaskActive(projectId: string) {
  return tasks.has(projectId);
}

function usesSkillWorkspace(project: { document?: GridGuideDocument; taskFolder?: string; id: string }) {
  return !project.document || Boolean(project.taskFolder) || workspaceExists(project.id);
}

function mergeChangedPaths(
  base: GridGuideDocument,
  patch: GridGuideDocument,
  changedPaths: DocumentPath[]
) {
  const merged = structuredClone(base) as GridGuideDocument;
  for (const path of changedPaths) {
    const value = getStringAtPath(patch, path);
    if (value === null) continue;
    setStringAtPath(merged, path, value);
    if (path.length === 1 && path[0] === 'projectTitle') {
      merged.explanation.planningCorrespondence.guideName = value;
    }
    if (path[0] === 'guide' && path[1] === 'topicSetup' && typeof path[2] === 'number' && merged.guide.topics[path[2]]) {
      merged.guide.topics[path[2]]!.title = value;
    }
    if (
      path[0] === 'guide' &&
      path[1] === 'topics' &&
      typeof path[2] === 'number' &&
      path[3] === 'title' &&
      merged.guide.topicSetup[path[2]] !== undefined
    ) {
      merged.guide.topicSetup[path[2]] = value;
    }
  }
  return normalizeGridGuideDocument(merged);
}

export function startGridGuideTask(input: {
  projectId: string;
  instruction: string;
  selection?: string;
}) {
  const active = tasks.get(input.projectId);
  if (active) return active.promise;

  const promise = (async () => {
    try {
      const project = await getGridGuideProject(input.projectId);
      if (!project) throw new Error('项目指南不存在。');
      let latestProgress = 3;
      await setGridGuideProgress(input.projectId, latestProgress, '正在读取项目构想与历史草稿');
      const onProgress = async (progress: number, detail: string) => {
        const next = Math.max(latestProgress, Math.min(99, progress));
        if (next === latestProgress && progress < latestProgress) return;
        latestProgress = next;
        await setGridGuideProgress(input.projectId, next, detail);
      };

      if (usesSkillWorkspace(project)) {
        const generated = await runGridGuideSkillTask({
          project,
          instruction: input.instruction,
          selection: input.selection,
          onProgress
        });
        await saveGridGuideTaskResult(input.projectId, {
          taskFolder: generated.taskFolder,
          title: readGeneratedProjectTitle(input.projectId, generated.taskFolder) || generated.taskFolder,
          summary: `已写入 ${generated.fileCount} 个成果文件`
        });
        await addGridGuideMessage(input.projectId, 'assistant', generated.summary);
        return;
      }

      const needsFullGeneration =
        !project.document ||
        /重新检索|检索数据库|查询数据库|联网检索|最新技术|技术对标|重新生成整篇|重新生成完整|全面重构|全面重新设计|重做整篇|新增课题|删除课题|调整课题结构/.test(
          input.instruction
        );
      if (needsFullGeneration) {
        const generated = await generateGridGuide({
          project,
          instruction: input.instruction,
          selection: input.selection,
          onProgress
        });
        await saveGridGuideDocument(input.projectId, generated.document);
        await addGridGuideMessage(input.projectId, 'assistant', generated.summary);
      } else {
        const generated = await reviseGridGuideQuick({
          project,
          instruction: input.instruction,
          selection: input.selection,
          onProgress
        });
        const latest = await getGridGuideProject(input.projectId);
        const base = latest?.document || project.document!;
        const merged = mergeChangedPaths(base, generated.document, generated.changedPaths);
        await saveGridGuideDocument(input.projectId, merged);
        await addGridGuideMessage(input.projectId, 'assistant', generated.summary);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '项目指南生成失败。';
      await setGridGuideStatus(input.projectId, 'failed', message);
      await addGridGuideMessage(input.projectId, 'assistant', `本轮处理失败：${message}`);
      throw error;
    } finally {
      await cancelQueuedGridGuideJobs(input.projectId);
      tasks.delete(input.projectId);
    }
  })();

  tasks.set(input.projectId, { promise });
  return promise;
}

/** 服务重启后，访问生成中的项目时从已落库的用户消息自动续跑。 */
export async function resumeGridGuideTask(projectId: string) {
  if (tasks.has(projectId)) return;
  const project = await getGridGuideProject(projectId);
  if (!project || project.status !== 'generating') return;
  if (isJobQueueEnabled() && await hasActiveGridGuideJob(projectId)) return;
  const latestUserMessage = [...project.messages].reverse().find((item) => item.role === 'user');
  const skill = usesSkillWorkspace(project);
  const instruction = project.document || project.taskFolder
    ? latestUserMessage?.content || '请继续完善当前指南成果。'
    : skill
      ? '请按 sgcc-tech-guide 与 v7-required-deliverables.md，在本次任务文件夹中一次性逐一编制 V7 全量成果树，并检索库内与网络证据。'
      : '请同时检索库内已有技术与网络最新技术，完成创新对标后，设计一份完整、创新、可落地的总部科技项目指南及编制说明，并在对话中完整说明拟议新内容相对已有与最新方向的区别。';
  const payload = {
    projectId,
    instruction,
    selection: project.document ? latestUserMessage?.selection : undefined
  };
  if (isJobQueueEnabled()) {
    await enqueueJob('grid-guide-task', payload);
  } else {
    void startGridGuideTask(payload).catch((error) => {
      console.error('[grid-guide] resumed task failed', error);
    });
  }
}
