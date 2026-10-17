/**
 * 验证结构校验失败时的带错重试：最多 3 次修复调用。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  loadWorkspaceArtifactWithRetry,
  PATENT_SCHEMA_RETRY_MAX,
  tryParseLooseJson
} from '../src/lib/patent-generation/schema-retry';
import { writePatentWorkspaceJson } from '../src/lib/opencode/patent';

const projectId = `schema-retry-${Date.now()}`;
const workspace = path.join(process.cwd(), 'storage', 'patents', projectId, 'opencode');

const schema = z.object({
  independentClaims: z.array(z.object({
    type: z.enum(['method', 'system', 'device', 'storage_medium']),
    scope: z.string().default('')
  })).default([])
});

async function main() {
  assert.equal(PATENT_SCHEMA_RETRY_MAX, 3);
  fs.mkdirSync(workspace, { recursive: true });

  writePatentWorkspaceJson(projectId, 'strategy.json', {
    independentClaims: [{ type: 'computer_storage_medium', scope: 'bad' }]
  });
  assert.equal(
    tryParseLooseJson(
      JSON.parse(fs.readFileSync(path.join(workspace, 'strategy.json'), 'utf8')),
      schema
    ).ok,
    false
  );

  let repairCalls = 0;
  const statuses: string[] = [];

  const value = await loadWorkspaceArtifactWithRetry({
    projectId,
    relativeDir: 'opencode',
    fileName: 'strategy.json',
    schema,
    stage: 'strategy',
    emit: async (event) => {
      if (event.type === 'status') statuses.push(String(event.detail || ''));
    },
    repairFn: async () => {
      repairCalls += 1;
      if (repairCalls < 3) {
        writePatentWorkspaceJson(projectId, 'strategy.json', {
          independentClaims: [{ type: 'computer_storage_medium', scope: `retry-${repairCalls}` }]
        });
      } else {
        writePatentWorkspaceJson(projectId, 'strategy.json', {
          independentClaims: [{ type: 'storage_medium', scope: 'fixed' }]
        });
      }
      return { answer: 'ok', sessionId: 'test' } as never;
    }
  });

  assert.equal(repairCalls, 3);
  assert.equal(value?.independentClaims[0]?.type, 'storage_medium');
  assert.ok(statuses.some((item) => /第 1\/3 次带错修复/.test(item)));
  assert.ok(fs.existsSync(path.join(workspace, 'SCHEMA_VALIDATION.json')));

  // 永远修不好：必须恰好调用 3 次后抛错
  writePatentWorkspaceJson(projectId, 'strategy.json', {
    independentClaims: [{ type: 'computer_storage_medium', scope: 'bad' }]
  });
  repairCalls = 0;
  await assert.rejects(
    () => loadWorkspaceArtifactWithRetry({
      projectId,
      relativeDir: 'opencode',
      fileName: 'strategy.json',
      schema,
      stage: 'strategy',
      repairFn: async () => {
        repairCalls += 1;
        writePatentWorkspaceJson(projectId, 'strategy.json', {
          independentClaims: [{ type: 'computer_storage_medium', scope: 'still-bad' }]
        });
        return { answer: 'ok', sessionId: 'test' } as never;
      }
    }),
    /经 3 次带错重试仍无法通过结构校验/
  );
  assert.equal(repairCalls, 3);

  fs.rmSync(path.join(process.cwd(), 'storage', 'patents', projectId), {
    recursive: true,
    force: true
  });
  console.log('test-patent-schema-retry: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
