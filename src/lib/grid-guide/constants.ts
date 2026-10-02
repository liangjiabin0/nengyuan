import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_UPLOAD_FILES,
  ATTACHMENT_PARSE_EXTENSION_SET,
  ATTACHMENT_UPLOAD_EXTENSION_SET
} from '@/lib/attachments/policy';

export const GRID_GUIDE_ATTACHMENT_MAX_FILES = ATTACHMENT_MAX_UPLOAD_FILES;
export const GRID_GUIDE_ATTACHMENT_MAX_BYTES = ATTACHMENT_MAX_BYTES;
export const GRID_GUIDE_ATTACHMENT_API_BASE = '/api/grid-guides';
export const GRID_GUIDE_ATTACHMENT_ACCEPT = ATTACHMENT_ACCEPT;
export const GRID_GUIDE_ATTACHMENT_EXTENSIONS = ATTACHMENT_UPLOAD_EXTENSION_SET;
export const GRID_GUIDE_ATTACHMENT_PARSE_EXTENSIONS = ATTACHMENT_PARSE_EXTENSION_SET;
export const GRID_GUIDE_ATTACHMENT_HINT =
  'PDF/DOCX/MD/TXT/表格/图片/JSON/ZIP · ZIP 会自动解压并抽取全文 · 单文件最大 200MB · 一次最多 50 个';
export const GRID_GUIDE_SKILL_NAME = 'sgcc-tech-guide';
export const GRID_GUIDE_AGENT = 'grid-guide-designer';
/** 国网指南走小模型思考「超高」档，便于长稿重写与综述综合 */
export const GRID_GUIDE_SMALL_THINKING = 'xhigh' as const;
export const GRID_GUIDE_SESSION_FILE = 'storage/opencode-grid-guide-sessions.json';
export const GRID_GUIDE_WORKSPACE_SCOPE = 'grid-guides';

export const GRID_GUIDE_RESERVED_ROOT_NAMES = new Set([
  'literature',
  'refs',
  '.opencode',
  'INDEX.md',
  'TASK.md',
  'knowledge-corpus'
]);

export const GRID_GUIDE_SKILL_REF_FILES = [
  'reusable-constraints.md',
  'writing-style-and-examples.md',
  'evidence-and-terminology.md',
  'source-extraction-and-web-supplement.md',
  'dense-single-document-summary.md',
  'evidence-system-and-incremental-build.md',
  'workflow-and-deliverables.md',
  'v7-required-deliverables.md',
  'fixed-guide-format.md',
  'qa-checklist.md'
] as const;
