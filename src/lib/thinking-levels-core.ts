// 【重建】原文件已丢失。主体按 dist/runtime/api-app.mjs 与前端 chunk 9413 还原；
// stepThinkingRatio / snapThinkingIdToLevels 在编译产物中被 tree-shake 掉，按调用处语义重写。
import type { ChatModelId } from './model-ids';

export type ThinkingLevel = {
  id: string;
  label: string;
  description: string;
  /** OpenCode 模型 variant；关闭思考时没有 */
  variant?: string;
  /** reasoning_effort；关闭思考时没有 */
  effort?: string;
};

export type ThinkingCatalog = {
  model: ChatModelId;
  levels: ThinkingLevel[];
  source: 'probe' | 'fallback';
  detectedAt: string;
};

export const THINKING_LABELS: Record<string, { label: string; description: string }> = {
  off: { label: '关', description: '关闭思考，偏速度和成本' },
  none: { label: '关', description: '关闭思考，偏速度和成本' },
  minimal: { label: '最低', description: '几乎不推理' },
  low: { label: '低', description: '轻度推理' },
  medium: { label: '中', description: '准度和速度折中' },
  high: { label: '高', description: '较深推理' },
  xhigh: { label: '超高', description: '最深，适合复杂分析、长链路 Agent' },
  max: { label: '最大', description: '模型允许的最高思考额度' }
};

export const ARC_THINKING_LEVELS: ThinkingLevel[] = [
  { id: 'off', ...THINKING_LABELS.off },
  { id: 'medium', ...THINKING_LABELS.medium, variant: 'medium', effort: 'medium' },
  { id: 'xhigh', ...THINKING_LABELS.xhigh, variant: 'xhigh', effort: 'xhigh' }
];

export const CLOUD_THINKING_LEVELS: ThinkingLevel[] = [
  { id: 'off', ...THINKING_LABELS.off },
  { id: 'low', ...THINKING_LABELS.low, variant: 'low', effort: 'low' },
  { id: 'medium', ...THINKING_LABELS.medium, variant: 'medium', effort: 'medium' },
  { id: 'high', ...THINKING_LABELS.high, variant: 'high', effort: 'high' },
  { id: 'xhigh', ...THINKING_LABELS.xhigh, variant: 'xhigh', effort: 'xhigh' }
];

const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function fallbackThinkingLevels(model: ChatModelId | string): ThinkingLevel[] {
  return model === 'arc'
    ? ARC_THINKING_LEVELS.map((item) => ({ ...item }))
    : CLOUD_THINKING_LEVELS.map((item) => ({ ...item }));
}

/** 每个档位在滑块 0–1 上的位置，均匀分布 */
export function thinkingStops(levels: ThinkingLevel[]): Record<string, number> {
  const n = Math.max(1, levels.length);
  const stops: Record<string, number> = {};
  levels.forEach((level, index) => {
    stops[level.id] = n === 1 ? 0 : index / (n - 1);
  });
  return stops;
}

export function snapThinkingRatio(ratio: number, levels: ThinkingLevel[]): number {
  const stops = thinkingStops(levels);
  return stops[resolveThinkingLevel(ratio, levels).id] ?? 0;
}

export function resolveThinkingLevel(ratio: number, levels: ThinkingLevel[]): ThinkingLevel {
  const list = levels.length ? levels : ARC_THINKING_LEVELS;
  if (list.length === 1) return list[0];
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : defaultThinkingRatio(list)));
  const index = Math.min(list.length - 1, Math.round(clamped * (list.length - 1)));
  return list[index];
}

export function defaultThinkingRatio(levels: ThinkingLevel[]): number {
  const list = levels.length ? levels : ARC_THINKING_LEVELS;
  const medium = list.findIndex((item) => item.id === 'medium');
  if (medium >= 0) return thinkingStops(list)[list[medium].id] ?? 0;
  const firstOn = list.findIndex((item) => item.id !== 'off' && item.id !== 'none');
  if (firstOn >= 0) return thinkingStops(list)[list[firstOn].id] ?? 0;
  return 0;
}

/** 【重建】滑块左右移一档，返回新档位的位置 */
export function stepThinkingRatio(ratio: number, levels: ThinkingLevel[], direction: -1 | 1): number {
  const list = levels.length ? levels : ARC_THINKING_LEVELS;
  const current = list.indexOf(resolveThinkingLevel(ratio, list));
  const index = Math.min(list.length - 1, Math.max(0, current + direction));
  return thinkingStops(list)[list[index].id] ?? 0;
}

/** 【重建】把任意思考档 id 落到 levels 里真实存在的档位（取强度最接近的） */
export function snapThinkingIdToLevels(thinking: string, levels: ThinkingLevel[]): string {
  const list = levels.length ? levels : ARC_THINKING_LEVELS;
  let id = String(thinking || '').trim().toLowerCase();
  if (id === 'none' || id === 'disabled') id = 'off';
  if (list.some((item) => item.id === id)) return id;
  const want = EFFORT_ORDER.indexOf(id);
  if (want < 0) return list[list.findIndex((item) => item.id === 'medium')]?.id ?? list[0].id;
  let best = list[0];
  let bestGap = Infinity;
  for (const item of list) {
    const gap = Math.abs(EFFORT_ORDER.indexOf(item.id) - want);
    if (gap < bestGap) {
      best = item;
      bestGap = gap;
    }
  }
  return best.id;
}
