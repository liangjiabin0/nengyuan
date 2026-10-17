import assert from 'node:assert/strict';
import { createUpstreamTransport, isPrivateHost, proxyFromEnv } from './llm-gateway-transport.mjs';
import { fetchUpstreamWithRetry, headerTimeoutFor } from './llm-gateway-retry.mjs';

const DIRECT = { name: 'direct' };
const PROXY = { name: 'proxy' };

function fakeTransport(env: Record<string, string>, outcomes: Array<'ok' | 'fail'>) {
  const used: string[] = [];
  const transport = createUpstreamTransport({
    env,
    directDispatcher: DIRECT,
    proxyDispatcher: PROXY,
    fetch: async (_url: string, init: { dispatcher: { name: string } }) => {
      used.push(init.dispatcher.name);
      if (outcomes.shift() === 'fail') throw new Error('fetch failed');
      return new Response('{}', { status: 200 });
    }
  });
  return { transport, used };
}

async function main() {
  for (const host of ['127.0.0.1', 'localhost', '10.1.4.166', '192.168.1.2', '172.20.0.1', '100.70.77.61', '::1', '[::1]', 'gpu-box']) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ['ai-api.ai-member.icu', '8.8.8.8', '172.32.0.1', '2606:4700::1']) {
    assert.equal(isPrivateHost(host), false, host);
  }

  assert.equal(proxyFromEnv({ HTTPS_PROXY: 'http://127.0.0.1:10808' }), 'http://127.0.0.1:10808');
  assert.equal(proxyFromEnv({ ALL_PROXY: 'socks5h://127.0.0.1:10808' }), '');
  assert.equal(proxyFromEnv({ LLM_GATEWAY_PROXY: 'off', HTTPS_PROXY: 'http://127.0.0.1:10808' }), '');
  assert.equal(proxyFromEnv({ LLM_GATEWAY_PROXY: 'http://10.0.0.9:3128', HTTPS_PROXY: 'http://127.0.0.1:10808' }), 'http://10.0.0.9:3128');

  const env = { HTTPS_PROXY: 'http://127.0.0.1:10808' };

  // 内网上游即使配置了代理也直连。
  {
    const { transport, used } = fakeTransport(env, ['ok']);
    await transport('http://10.1.4.166:8000/v1/models', {});
    assert.deepEqual(used, ['direct']);
  }

  // 直连失败 → 重试走代理 → 之后的新请求首选代理。
  {
    const { transport, used } = fakeTransport(env, ['fail', 'ok', 'ok']);
    const url = 'https://ai-api.ai-member.icu/v1/chat/completions';
    const response = await fetchUpstreamWithRetry(url, { method: 'POST', body: '{}' }, {
      fetch: transport,
      backoffMs: () => 0,
      headerTimeoutMs: 1_000
    });
    assert.equal(response.status, 200);
    await transport(url, {});
    assert.deepEqual(used, ['direct', 'proxy', 'proxy']);
  }

  // 没有代理时只能直连。
  {
    const { transport, used } = fakeTransport({}, ['fail', 'ok']);
    await fetchUpstreamWithRetry('https://ai-api.ai-member.icu/v1/models', {}, {
      fetch: transport,
      backoffMs: () => 0,
      headerTimeoutMs: 1_000
    });
    assert.deepEqual(used, ['direct', 'direct']);
  }

  // 客户端自己取消时不把线路记成坏的。
  {
    const { transport, used } = fakeTransport(env, ['fail', 'ok']);
    const controller = new AbortController();
    controller.abort();
    await transport('https://ai-api.ai-member.icu/v1/models', {}, { clientSignal: controller.signal }).catch(() => undefined);
    await transport('https://ai-api.ai-member.icu/v1/models', {});
    assert.deepEqual(used, ['direct', 'direct']);
  }

  // LLM_GATEWAY_ROUTE=proxy 时首选代理。
  {
    const { transport, used } = fakeTransport({ ...env, LLM_GATEWAY_ROUTE: 'proxy' }, ['ok']);
    await transport('https://ai-api.ai-member.icu/v1/models', {});
    assert.deepEqual(used, ['proxy']);
  }

  assert.equal(headerTimeoutFor({ role: 'small', stream: true }, {}), 60_000);
  assert.equal(headerTimeoutFor({ role: 'large', stream: true }, {}), 120_000);
  assert.equal(headerTimeoutFor({ role: 'large', stream: false }, {}), 600_000);
  assert.equal(headerTimeoutFor({ role: 'storm', stream: true }, { LLM_GATEWAY_HEADER_TIMEOUT_MS: '90000' }), 90_000);

  console.log('llm gateway transport tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
