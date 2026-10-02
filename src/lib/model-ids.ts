/** 智能对话可选模型。Arc < Thunder < Storm。 */
export type ChatModelId = 'arc' | 'thunder' | 'storm';

/** 模型配置页 / 网关端点角色。small=Arc，large=Thunder，另加 storm 与 image。 */
export type EndpointRole = 'small' | 'large' | 'storm' | 'image';

/** @deprecated 使用 ChatModelId；small=arc，large=thunder */
export type ChatModelRole = 'small' | 'large' | 'storm';

/** @deprecated 使用 ChatModelRole；保留兼容旧 import */
export type ModelRole = ChatModelRole;

export const CHAT_MODEL_IDS: ChatModelId[] = ['arc', 'thunder', 'storm'];

/** 父代理默认档；子代理另由路由器决定。 */
export const DEFAULT_CHAT_MODEL: ChatModelId = 'thunder';

export const CHAT_MODEL_META: Record<ChatModelId, { label: string; description: string }> = {
  arc: { label: 'Arc', description: '本地快速档，适合取数和核对' },
  thunder: { label: 'Thunder', description: '云端加强档，日常主力' },
  storm: { label: 'Storm', description: '云端最强档，长链路攻坚' }
};

/** OpenCode provider ID（中性名；真实上游由本地 Gateway 转发） */
export const OPENCODE_PROVIDER_ID = 'gateway';

/** 网关对内 Arc。无论上游配置成 Arc 或其他，对内都是 arc。 */
export const OPENCODE_SMALL_MODEL_ALIAS = 'arc';
export const OPENCODE_ARC_MODEL_ALIAS = OPENCODE_SMALL_MODEL_ALIAS;

/** 旧 OpenCode 会话目录名；发给 Gateway 的 id 仍指向 arc。 */
export const OPENCODE_SMALL_LEGACY_ALIAS = 'ai4es-small';
export const OPENCODE_SMALL_LOW_MODEL_ALIAS = 'ai4es-small-low';
export const OPENCODE_SMALL_MEDIUM_MODEL_ALIAS = 'ai4es-small-medium';
export const OPENCODE_SMALL_XHIGH_MODEL_ALIAS = 'ai4es-small-xhigh';

/** 网关对内 Thunder。 */
export const OPENCODE_LARGE_MODEL_ALIAS = 'thunder';
export const OPENCODE_THUNDER_MODEL_ALIAS = OPENCODE_LARGE_MODEL_ALIAS;

/** 旧 OpenCode 会话目录名；发给 Gateway 的 id 仍指向 thunder。 */
export const OPENCODE_LARGE_LEGACY_ALIAS = 'ai4es-large';

/** 网关对内 Storm。 */
export const OPENCODE_STORM_MODEL_ALIAS = 'storm';

/** 图像生成别名：不暴露真实模型名 */
export const OPENCODE_IMAGE_MODEL_ALIAS = 'ai4es-image';

export function isChatModelId(value: unknown): value is ChatModelId {
  return value === 'arc' || value === 'thunder' || value === 'storm';
}

export function parseChatModelId(value: unknown): ChatModelId | null {
  if (isChatModelId(value)) return value;
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'small' || raw === 'gateway/arc' || raw === 'ai4es-small') return 'arc';
  if (raw === 'large' || raw === 'gateway/thunder' || raw === 'ai4es-large') return 'thunder';
  if (raw === 'gateway/storm') return 'storm';
  const slash = raw.split('/').pop() || raw;
  if (isChatModelId(slash)) return slash;
  return null;
}

export function normalizeChatModelId(value: unknown, fallback: ChatModelId = 'arc'): ChatModelId {
  return parseChatModelId(value) || fallback;
}

/** 对话气泡与子代理节点上标注的「模型 (档位)」，例如 Thunder (medium)。 */
export function formatModelTierLabel(model: unknown, thinking?: unknown): string {
  const id = parseChatModelId(model);
  if (!id) return '';
  const raw = String(thinking ?? '').trim().toLowerCase();
  const tier = raw === 'none' || raw === 'disabled' ? 'off' : raw;
  return tier ? `${CHAT_MODEL_META[id].label} (${tier})` : CHAT_MODEL_META[id].label;
}

export function endpointRoleForChatModel(id: ChatModelId): Exclude<EndpointRole, 'image'> {
  if (id === 'storm') return 'storm';
  if (id === 'thunder') return 'large';
  return 'small';
}

export function chatModelFromEndpointRole(role: EndpointRole | ChatModelRole | ChatModelId): ChatModelId {
  if (role === 'storm') return 'storm';
  if (role === 'large' || role === 'thunder') return 'thunder';
  if (role === 'image') return 'arc';
  return 'arc';
}

/** 用量等对用户可见的模型名 = 网关对内名。 */
export function publicModelDisplayName(
  role: ChatModelRole | ChatModelId,
  _detectedModel?: string | null
) {
  return resolveOpenCodeModelId(role);
}

/** 当前上游 Arc 仅三档：关 / 中 / 超高 */
export type OpenCodeSmallThinkingMode = 'off' | 'medium' | 'xhigh';

export function resolveOpenCodeModelId(
  role: ChatModelRole | ChatModelId | EndpointRole = 'small'
) {
  const chat = isChatModelId(role) ? role : chatModelFromEndpointRole(role);
  if (chat === 'storm') return OPENCODE_STORM_MODEL_ALIAS;
  if (chat === 'thunder') return OPENCODE_LARGE_MODEL_ALIAS;
  return OPENCODE_SMALL_MODEL_ALIAS;
}

export function resolveOpenCodeModelRef(role: ChatModelRole | ChatModelId | EndpointRole = 'small') {
  return `${OPENCODE_PROVIDER_ID}/${resolveOpenCodeModelId(role)}`;
}

/** OpenCode prompt 的 variant；关思考不传，避免另建模型别名 */
export function resolveOpenCodeSmallVariant(
  mode?: OpenCodeSmallThinkingMode | 'low' | string | null
): string | undefined {
  const id = String(mode || '').trim().toLowerCase();
  if (!id || id === 'off' || id === 'none' || id === 'default') return undefined;
  return id;
}

export function resolveEndpointAlias(role: EndpointRole) {
  if (role === 'large') return OPENCODE_LARGE_MODEL_ALIAS;
  if (role === 'storm') return OPENCODE_STORM_MODEL_ALIAS;
  if (role === 'image') return OPENCODE_IMAGE_MODEL_ALIAS;
  return OPENCODE_SMALL_MODEL_ALIAS;
}
