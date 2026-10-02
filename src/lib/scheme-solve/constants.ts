import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_UPLOAD_FILES,
  ATTACHMENT_PARSE_EXTENSIONS,
  ATTACHMENT_UPLOAD_EXTENSIONS
} from '@/lib/attachments/policy';

export const SCHEME_SOLVE_KIND = 'scheme-solve' as const;
export const SCHEME_SOLVE_API_BASE = '/api/scheme-solve';
export const SCHEME_SOLVE_ATTACHMENT_MAX_BYTES = ATTACHMENT_MAX_BYTES;
export const SCHEME_SOLVE_ATTACHMENT_MAX_UPLOAD_FILES = ATTACHMENT_MAX_UPLOAD_FILES;
export const SCHEME_SOLVE_CASE_EXTENSIONS = ['.m', '.mat'] as const;
export const SCHEME_SOLVE_MODEL_EXTENSIONS = ['.mps', '.lp'] as const;
export const SCHEME_SOLVE_PARSE_EXTENSIONS = new Set<string>([
  ...ATTACHMENT_PARSE_EXTENSIONS,
  ...SCHEME_SOLVE_CASE_EXTENSIONS,
  ...SCHEME_SOLVE_MODEL_EXTENSIONS
]);
export const SCHEME_SOLVE_ALLOWED_EXTENSIONS = new Set<string>([
  ...ATTACHMENT_UPLOAD_EXTENSIONS,
  ...SCHEME_SOLVE_CASE_EXTENSIONS,
  ...SCHEME_SOLVE_MODEL_EXTENSIONS
]);
export const SCHEME_SOLVE_ATTACHMENT_ACCEPT = [...SCHEME_SOLVE_ALLOWED_EXTENSIONS].join(',');
export const SCHEME_SOLVE_ATTACHMENT_HINT =
  'PDF/DOCX/MD/TXT/表格/JSON · MATPOWER .m/.mat · ESOPT .mps/.lp · ZIP 原样保存由助手处理 · 单文件最大 200MB · 一次最多 50 个';

export const SCHEME_BRAINSTORM_AGENT = 'scheme-brainstorm';
export const SCHEME_DESIGNER_AGENT = 'scheme-designer';
export const SCHEME_REVIEWER_AGENT = 'scheme-reviewer';
export const SCHEME_WRITER_AGENT = 'scheme-writer';

export const SCHEME_ESOPT_SKILL = 'esopt';
export const SCHEME_REPORT_SKILL = 'scheme-technical-report';

export const SCHEME_SESSION_FILE = 'storage/opencode-scheme-solve-sessions.json';
export const SCHEME_WORKSPACE_SCOPE = 'scheme-solve';

export const SCHEME_RESEARCH_CONCURRENCY = 2;
export const SCHEME_DESIGNER_TIMEOUT_MS = 3 * 60 * 1000;
export const SCHEME_REVIEWER_TIMEOUT_MS = 3 * 60 * 1000;
export const SCHEME_WRITER_TIMEOUT_MS = 4 * 60 * 1000;

export const SCHEME_STAGE_KEYS = [
  'idea',
  'design',
  'model',
  'solve',
  'review',
  'write',
  'report'
] as const;

export const SCHEME_PIPELINE_STAGES = SCHEME_STAGE_KEYS.filter((key) => key !== 'idea');

export const SCHEME_STAGE_LABELS: Record<(typeof SCHEME_STAGE_KEYS)[number], string> = {
  idea: '想法',
  design: '设计',
  model: '建模',
  solve: '求解',
  review: '审查',
  write: '撰写',
  report: '报告'
};

export const SCHEME_IDEA_AGENT_NODES = [
  { key: 'design', agent: SCHEME_DESIGNER_AGENT, label: '设计求解' }
] as const;

export const SCHEME_SHARED_AGENT_NODES = [
  { key: 'review', agent: SCHEME_REVIEWER_AGENT, label: '审查' },
  { key: 'write', agent: SCHEME_WRITER_AGENT, label: '撰写报告' }
] as const;

export const SCHEME_AGENT_NODES = [...SCHEME_IDEA_AGENT_NODES, ...SCHEME_SHARED_AGENT_NODES] as const;

export type SchemeAgentNodeKey = (typeof SCHEME_AGENT_NODES)[number]['key'];
