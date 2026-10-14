import { z } from 'zod';

/** 持久化阶段，按执行顺序。前端据此区分复现、评审、PPT 和打包四大块。 */
export const PAPER_REVIEW_STAGES = [
  'preflight',
  'parse',
  'classify',
  'evidence_map',
  'dataset_discovery',
  'reproduction_design',
  'environment_check',
  'reproduction_execute',
  'reproduction_verify',
  'academic_review',
  'report_render',
  'ppt_plan',
  'ppt_build',
  'ppt_render_audit',
  'final_validation',
  'packaging'
] as const;
export type PaperReviewStage = (typeof PAPER_REVIEW_STAGES)[number];

export const STAGE_GROUPS: Record<PaperReviewStage, 'prepare' | 'reproduction' | 'review' | 'ppt' | 'package'> = {
  preflight: 'prepare',
  parse: 'prepare',
  classify: 'prepare',
  evidence_map: 'prepare',
  dataset_discovery: 'reproduction',
  reproduction_design: 'reproduction',
  environment_check: 'reproduction',
  reproduction_execute: 'reproduction',
  reproduction_verify: 'reproduction',
  academic_review: 'review',
  report_render: 'review',
  ppt_plan: 'ppt',
  ppt_build: 'ppt',
  ppt_render_audit: 'ppt',
  final_validation: 'package',
  packaging: 'package'
};

export const STAGE_LABELS: Record<PaperReviewStage, string> = {
  preflight: '运行前检查',
  parse: '解析论文',
  classify: '论文分类',
  evidence_map: '主张与证据矩阵',
  dataset_discovery: '数据来源',
  reproduction_design: '复现设计',
  environment_check: '环境检查',
  reproduction_execute: '执行复现',
  reproduction_verify: '复现核验',
  academic_review: '学术评审',
  report_render: '生成评审报告',
  ppt_plan: 'PPT 规划',
  ppt_build: 'PPT 构建',
  ppt_render_audit: 'PPT 渲染与审核',
  final_validation: '最终质量门禁',
  packaging: '打包'
};

/** 任务整体状态。partial/blocked 不能显示成“完成”。 */
export type PaperReviewStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type StageState = {
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'blocked';
  startedAt?: string;
  finishedAt?: string;
  detail?: string;
  /** 本阶段 manifest 的相对路径（storage/paper-review/<id>/ 下） */
  manifest?: string;
  cacheKey?: string;
};

export const REPRODUCTION_MODES = ['result_replication', 'principle_level', 'partial_execution', 'reporting_only'] as const;
export const REPRODUCTION_VERDICTS = ['verified_in_scope', 'partially_verified', 'not_supported_in_test', 'blocked', 'not_assessable'] as const;

export const optionsSchema = z.object({
  targetVenue: z.string().max(200).default(''),
  field: z.string().max(200).default(''),
  reproduce: z.boolean().default(true),
  dataPriority: z.enum(['public_first', 'local_licensed', 'simulated']).default('public_first'),
  timeBudgetMinutes: z.number().int().min(5).max(24 * 60).default(120),
  reproductionTimeoutMinutes: z.number().int().min(1).max(12 * 60).default(30),
  seed: z.number().int().min(0).max(2 ** 31 - 1).default(20261012),
  searchLatestLiterature: z.boolean().default(true),
  reportLanguage: z.enum(['auto', 'zh', 'en_zh']).default('auto'),
  reportDepth: z.enum(['standard', 'deep']).default('deep'),
  pptTemplate: z.enum(['auto', 'planning', 'forecasting', 'control', 'multi_contribution']).default('auto'),
  allowStormFallback: z.boolean().default(false),
  /** 作者代码 / 第三方脚本属于不可信代码，必须用户明确同意才执行 */
  allowUntrustedCode: z.boolean().default(false),
  /** 是否允许把论文内容发给外部模型（必须为 true 才能运行） */
  allowExternalModel: z.boolean().default(false),
  maxModelTokens: z.number().int().min(10_000).max(20_000_000).default(2_000_000)
});
export type PaperReviewOptions = z.infer<typeof optionsSchema>;

export type InputFile = {
  id: string;
  role: 'paper' | 'supplement' | 'code' | 'data' | 'previous_review' | 'author_response';
  name: string;
  size: number;
  sha256: string;
  /** storage/paper-review/<id>/inputs/ 下的相对路径 */
  path: string;
};

export type ArtifactEntry = {
  id: string;
  kind: 'review_docx' | 'review_md' | 'review_json' | 'ppt' | 'ppt_render' | 'reproduction' | 'figure' | 'zip' | 'log' | 'other';
  label: string;
  path: string;
  size: number;
  sha256: string;
  stage: PaperReviewStage;
  previewable: boolean;
};
