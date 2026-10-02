/** 本地 Arc（vLLM）思考档。不要传 reasoning_effort=none。仅 关 / 中 / 超高。 */
export type LocalSmallThinkingMode = 'off' | 'medium' | 'xhigh';
export type LocalSmallReasoningEffort = Exclude<LocalSmallThinkingMode, 'off'>;

export const LOCAL_SMALL_DEFAULT_BASE_URL = 'http://10.1.4.166:8000/v1';
export const LOCAL_SMALL_DEFAULT_MODEL = 'Arc';
/** 端点不可达时的保守回退。在线窗口以 vLLM `max_model_len` 为准。 */
export const LOCAL_SMALL_CONTEXT_TOKENS = 131072;
export const LOCAL_SMALL_THINKING_MAX_TOKENS = 4096;
/** 单次回复的输出上限（按线上版本补回）。 */
export const LOCAL_SMALL_OUTPUT_TOKENS = 32768;

const SAMPLING_OFF = {
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  min_p: 0,
  presence_penalty: 1.5,
  repetition_penalty: 1
} as const;

const SAMPLING_XHIGH = {
  temperature: 0.8,
  top_p: 0.95,
  top_k: 20,
  min_p: 0,
  presence_penalty: 0.3,
  repetition_penalty: 1.1
} as const;

export type LocalSmallChatExtras = {
  temperature: number;
  top_p: number;
  top_k: number;
  min_p: number;
  presence_penalty: number;
  repetition_penalty: number;
  include_reasoning?: boolean;
  reasoning_effort?: LocalSmallReasoningEffort;
  chat_template_kwargs: {
    enable_thinking: boolean;
    preserve_thinking?: boolean;
  };
};

export function getLocalSmallChatExtras(mode: LocalSmallThinkingMode): LocalSmallChatExtras {
  if (mode === 'off') {
    return {
      ...SAMPLING_OFF,
      chat_template_kwargs: { enable_thinking: false }
    };
  }
  return {
    ...SAMPLING_XHIGH,
    reasoning_effort: mode,
    include_reasoning: true,
    chat_template_kwargs: {
      enable_thinking: true,
      preserve_thinking: true
    }
  };
}

export function isLocalSmallThinkingOn(extras: unknown) {
  if (!extras || typeof extras !== 'object') return false;
  const template = (extras as { chat_template_kwargs?: unknown }).chat_template_kwargs;
  return Boolean(
    template
    && typeof template === 'object'
    && (template as { enable_thinking?: unknown }).enable_thinking === true
  );
}
