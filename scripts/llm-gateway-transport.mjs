/**
 * 网关到上游的连接层。
 *
 * - 内网 / 本机地址永远直连，不经过进程级 HTTP(S)_PROXY。Node 不认 NO_PROXY 里的
 *   CIDR（10.0.0.0/8 这类写法），交给全局 fetch 会把本机 vLLM 流量也送进代理。
 * - 公网地址在「直连」和「代理」两条线路之间自动切换：哪条最近成功就先走哪条；
 *   连接失败或等不到响应头时，下一次重试换另一条。
 * - LLM_GATEWAY_PROXY 指定代理（http://host:port）；未设置时读 HTTPS_PROXY / HTTP_PROXY。
 *   设为 off 则只直连。LLM_GATEWAY_ROUTE=direct|proxy 固定首选线路。
 */
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';

const CONNECT_TIMEOUT_MS = 10_000;
// 思考模型隐藏推理时可能几分钟不吐字；超过这个时长一个字节都没有才判定流断了。
const BODY_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const ROUTE_MEMORY_MS = 10 * 60 * 1000;

const connectOptions = {
  timeout: CONNECT_TIMEOUT_MS,
  // 服务器 IPv6 不通而 DNS 先给 AAAA 时，尽快落到 IPv4。
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 300
};

const dispatcherOptions = {
  connect: connectOptions,
  // 响应头超时由 fetchUpstreamWithRetry 按角色控制。
  headersTimeout: 0,
  bodyTimeout: BODY_IDLE_TIMEOUT_MS,
  keepAliveTimeout: 30_000
};

export function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (!host.includes('.') && !host.includes(':')) return true;
  if (host === '::1' || host.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(host)) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host.replace(/^::ffff:/, ''));
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127);
}

export function proxyFromEnv(env = process.env) {
  const explicit = String(env.LLM_GATEWAY_PROXY ?? '').trim();
  if (/^(off|none|0|false|direct)$/i.test(explicit)) return '';
  const raw = explicit || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '';
  const value = String(raw).trim();
  return /^https?:\/\//i.test(value) ? value : '';
}

function otherRoute(route) {
  return route === 'direct' ? 'proxy' : 'direct';
}

export function createUpstreamTransport(options = {}) {
  const env = options.env || process.env;
  const proxyUrl = options.proxyUrl ?? proxyFromEnv(env);
  const preferred = String(env.LLM_GATEWAY_ROUTE || '').toLowerCase() === 'proxy' && proxyUrl ? 'proxy' : 'direct';
  const fetchImpl = options.fetch || undiciFetch;
  const now = options.now || Date.now;
  const direct = options.directDispatcher || new Agent(dispatcherOptions);
  let proxy = options.proxyDispatcher || null;
  const hostRoutes = new Map();

  function proxyDispatcher() {
    if (!proxy) proxy = new ProxyAgent({ uri: proxyUrl, ...dispatcherOptions, proxyTls: connectOptions, requestTls: connectOptions });
    return proxy;
  }

  // 记住每个主机最近一次的结果：成功的线路继续用，失败的线路下次换掉。
  // 连续重试因此会在两条线路之间交替。
  function routeFor(host) {
    if (!proxyUrl || isPrivateHost(host)) return 'direct';
    const state = hostRoutes.get(host);
    if (!state || now() - state.at >= ROUTE_MEMORY_MS) return preferred;
    return state.good || otherRoute(state.bad);
  }

  function remember(host, route, ok) {
    if (!proxyUrl || isPrivateHost(host)) return;
    hostRoutes.set(host, ok ? { good: route, at: now() } : { bad: route, at: now() });
  }

  async function transportFetch(url, init = {}, context = {}) {
    const host = new URL(url).hostname;
    const route = routeFor(host);
    const dispatcher = route === 'proxy' ? proxyDispatcher() : direct;
    try {
      const response = await fetchImpl(url, { ...init, dispatcher });
      remember(host, route, true);
      return response;
    } catch (error) {
      if (!context.clientSignal?.aborted) {
        remember(host, route, false);
        if (error && typeof error === 'object') error.gatewayRoute = route;
      }
      throw error;
    }
  }

  transportFetch.describe = () => ({
    proxy: proxyUrl ? proxyUrl.replace(/\/\/[^@/]*@/, '//***@') : null,
    preferred,
    hosts: Object.fromEntries([...hostRoutes].map(([host, state]) => [host, state]))
  });

  return transportFetch;
}
