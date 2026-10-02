import {
  BarChart3,
  FileBadge2,
  LibraryBig,
  type LucideIcon
} from 'lucide-react';

export type ComposerToolId = 'research-review' | 'patent' | 'chart-generation';

export const CHART_GENERATION_SKILL_ID = 'chart-discovery';

export const CHAT_COMPOSER_TOOLS: Array<{
  id: ComposerToolId;
  label: string;
  icon: LucideIcon;
}> = [
  {
    id: 'research-review',
    label: '科研传承助手',
    icon: LibraryBig
  },
  {
    id: 'patent',
    label: '专利生成',
    icon: FileBadge2
  },
  {
    id: 'chart-generation',
    label: '主动生成数据图',
    icon: BarChart3
  }
];

export const RESEARCH_REVIEW_WELCOME_PROMPTS = [
  '上传文献，开始写综述？',
  '今天要梳理哪个研究方向？',
  '准备好基于文献生成综述了吗？',
  '先上传论文或文献包？',
  '想从哪条研究主线写起？',
  '有哪些缺口值得提炼？'
];

export const PATENT_WELCOME_PROMPTS = [
  '上传交底，开始撰写？',
  '今天要准备哪件发明？',
  '把技术文档丢进来吧',
  '从哪份交底开始申请？'
];

export const CHART_GENERATION_WELCOME_PROMPTS = [
  '有数据要画成图吗？',
  '上传表格，开始出图？',
  '对比、趋势还是占比？',
  '准备好把结果画出来了吗？',
  '先从哪组数据画起？',
  '要看曲线还是柱状对比？'
];

export function composerToolFromSearch(tool: string | null): ComposerToolId | null {
  if (tool === 'research-review' || tool === 'patent' || tool === 'chart-generation') return tool;
  return null;
}

export function conversationKindForTool(tool: ComposerToolId | null): 'chat' | 'research-review' {
  return tool === 'research-review' ? 'research-review' : 'chat';
}

export function composerHref(tool: ComposerToolId | null) {
  return tool ? `/chat?tool=${tool}` : '/chat';
}

export function findComposerTool(id: ComposerToolId | null) {
  if (!id) return null;
  return CHAT_COMPOSER_TOOLS.find((item) => item.id === id) || null;
}
