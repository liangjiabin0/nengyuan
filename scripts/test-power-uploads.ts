import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadProjectEnv } from "../src/lib/load-env";
import { defaultTaskParameters } from "../src/lib/power-compute/catalog";
loadProjectEnv();
assert.ok(process.env.DATABASE_URL?.includes("ai4es_temp"), "Sandbox only");
const checks: Array<{ name: string; passed: boolean; error?: string }> = [];
async function main() {
  const { ensureDb, getDb } = await import("../src/lib/db");
  await ensureDb();
  const { getUserByUsername } = await import("../src/lib/auth/users");
  const { createSession, deleteSession } = await import(
    "../src/lib/auth/session"
  );
  const { POST: importModel } = await import(
    "../src/app/api/power-models/route"
  );
  const { POST: submit } = await import("../src/app/api/power-runs/route");
  const { requestCancel } = await import("../src/lib/power-compute/store");
  const user = await getUserByUsername("power_http_owner");
  assert.ok(user);
  const token = await createSession(user.id);
  const headers = { authorization: "Bearer " + token, host: "82.156.77.81" };
  const created: string[] = [];
  const count = async (table: string) =>
    (await getDb()
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`)
      .get<{ n: string }>(user.id))!.n;
  const check = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
      checks.push({ name, passed: true });
    } catch (error) {
      checks.push({ name, passed: false, error: String(error) });
    }
    console.log(checks.at(-1));
  };
  const spec = () => ({
    engine: "pandapower",
    modelId: "ieee9",
    parameters: defaultTaskParameters("ac_flow"),
    requestKey: randomUUID(),
  });
  const batch = (inputs: unknown[]) =>
    submit(
      new Request("http://82.156.77.81:8000/api/power-runs?batch=1", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(inputs),
      }),
    );
  try {
    await check("batch rejects six cases without creating tasks", async () => {
      const before = await count("power_runs");
      assert.equal((await batch(Array.from({ length: 6 }, spec))).status, 422);
      assert.equal(await count("power_runs"), before);
    });
    await check(
      "batch ownership failure rolls back all preceding tasks",
      async () => {
        const before = await count("power_runs");
        const r = await batch([spec(), { ...spec(), sessionId: randomUUID() }]);
        assert.equal(r.status, 404, await r.text());
        assert.equal(await count("power_runs"), before);
      },
    );
    await check(
      "batch is durable and idempotent for independent cases",
      async () => {
        const inputs = [spec(), spec()];
        const r = await batch(inputs);
        assert.equal(r.status, 202);
        const data = await r.json();
        created.push(...data.runs.map((run: { id: string }) => run.id));
        assert.equal(new Set(created).size, 2);
        const again = await batch(inputs);
        assert.equal(again.status, 200);
        assert.deepEqual(
          (await again.json()).runs.map((run: { id: string }) => run.id),
          created,
        );
        for (const id of created) await requestCancel(user.id, id);
      },
    );
    await check(
      "ambiguous multi-model request is rejected instead of dropping files",
      async () => {
        const form = new FormData();
        form.append("file", new Blob(["one"]), "one.m");
        form.append("file", new Blob(["two"]), "two.m");
        const before = await count("power_models");
        const r = await importModel(
          new Request(
            "http://82.156.77.81:8000/api/power-models?engine=pandapower",
            { method: "POST", headers, body: form },
          ),
        );
        assert.equal(r.status, 422);
        assert.equal(await count("power_models"), before);
      },
    );
    await check("cancelled dynamic import never commits a model", async () => {
      const before = await count("power_models");
      const controller = new AbortController();
      const file = path.resolve(
        "tools/power-mcp-venv/lib/python3.12/site-packages/andes/cases/kundur/kundur_full.xlsx",
      );
      const form = new FormData();
      form.append(
        "file",
        new Blob([fs.readFileSync(file)]),
        "cancel-check.xlsx",
      );
      const timer = setTimeout(() => controller.abort(), 25);
      try {
        const r = await importModel(
          new Request(
            "http://82.156.77.81:8000/api/power-models?engine=andes",
            { method: "POST", headers, body: form, signal: controller.signal },
          ),
        );
        assert.equal(r.status, 422);
        assert.match((await r.json()).error, /取消|abort/i);
        assert.equal(await count("power_models"), before);
      } finally {
        clearTimeout(timer);
      }
    });
  } finally {
    for (const id of created) await requestCancel(user.id, id);
    await deleteSession(token);
  }
  fs.writeFileSync(
    "/data/temp/logs/power-upload-tests.json",
    JSON.stringify(
      {
        passed: checks.filter((x) => x.passed).length,
        failed: checks.filter((x) => !x.passed).length,
        checks,
      },
      null,
      2,
    ),
  );
  process.exitCode = checks.some((x) => !x.passed) ? 1 : 0;
}
void main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
