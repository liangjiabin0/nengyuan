import type { Hono } from "hono";
import { requireAdmin } from "@/lib/auth/request";
import { getJob, listJobs } from "@/lib/jobs/queue";
import type { JobStatus, JobType } from "@/lib/jobs/types";

type RouteModule = Record<string, unknown>;
type NextHandler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Response | Promise<Response>;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function adapt(mod: RouteModule) {
  return async (
    c: {
      req: {
        raw: Request;
        param: () => Record<string, string>;
      };
    },
    method: (typeof METHODS)[number],
  ) => {
    const handler = mod[method] as NextHandler | undefined;
    if (!handler) {
      return new Response(
        JSON.stringify({ error: `Method ${method} not allowed` }),
        {
          status: 405,
          headers: { "content-type": "application/json" },
        },
      );
    }
    const params = c.req.param();
    return handler(c.req.raw, { params: Promise.resolve(params) });
  };
}

function registerModule(app: Hono, path: string, mod: RouteModule) {
  const adapted = adapt(mod);
  for (const method of METHODS) {
    if (typeof mod[method] !== "function") continue;
    const lower = method.toLowerCase() as
      | "get"
      | "post"
      | "put"
      | "patch"
      | "delete";
    app[lower](path, (c) => adapted(c, method));
  }
}

/** Mount all Next App Router API handlers under Hono. */
export async function registerApiRoutes(app: Hono) {
  app.get("/api/health", (c) => c.json({ ok: true, role: "api" }));

  app.get("/api/jobs/:id", async (c) => {
    const auth = await requireAdmin(c.req.raw);
    if (auth.error) return auth.error;
    const job = await getJob(c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    return c.json({ job });
  });

  app.get("/api/jobs", async (c) => {
    const auth = await requireAdmin(c.req.raw);
    if (auth.error) return auth.error;
    const type = c.req.query("type") as JobType | undefined;
    const status = c.req.query("status") as JobStatus | undefined;
    const limit = Number(c.req.query("limit") || 50);
    const jobs = await listJobs({
      type: type || undefined,
      status: status || undefined,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return c.json({ jobs });
  });

  const modules: Array<[string, () => Promise<RouteModule>]> = [
    [
      "/api/system/power-engines",
      () => import("../../src/app/api/system/power-engines/route"),
    ],
    [
      "/api/power-capabilities",
      () => import("../../src/app/api/power-capabilities/route"),
    ],
    ["/api/power-models", () => import("../../src/app/api/power-models/route")],
    ["/api/power-runs", () => import("../../src/app/api/power-runs/route")],
    [
      "/api/power-runs/:runId/cancel",
      () => import("../../src/app/api/power-runs/[runId]/cancel/route"),
    ],
    [
      "/api/power-runs/:runId/artifacts/:artifactId",
      () =>
        import(
          "../../src/app/api/power-runs/[runId]/artifacts/[artifactId]/route"
        ),
    ],
    [
      "/api/power-runs/:runId/tables/:tableId",
      () =>
        import("../../src/app/api/power-runs/[runId]/tables/[tableId]/route"),
    ],
    [
      "/api/power-runs/:runId",
      () => import("../../src/app/api/power-runs/[runId]/route"),
    ],
    ["/api/auth/login", () => import("../../src/app/api/auth/login/route")],
    ["/api/auth/logout", () => import("../../src/app/api/auth/logout/route")],
    ["/api/auth/me", () => import("../../src/app/api/auth/me/route")],
    [
      "/api/auth/password",
      () => import("../../src/app/api/auth/password/route"),
    ],
    ["/api/admin/users", () => import("../../src/app/api/admin/users/route")],
    [
      "/api/admin/users/:id",
      () => import("../../src/app/api/admin/users/[id]/route"),
    ],
    ["/api/bootstrap", () => import("../../src/app/api/bootstrap/route")],
    ["/api/chat", () => import("../../src/app/api/chat/route")],
    ["/api/chat/live", () => import("../../src/app/api/chat/live/route")],
    [
      "/api/chat/queue/next",
      () => import("../../src/app/api/chat/queue/next/route"),
    ],
    [
      "/api/chat/queue/:id",
      () => import("../../src/app/api/chat/queue/[id]/route"),
    ],
    ["/api/chat/queue", () => import("../../src/app/api/chat/queue/route")],
    [
      "/api/chat/conversations",
      () => import("../../src/app/api/chat/conversations/route"),
    ],
    [
      "/api/chat/conversations/:id/title",
      () => import("../../src/app/api/chat/conversations/[id]/title/route"),
    ],
    [
      "/api/chat/conversations/:id/repro-progress",
      () =>
        import(
          "../../src/app/api/chat/conversations/[id]/repro-progress/route"
        ),
    ],
    [
      "/api/chat/conversations/:id/stop",
      () => import("../../src/app/api/chat/conversations/[id]/stop/route"),
    ],
    [
      "/api/chat/conversations/:id/question",
      () => import("../../src/app/api/chat/conversations/[id]/question/route"),
    ],
    [
      "/api/chat/conversations/:id/messages/:messageId/revert",
      () =>
        import(
          "../../src/app/api/chat/conversations/[id]/messages/[messageId]/revert/route"
        ),
    ],
    [
      "/api/chat/conversations/:id/messages/:messageId",
      () =>
        import(
          "../../src/app/api/chat/conversations/[id]/messages/[messageId]/route"
        ),
    ],
    [
      "/api/chat/conversations/:id",
      () => import("../../src/app/api/chat/conversations/[id]/route"),
    ],
    ["/api/skills", () => import("../../src/app/api/skills/route")],
    ["/api/skills/agent", () => import("../../src/app/api/skills/agent/route")],
    [
      "/api/self-learning",
      () => import("../../src/app/api/self-learning/route"),
    ],
    [
      "/api/self-learning/agent",
      () => import("../../src/app/api/self-learning/agent/route"),
    ],
    [
      "/api/journal-watch",
      () => import("../../src/app/api/journal-watch/route"),
    ],
    [
      "/api/paper-review/model",
      () => import("../../src/app/api/paper-review/model/route"),
    ],
    ["/api/paper-review", () => import("../../src/app/api/paper-review/route")],
    [
      "/api/paper-review/:id",
      () => import("../../src/app/api/paper-review/[id]/route"),
    ],
    [
      "/api/paper-review/:id/run",
      () => import("../../src/app/api/paper-review/[id]/run/route"),
    ],
    [
      "/api/paper-review/:id/artifacts/:artifactId",
      () =>
        import(
          "../../src/app/api/paper-review/[id]/artifacts/[artifactId]/route"
        ),
    ],
    [
      "/api/paper-review/:id/proposals",
      () => import("../../src/app/api/paper-review/[id]/proposals/route"),
    ],
    [
      "/api/journal-watch/fulltext",
      () => import("../../src/app/api/journal-watch/fulltext/route"),
    ],
    ["/api/skills/:id", () => import("../../src/app/api/skills/[id]/route")],
    [
      "/api/chat/attachments",
      () => import("../../src/app/api/chat/attachments/route"),
    ],
    [
      "/api/chat/attachments/:id/preview",
      () => import("../../src/app/api/chat/attachments/[id]/preview/route"),
    ],
    [
      "/api/research-review",
      () => import("../../src/app/api/research-review/route"),
    ],
    [
      "/api/research-review/conversations",
      () => import("../../src/app/api/research-review/conversations/route"),
    ],
    [
      "/api/research-review/conversations/:id/title",
      () =>
        import(
          "../../src/app/api/research-review/conversations/[id]/title/route"
        ),
    ],
    [
      "/api/research-review/conversations/:id",
      () =>
        import("../../src/app/api/research-review/conversations/[id]/route"),
    ],
    [
      "/api/research-review/attachments",
      () => import("../../src/app/api/research-review/attachments/route"),
    ],
    [
      "/api/research-review/attachments/:id/preview",
      () =>
        import(
          "../../src/app/api/research-review/attachments/[id]/preview/route"
        ),
    ],
    [
      "/api/research-review/export",
      () => import("../../src/app/api/research-review/export/route"),
    ],
    [
      "/api/research-review/artifacts/:id",
      () => import("../../src/app/api/research-review/artifacts/[id]/route"),
    ],
    ["/api/data-import", () => import("../../src/app/api/data-import/route")],
    [
      "/api/files/preview",
      () => import("../../src/app/api/files/preview/route"),
    ],
    [
      "/api/images/generate",
      () => import("../../src/app/api/images/generate/route"),
    ],
    ["/api/images/edits", () => import("../../src/app/api/images/edits/route")],
    ["/api/graph", () => import("../../src/app/api/graph/route")],
    [
      "/api/graph/analytics",
      () => import("../../src/app/api/graph/analytics/route"),
    ],
    [
      "/api/graph/rebuild",
      () => import("../../src/app/api/graph/rebuild/route"),
    ],
    ["/api/grid-guides", () => import("../../src/app/api/grid-guides/route")],
    [
      "/api/grid-guides/:id",
      () => import("../../src/app/api/grid-guides/[id]/route"),
    ],
    [
      "/api/grid-guides/:id/chat",
      () => import("../../src/app/api/grid-guides/[id]/chat/route"),
    ],
    [
      "/api/grid-guides/:id/files",
      () => import("../../src/app/api/grid-guides/[id]/files/route"),
    ],
    [
      "/api/grid-guides/:id/files/content",
      () => import("../../src/app/api/grid-guides/[id]/files/content/route"),
    ],
    [
      "/api/grid-guides/:id/files/preview",
      () => import("../../src/app/api/grid-guides/[id]/files/preview/route"),
    ],
    [
      "/api/grid-guides/:id/download",
      () => import("../../src/app/api/grid-guides/[id]/download/route"),
    ],
    [
      "/api/grid-guides/attachments/:id/preview",
      () =>
        import("../../src/app/api/grid-guides/attachments/[id]/preview/route"),
    ],
    ["/api/scheme-solve", () => import("../../src/app/api/scheme-solve/route")],
    [
      "/api/scheme-solve/attachments",
      () => import("../../src/app/api/scheme-solve/attachments/route"),
    ],
    [
      "/api/scheme-solve/attachments/:id/preview",
      () =>
        import("../../src/app/api/scheme-solve/attachments/[id]/preview/route"),
    ],
    [
      "/api/scheme-solve/:id",
      () => import("../../src/app/api/scheme-solve/[id]/route"),
    ],
    [
      "/api/scheme-solve/:id/brainstorm",
      () => import("../../src/app/api/scheme-solve/[id]/brainstorm/route"),
    ],
    [
      "/api/scheme-solve/:id/research",
      () => import("../../src/app/api/scheme-solve/[id]/research/route"),
    ],
    [
      "/api/scheme-solve/:id/mgplan",
      () => import("../../src/app/api/scheme-solve/[id]/mgplan/route"),
    ],
    [
      "/api/scheme-solve/:id/mgplan/clone",
      () => import("../../src/app/api/scheme-solve/[id]/mgplan/clone/route"),
    ],
    [
      "/api/scheme-solve/:id/mgplan/file",
      () => import("../../src/app/api/scheme-solve/[id]/mgplan/file/route"),
    ],
    [
      "/api/scheme-solve/:id/mgplan/files",
      () => import("../../src/app/api/scheme-solve/[id]/mgplan/files/route"),
    ],
    [
      "/api/scheme-solve/:id/mgplan/results",
      () => import("../../src/app/api/scheme-solve/[id]/mgplan/results/route"),
    ],
    [
      "/api/scheme-solve/:id/mgplan/solve",
      () => import("../../src/app/api/scheme-solve/[id]/mgplan/solve/route"),
    ],
    [
      "/api/scheme-solve/:id/events",
      () => import("../../src/app/api/scheme-solve/[id]/events/route"),
    ],
    [
      "/api/scheme-solve/:id/export",
      () => import("../../src/app/api/scheme-solve/[id]/export/route"),
    ],
    [
      "/api/scheme-solve/:id/artifact",
      () => import("../../src/app/api/scheme-solve/[id]/artifact/route"),
    ],
    ["/api/virtual-sim", () => import("../../src/app/api/virtual-sim/route")],
    [
      "/api/virtual-sim/:id",
      () => import("../../src/app/api/virtual-sim/[id]/route"),
    ],
    [
      "/api/virtual-sim/:id/run",
      () => import("../../src/app/api/virtual-sim/[id]/run/route"),
    ],
    [
      "/api/virtual-sim/:id/viz",
      () => import("../../src/app/api/virtual-sim/[id]/viz/route"),
    ],
    [
      "/api/virtual-sim/:id/artifact",
      () => import("../../src/app/api/virtual-sim/[id]/artifact/route"),
    ],
    ["/api/ppt-voice", () => import("../../src/app/api/ppt-voice/route")],
    [
      "/api/ppt-voice/settings",
      () => import("../../src/app/api/ppt-voice/settings/route"),
    ],
    [
      "/api/ppt-voice/:id",
      () => import("../../src/app/api/ppt-voice/[id]/route"),
    ],
    [
      "/api/ppt-voice/:id/slides",
      () => import("../../src/app/api/ppt-voice/[id]/slides/route"),
    ],
    [
      "/api/ppt-voice/:id/ai",
      () => import("../../src/app/api/ppt-voice/[id]/ai/route"),
    ],
    [
      "/api/ppt-voice/:id/check",
      () => import("../../src/app/api/ppt-voice/[id]/check/route"),
    ],
    [
      "/api/ppt-voice/:id/build",
      () => import("../../src/app/api/ppt-voice/[id]/build/route"),
    ],
    [
      "/api/ppt-voice/:id/preview",
      () => import("../../src/app/api/ppt-voice/[id]/preview/route"),
    ],
    [
      "/api/ppt-voice/:id/download",
      () => import("../../src/app/api/ppt-voice/[id]/download/route"),
    ],
    [
      "/api/ppt-voice/:id/export-video",
      () => import("../../src/app/api/ppt-voice/[id]/export-video/route"),
    ],
    [
      "/api/ppt-voice/:id/render",
      () => import("../../src/app/api/ppt-voice/[id]/render/route"),
    ],
    [
      "/api/ppt-voice/:id/chat",
      () => import("../../src/app/api/ppt-voice/[id]/chat/route"),
    ],
    ["/api/ingest", () => import("../../src/app/api/ingest/route")],
    [
      "/api/opencode/health",
      () => import("../../src/app/api/opencode/health/route"),
    ],
    ["/api/papers", () => import("../../src/app/api/papers/route")],
    ["/api/patents", () => import("../../src/app/api/patents/route")],
    ["/api/patents/:id", () => import("../../src/app/api/patents/[id]/route")],
    [
      "/api/patents/:id/generate",
      () => import("../../src/app/api/patents/[id]/generate/route"),
    ],
    [
      "/api/patents/:id/download",
      () => import("../../src/app/api/patents/[id]/download/route"),
    ],
    ["/api/ragpack", () => import("../../src/app/api/ragpack/route")],
    ["/api/records", () => import("../../src/app/api/records/route")],
    ["/api/corpus", () => import("../../src/app/api/corpus/route")],
    [
      "/api/corpus/content",
      () => import("../../src/app/api/corpus/content/route"),
    ],
    [
      "/api/corpus/comments",
      () => import("../../src/app/api/corpus/comments/route"),
    ],
    [
      "/api/corpus/comments/:id",
      () => import("../../src/app/api/corpus/comments/[id]/route"),
    ],
    ["/api/reindex", () => import("../../src/app/api/reindex/route")],
    ["/api/schema", () => import("../../src/app/api/schema/route")],
    ["/api/search", () => import("../../src/app/api/search/route")],
    ["/api/settings", () => import("../../src/app/api/settings/route")],
    [
      "/api/settings/probe",
      () => import("../../src/app/api/settings/probe/route"),
    ],
    [
      "/api/settings/test",
      () => import("../../src/app/api/settings/test/route"),
    ],
    ["/api/stats", () => import("../../src/app/api/stats/route")],
    [
      "/api/system/runtime",
      () => import("../../src/app/api/system/runtime/route"),
    ],
    [
      "/api/system/model-context",
      () => import("../../src/app/api/system/model-context/route"),
    ],
    [
      "/api/system/subagent-router",
      () => import("../../src/app/api/system/subagent-router/route"),
    ],
    [
      "/api/system/thinking-levels",
      () => import("../../src/app/api/system/thinking-levels/route"),
    ],
    [
      "/api/system/context-usage",
      () => import("../../src/app/api/system/context-usage/route"),
    ],
  ];

  for (const [path, load] of modules) {
    const mod = await load();
    registerModule(app, path, mod);
  }
}
