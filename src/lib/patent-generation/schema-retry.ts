import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import {
  readPatentWorkspaceJson,
  readPatentWorkspaceText,
  runOpenCodePatentSchemaRepair,
  writePatentWorkspaceJson
} from '@/lib/opencode/patent';
import type { PatentProgressEvent, PatentStage } from './types';

/** 结构校验失败后，最多让 OpenCode 带错重写的次数。 */
export const PATENT_SCHEMA_RETRY_MAX = 3;

export type SchemaRetryEmit = (event: PatentProgressEvent) => void | Promise<void>;

export function formatSchemaValidationError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return JSON.stringify(error.issues, null, 2);
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function parseLooseJson<T>(raw: unknown, schema: z.ZodType<T>): T {
  if (raw == null) return schema.parse({});
  if (typeof raw === 'string') {
    try {
      return schema.parse(JSON.parse(raw));
    } catch {
      return schema.parse(JSON.parse(jsonrepair(raw)));
    }
  }
  return schema.parse(raw);
}

export function tryParseLooseJson<T>(
  raw: unknown,
  schema: z.ZodType<T>
): { ok: true; value: T } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: parseLooseJson(raw, schema) };
  } catch (error) {
    return { ok: false, error };
  }
}

function buildSchemaValidationReport(input: {
  fileName: string;
  attempt: number;
  maxAttempts: number;
  error: unknown;
  parseFailed?: boolean;
}) {
  const issues = input.error instanceof z.ZodError
    ? input.error.issues
    : [{
        code: 'custom',
        path: [],
        message: formatSchemaValidationError(input.error)
      }];
  return {
    fileName: input.fileName,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    parseFailed: Boolean(input.parseFailed),
    issues,
    instruction: [
      `请只修复 ${input.fileName}，保持技术语义不变。`,
      '枚举字段必须使用系统允许值；字符串数组元素必须是字符串。',
      '输出合法 JSON（禁止 Markdown 代码块、禁止注释）。',
      '修完后覆盖写回该文件。'
    ].join('')
  };
}

export type SchemaRepairFn = typeof runOpenCodePatentSchemaRepair;

/**
 * 读取并校验工作区 JSON 产物；失败则写 SCHEMA_VALIDATION.json，
 * 调用 OpenCode 带错重写，最多重试 PATENT_SCHEMA_RETRY_MAX 次。
 */
export async function loadWorkspaceArtifactWithRetry<T>(input: {
  projectId: string;
  relativeDir: string;
  fileName: string;
  schema: z.ZodType<T>;
  stage: PatentStage;
  required?: boolean;
  signal?: AbortSignal;
  emit?: SchemaRetryEmit;
  onStep?: Parameters<typeof runOpenCodePatentSchemaRepair>[0]['onStep'];
  /** 测试可注入；默认走 OpenCode 结构修复。 */
  repairFn?: SchemaRepairFn;
  maxRetries?: number;
  /** 状态条进度；缺省不强制回退到 0。 */
  statusProgress?: number;
}): Promise<T | null> {
  const required = input.required !== false;
  const maxRetries = input.maxRetries ?? PATENT_SCHEMA_RETRY_MAX;
  const repair = input.repairFn || runOpenCodePatentSchemaRepair;
  const progress = input.statusProgress ?? 50;
  let lastError: unknown = new Error(`${input.fileName} 校验失败`);
  let lastParseFailed = false;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (input.signal?.aborted) {
      throw new Error('已取消生成。');
    }

    const raw = readPatentWorkspaceJson(input.projectId, input.fileName);
    const text = raw == null
      ? readPatentWorkspaceText(input.projectId, input.fileName)
      : null;

    if (raw == null && !text?.trim()) {
      lastError = new Error(`${input.fileName} 缺失或为空`);
      lastParseFailed = true;
      if (!required && attempt === 0) return null;
      if (attempt >= maxRetries) break;
    } else if (raw == null && text?.trim()) {
      lastError = new Error(
        `${input.fileName} JSON 无法解析（常见于过早 }, 或键值分隔符写错）。`
      );
      lastParseFailed = true;
      if (attempt >= maxRetries) break;
    } else {
      const parsed = tryParseLooseJson(raw, input.schema);
      if (parsed.ok) {
        try {
          writePatentWorkspaceJson(input.projectId, input.fileName, parsed.value);
        } catch {
          // best-effort rewrite of normalized shape
        }
        if (attempt > 0) {
          await input.emit?.({
            type: 'status',
            stage: input.stage,
            detail: `${input.fileName} 已在第 ${attempt} 次带错重试后通过校验。`,
            progress
          });
        }
        return parsed.value;
      }
      lastError = parsed.error;
      lastParseFailed = false;
      if (attempt >= maxRetries) break;
    }

    const nextAttempt = attempt + 1;
    writePatentWorkspaceJson(
      input.projectId,
      'SCHEMA_VALIDATION.json',
      buildSchemaValidationReport({
        fileName: input.fileName,
        attempt: nextAttempt,
        maxAttempts: maxRetries,
        error: lastError,
        parseFailed: lastParseFailed
      })
    );

    await input.emit?.({
      type: 'status',
      stage: input.stage,
      detail: `${input.fileName} 结构校验失败，正在第 ${nextAttempt}/${maxRetries} 次带错修复…`,
      progress
    });

    await repair({
      projectId: input.projectId,
      relativeDir: input.relativeDir,
      fileName: input.fileName,
      issuesText: formatSchemaValidationError(lastError),
      attempt: nextAttempt,
      maxAttempts: maxRetries,
      signal: input.signal,
      onStatus: (event) => input.emit?.({
        type: 'status',
        stage: input.stage,
        detail: event.detail || event.phase,
        progress
      }),
      onStep: input.onStep
    });
  }

  const detail = formatSchemaValidationError(lastError);
  throw new Error(
    `${input.fileName} 经 ${maxRetries} 次带错重试仍无法通过结构校验：${detail}`
  );
}
