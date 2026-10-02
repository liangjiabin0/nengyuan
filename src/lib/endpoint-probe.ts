import { getModelEndpoint, type ModelEndpointSettings, type ModelRole } from './config';
import { getLocalSmallChatExtras } from './local-llm-extras';
import { fetchChatCompletions, fetchModelsList, parseApiFormat, describeLlmHttpError } from './openai-anthropic-compat';

export type ProbeStatus = 'green' | 'yellow' | 'red';

export type ProbeResult = {
  role: ModelRole;
  status: ProbeStatus;
  message: string;
  model: string;
  baseUrl: string;
  latencyMs?: number;
};

function catalogModelIds(text: string): string[] {
  try {
    const json = JSON.parse(text) as { data?: Array<{ id?: string; model?: string }> };
    const rows = Array.isArray(json?.data) ? json.data : [];
    return rows
      .map((row) => String(row?.id || row?.model || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 轻量健康探测：优先 GET /models；不可用时对 chat 做极短补全探测。
 * 图像端点若 /models 不可用，则仅校验 Base URL 可达性（避免误触发计费出图）。
 */
export async function probeEndpoint(
  role: ModelRole,
  settings?: ModelEndpointSettings
): Promise<ProbeResult> {
  const endpoint = settings || getModelEndpoint(role);
  const baseUrl = endpoint.baseUrl.replace(/\/$/, '');
  const started = Date.now();

  if (!baseUrl) {
    return {
      role,
      status: 'yellow',
      message: '未配置 Base URL',
      model: endpoint.model,
      baseUrl
    };
  }

  const headers: Record<string, string> = {};
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
  const apiFormat = parseApiFormat(endpoint.apiFormat);

  // Anthropic 兼容端点（如阿里云 /apps/anthropic）通常没有 /models
  if (apiFormat !== 'anthropic') {
  try {
    const modelsRes = await fetchModelsList(endpoint, { signal: AbortSignal.timeout(8_000) });
    if (modelsRes.ok) {
      if (role === 'image') {
        const text = await modelsRes.text().catch(() => '');
        const ids = catalogModelIds(text);
        const want = endpoint.model.trim();
        if (ids.length > 0 && want && !ids.some((id) => id.toLowerCase() === want.toLowerCase())) {
          return {
            role,
            status: 'red',
            message: `当前 Key 未开通图像模型 ${want}（/models 目录中没有该模型，请更换具备 Images 权限的 Key）`,
            model: endpoint.model,
            baseUrl,
            latencyMs: Date.now() - started
          };
        }
        return {
          role,
          status: 'green',
          message: '模型服务可达',
          model: endpoint.model,
          baseUrl,
          latencyMs: Date.now() - started
        };
      }
      await modelsRes.body?.cancel().catch(() => undefined);
      return {
        role,
        status: 'green',
        message: '模型服务可达',
        model: endpoint.model,
        baseUrl,
        latencyMs: Date.now() - started
      };
    }
    // 401/403：服务可达但鉴权失败 → 红
    if (modelsRes.status === 401 || modelsRes.status === 403) {
      const text = await modelsRes.text().catch(() => '');
      return {
        role,
        status: 'red',
        message: `鉴权失败 HTTP ${modelsRes.status}${text ? `: ${text.slice(0, 120)}` : ''}`,
        model: endpoint.model,
        baseUrl,
        latencyMs: Date.now() - started
      };
    }
    await modelsRes.body?.cancel().catch(() => undefined);
  } catch {
    // /models 不可用，继续按角色降级探测
  }
  }

  if (role === 'image') {
    try {
      const ping = await fetch(baseUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(8_000)
      });
      await ping.body?.cancel().catch(() => undefined);
      // 任意 HTTP 响应都视为网络通；黄=不确定业务可用性
      return {
        role,
        status: ping.status < 500 ? 'yellow' : 'red',
        message: ping.status < 500
          ? '主机可达，尚未验证 Images 接口（请手动测试连接）'
          : `上游异常 HTTP ${ping.status}`,
        model: endpoint.model,
        baseUrl,
        latencyMs: Date.now() - started
      };
    } catch (error) {
      return {
        role,
        status: 'red',
        message: error instanceof Error ? error.message : '无法连接图像上游',
        model: endpoint.model,
        baseUrl,
        latencyMs: Date.now() - started
      };
    }
  }

  // chat：尝试极短补全
  try {
    const response = await fetchChatCompletions(endpoint, {
      model: endpoint.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
      stream: false,
      ...(apiFormat === 'anthropic' || endpoint.reasoningEffortNone === false
        ? {}
        : getLocalSmallChatExtras('off'))
    }, { signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    if (!response.ok) {
      return {
        role,
        status: 'red',
        message: describeLlmHttpError(response.status, text),
        model: endpoint.model,
        baseUrl,
        latencyMs: Date.now() - started
      };
    }
    return {
      role,
      status: 'green',
      message: '对话接口可达',
      model: endpoint.model,
      baseUrl,
      latencyMs: Date.now() - started
    };
  } catch (error) {
    return {
      role,
      status: 'red',
      message: error instanceof Error ? error.message : '探测失败',
      model: endpoint.model,
      baseUrl,
      latencyMs: Date.now() - started
    };
  }
}

export async function probeAllEndpoints() {
  const roles: ModelRole[] = ['small', 'large', 'storm', 'image'];
  const results = await Promise.all(roles.map((role) => probeEndpoint(role)));
  return Object.fromEntries(results.map((item) => [item.role, item])) as Record<ModelRole, ProbeResult>;
}
