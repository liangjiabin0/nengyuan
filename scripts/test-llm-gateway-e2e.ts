import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  let upstreamClosedEarly = 0;
  const upstream = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-small', max_model_len: 4096 }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const mode = String(body.messages?.[0]?.content || '');
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: `t${sent}` } }] })}\n\n`);
        if (mode === 'reset' && sent === 2) {
          clearInterval(timer);
          res.socket?.destroy();
        }
        if (sent >= 200) {
          clearInterval(timer);
          res.end('data: [DONE]\n\n');
        }
      }, 50);
      res.on('close', () => {
        clearInterval(timer);
        if (sent < 200 && mode === 'slow') upstreamClosedEarly += 1;
      });
    });
  });
  const upstreamPort = await freePort();
  await new Promise<void>((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai4es-gw-'));
  const settingsPath = path.join(tmp, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    small: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, model: 'fake-small', apiKey: '' }
  }));

  const gatewayPort = await freePort();
  const deadProxy = 'http://127.0.0.1:9';
  const gateway = spawn(process.execPath, [path.join(ROOT, 'scripts', 'llm-gateway.mjs')], {
    env: {
      ...process.env,
      LLM_GATEWAY_PORT: String(gatewayPort),
      LLM_GATEWAY_HOST: '127.0.0.1',
      LLM_GATEWAY_SETTINGS_PATH: settingsPath,
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: deadProxy,
      HTTPS_PROXY: deadProxy,
      http_proxy: deadProxy,
      https_proxy: deadProxy,
      NO_PROXY: '10.0.0.0/8',
      no_proxy: '10.0.0.0/8'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let gatewayLog = '';
  gateway.stdout.on('data', (chunk) => { gatewayLog += chunk; });
  gateway.stderr.on('data', (chunk) => { gatewayLog += chunk; });
  let exited = false;
  gateway.on('exit', () => { exited = true; });

  const base = `http://127.0.0.1:${gatewayPort}`;
  const health = async () => {
    try {
      const response = await fetch(`${base}/health`);
      return response.ok;
    } catch {
      return false;
    }
  };

  try {
    await waitFor(health, 10_000, 'gateway health');

    const chat = (content: string, stream: boolean, signal?: AbortSignal) => fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'arc', stream, messages: [{ role: 'user', content }] }),
      signal
    });

    // 本机上游不走进程代理：代理是死端口，请求仍然成功。
    const plain = await chat('json', false);
    assert.equal(plain.status, 200, gatewayLog);
    const plainBody = await plain.json();
    assert.equal(plainBody.model, 'arc');

    // 客户端中途断开 → 网关中止上游。
    const controller = new AbortController();
    const slow = await chat('slow', true, controller.signal);
    assert.equal(slow.status, 200);
    const reader = slow.body!.getReader();
    await reader.read();
    await reader.read();
    controller.abort();
    await waitFor(() => upstreamClosedEarly === 1, 3_000, 'upstream abort after client disconnect');

    // 上游流中途断开：网关不能退出。
    const reset = await chat('reset', true);
    await reset.text().catch(() => '');
    await sleep(300);
    assert.equal(exited, false, gatewayLog);
    assert.equal(await health(), true, gatewayLog);

    // 断开之后正常请求照常。
    const after = await chat('json', false);
    assert.equal(after.status, 200);

    console.log('llm gateway e2e tests passed');
  } finally {
    gateway.kill('SIGTERM');
    upstream.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
