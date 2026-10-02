import os from 'node:os';

export type FastImportOptions = {
  /** 默认 true：跳过已存在、延迟索引、多核解析 */
  fast?: boolean;
  /** PDF 解析并发；默认 CPU-1（夹在 4～12） */
  concurrency?: number;
  /** true 时末尾全量 rebuildSearchIndex；默认 false */
  fullRebuild?: boolean;
  /** true 时额外建 paper_chunk 分块索引（慢）；默认 false，仅文档级 */
  indexChunks?: boolean;
  /** 快速模式下是否仍跑知识图谱交叉链接；默认 false */
  crossLink?: boolean;
  /** 强制跳过 CAJ 转换 */
  skipCaj?: boolean;
};

export function defaultPaperConcurrency() {
  const env = Number(process.env.PAPER_INGEST_CONCURRENCY);
  if (Number.isFinite(env) && env >= 1) return Math.min(32, Math.floor(env));
  const cores = os.cpus()?.length || 4;
  return Math.max(4, Math.min(12, cores - 1));
}

/** 应用快速导入环境变量；返回规范化选项 */
export function applyFastImportEnv(options: FastImportOptions = {}) {
  const fast = options.fast !== false;
  const fullRebuild = options.fullRebuild === true;
  const indexChunks = options.indexChunks === true;
  const crossLink = options.crossLink === true;
  const concurrency = Math.max(
    1,
    Math.min(32, Number(options.concurrency) || defaultPaperConcurrency())
  );

  process.env.PAPER_INGEST_CONCURRENCY = String(concurrency);

  if (fast) {
    process.env.SKIP_EXISTING_PAPERS = '1';
    process.env.SKIP_EXISTING_MENTORS = '1';
    process.env.SKIP_EXISTING_PATENTS = '1';
    process.env.SKIP_INLINE_INDEX = '1';
  }

  if (options.skipCaj || process.env.SKIP_CAJ_CONVERT === '1') {
    process.env.SKIP_CAJ_CONVERT = '1';
  }

  return { fast, fullRebuild, indexChunks, crossLink, concurrency };
}
