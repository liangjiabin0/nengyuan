/**
 * AI4ES API process (Hono) — mounts existing Next route handlers.
 * Env defaults applied before any app imports (ESM-safe via dynamic import).
 *
 * 【重建】按 dist/runtime/api-app.mjs 中的线上版本还原（PostgreSQL + 会话工作区定期清理）。
 */
export {};

async function main() {
  const { loadProjectEnv } = await import('../../src/lib/load-env');
  loadProjectEnv();

  if (!process.env.AI4ES_ROLE) process.env.AI4ES_ROLE = 'api';
  if (process.env.AI4ES_USE_JOB_QUEUE === undefined) process.env.AI4ES_USE_JOB_QUEUE = '1';
  // Prefer loopback bind so LAN clients must go through Next (:3000), keeping local-admin checks safe.
  if (!process.env.API_HOST) process.env.API_HOST = '127.0.0.1';

  const { Hono } = await import('hono');
  const { serve } = await import('@hono/node-server');
  const { ensureDb } = await import('../../src/lib/db');
  const { disableHttpServerTimeouts } = await import('../../src/lib/http-server-timeouts');
  const { registerApiRoutes } = await import('./routes');

  await ensureDb();
  const { startChatWorkspaceRetentionScheduler } = await import('../../src/lib/chat-workspace-retention');
  startChatWorkspaceRetentionScheduler();

  const app = new Hono();
  await registerApiRoutes(app);
  app.notFound((c) => c.json({ error: `API 未注册：${c.req.method} ${c.req.path}` }, 404));
  app.onError((err, c) =>
    c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  );

  const port = Number(process.env.API_PORT || 4000);
  const hostname = process.env.API_HOST || '127.0.0.1';

  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(
      `[ai4es-api] role=${process.env.AI4ES_ROLE} queue=${process.env.AI4ES_USE_JOB_QUEUE} listening http://${info.address}:${info.port}`
    );
  });
  // 智能对话的流式响应可能持续数小时，不能被 Node 默认超时掐断
  disableHttpServerTimeouts(server);
}

main().catch((error) => {
  console.error('[ai4es-api] fatal:', error);
  process.exit(1);
});
