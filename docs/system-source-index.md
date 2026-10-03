# 能元系统页面、API 与技能源码索引

依据源码基线 `990a210` 自动枚举，整理日期：2026-10-03。配合[系统架构与功能说明](system-architecture-and-features.md)阅读。

本索引描述入口位置；接口鉴权、请求参数、权限和响应格式仍以对应源码为准。动态参数保留 Next 路由的 `[id]` 写法，Hono 注册时会转换为 `:id`。

## 1. 页面入口（20 个源码文件）

|URL|页面源码|跳转行为|
|---|---|---|
|`/account/password`|[src/app/(dashboard)/account/password/page.tsx](../src/app/(dashboard)/account/password/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/admin/users`|[src/app/(dashboard)/admin/users/page.tsx](../src/app/(dashboard)/admin/users/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/chat`|[src/app/(dashboard)/chat/page.tsx](../src/app/(dashboard)/chat/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/corpus`|[src/app/(dashboard)/corpus/page.tsx](../src/app/(dashboard)/corpus/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/data`|[src/app/(dashboard)/data/page.tsx](../src/app/(dashboard)/data/page.tsx)|跳转至 `/settings?tab=data`|
|`/graph`|[src/app/(dashboard)/graph/page.tsx](../src/app/(dashboard)/graph/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/grid-guide`|[src/app/(dashboard)/grid-guide/page.tsx](../src/app/(dashboard)/grid-guide/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/models`|[src/app/(dashboard)/models/page.tsx](../src/app/(dashboard)/models/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/`|[src/app/(dashboard)/page.tsx](../src/app/(dashboard)/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/patent`|[src/app/(dashboard)/patent/page.tsx](../src/app/(dashboard)/patent/page.tsx)|跳转至 `/chat?tool=patent`|
|`/ppt-voice`|[src/app/(dashboard)/ppt-voice/page.tsx](../src/app/(dashboard)/ppt-voice/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/research-review`|[src/app/(dashboard)/research-review/page.tsx](../src/app/(dashboard)/research-review/page.tsx)|跳转至 `/chat?tool=research-review`|
|`/scheme-solve`|[src/app/(dashboard)/scheme-solve/page.tsx](../src/app/(dashboard)/scheme-solve/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/self-learning`|[src/app/(dashboard)/self-learning/page.tsx](../src/app/(dashboard)/self-learning/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/settings`|[src/app/(dashboard)/settings/page.tsx](../src/app/(dashboard)/settings/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/skills`|[src/app/(dashboard)/skills/page.tsx](../src/app/(dashboard)/skills/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/tables`|[src/app/(dashboard)/tables/page.tsx](../src/app/(dashboard)/tables/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/virtual-sim`|[src/app/(dashboard)/virtual-sim/page.tsx](../src/app/(dashboard)/virtual-sim/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/login`|[src/app/login/page.tsx](../src/app/login/page.tsx)|页面组件；是否出现在菜单由导航配置决定|
|`/screen`|[src/app/screen/page.tsx](../src/app/screen/page.tsx)|页面组件；是否出现在菜单由导航配置决定|

## 2. API Route 模块（107 个源码文件）

生产拆分模式由 `server/api/routes.ts` 挂载这些模块。这里统计的是 Route 文件数，单文件可以导出多个 HTTP 方法，不等于端点与方法组合数。

|URL|导出的 HTTP 方法|源码|Hono 显式导入|
|---|---|---|---|
|`/api/admin/users/[id]`|DELETE/PATCH|[src/app/api/admin/users/[id]/route.ts](../src/app/api/admin/users/[id]/route.ts)|是|
|`/api/admin/users`|DELETE/GET/PATCH/POST|[src/app/api/admin/users/route.ts](../src/app/api/admin/users/route.ts)|是|
|`/api/auth/login`|DELETE/POST|[src/app/api/auth/login/route.ts](../src/app/api/auth/login/route.ts)|是|
|`/api/auth/logout`|POST|[src/app/api/auth/logout/route.ts](../src/app/api/auth/logout/route.ts)|是|
|`/api/auth/me`|GET|[src/app/api/auth/me/route.ts](../src/app/api/auth/me/route.ts)|是|
|`/api/auth/password`|POST|[src/app/api/auth/password/route.ts](../src/app/api/auth/password/route.ts)|是|
|`/api/bootstrap`|GET|[src/app/api/bootstrap/route.ts](../src/app/api/bootstrap/route.ts)|是|
|`/api/chat/attachments/[id]/preview`|GET|[src/app/api/chat/attachments/[id]/preview/route.ts](../src/app/api/chat/attachments/[id]/preview/route.ts)|是|
|`/api/chat/attachments`|DELETE/GET/POST|[src/app/api/chat/attachments/route.ts](../src/app/api/chat/attachments/route.ts)|是|
|`/api/chat/conversations/[id]/messages/[messageId]/revert`|POST|[src/app/api/chat/conversations/[id]/messages/[messageId]/revert/route.ts](../src/app/api/chat/conversations/[id]/messages/[messageId]/revert/route.ts)|是|
|`/api/chat/conversations/[id]/messages/[messageId]`|DELETE|[src/app/api/chat/conversations/[id]/messages/[messageId]/route.ts](../src/app/api/chat/conversations/[id]/messages/[messageId]/route.ts)|是|
|`/api/chat/conversations/[id]/question`|GET/POST|[src/app/api/chat/conversations/[id]/question/route.ts](../src/app/api/chat/conversations/[id]/question/route.ts)|是|
|`/api/chat/conversations/[id]/repro-progress`|GET|[src/app/api/chat/conversations/[id]/repro-progress/route.ts](../src/app/api/chat/conversations/[id]/repro-progress/route.ts)|是|
|`/api/chat/conversations/[id]`|DELETE/GET/PATCH|[src/app/api/chat/conversations/[id]/route.ts](../src/app/api/chat/conversations/[id]/route.ts)|是|
|`/api/chat/conversations/[id]/stop`|POST|[src/app/api/chat/conversations/[id]/stop/route.ts](../src/app/api/chat/conversations/[id]/stop/route.ts)|是|
|`/api/chat/conversations/[id]/title`|POST|[src/app/api/chat/conversations/[id]/title/route.ts](../src/app/api/chat/conversations/[id]/title/route.ts)|是|
|`/api/chat/conversations`|GET/POST|[src/app/api/chat/conversations/route.ts](../src/app/api/chat/conversations/route.ts)|是|
|`/api/chat/live`|GET|[src/app/api/chat/live/route.ts](../src/app/api/chat/live/route.ts)|是|
|`/api/chat/queue/[id]`|DELETE|[src/app/api/chat/queue/[id]/route.ts](../src/app/api/chat/queue/[id]/route.ts)|是|
|`/api/chat/queue/next`|POST|[src/app/api/chat/queue/next/route.ts](../src/app/api/chat/queue/next/route.ts)|是|
|`/api/chat/queue`|GET/POST|[src/app/api/chat/queue/route.ts](../src/app/api/chat/queue/route.ts)|是|
|`/api/chat`|POST|[src/app/api/chat/route.ts](../src/app/api/chat/route.ts)|是|
|`/api/corpus/comments/[id]`|DELETE/PATCH|[src/app/api/corpus/comments/[id]/route.ts](../src/app/api/corpus/comments/[id]/route.ts)|是|
|`/api/corpus/comments`|GET/POST|[src/app/api/corpus/comments/route.ts](../src/app/api/corpus/comments/route.ts)|是|
|`/api/corpus/content`|GET|[src/app/api/corpus/content/route.ts](../src/app/api/corpus/content/route.ts)|是|
|`/api/corpus`|GET|[src/app/api/corpus/route.ts](../src/app/api/corpus/route.ts)|是|
|`/api/data-import`|GET/POST|[src/app/api/data-import/route.ts](../src/app/api/data-import/route.ts)|是|
|`/api/files/preview`|GET|[src/app/api/files/preview/route.ts](../src/app/api/files/preview/route.ts)|是|
|`/api/graph/analytics`|GET|[src/app/api/graph/analytics/route.ts](../src/app/api/graph/analytics/route.ts)|是|
|`/api/graph/rebuild`|POST|[src/app/api/graph/rebuild/route.ts](../src/app/api/graph/rebuild/route.ts)|是|
|`/api/graph`|GET|[src/app/api/graph/route.ts](../src/app/api/graph/route.ts)|是|
|`/api/grid-guides/[id]/chat`|POST|[src/app/api/grid-guides/[id]/chat/route.ts](../src/app/api/grid-guides/[id]/chat/route.ts)|是|
|`/api/grid-guides/[id]/download`|GET|[src/app/api/grid-guides/[id]/download/route.ts](../src/app/api/grid-guides/[id]/download/route.ts)|是|
|`/api/grid-guides/[id]/files/content`|GET/PUT|[src/app/api/grid-guides/[id]/files/content/route.ts](../src/app/api/grid-guides/[id]/files/content/route.ts)|是|
|`/api/grid-guides/[id]/files/preview`|GET|[src/app/api/grid-guides/[id]/files/preview/route.ts](../src/app/api/grid-guides/[id]/files/preview/route.ts)|是|
|`/api/grid-guides/[id]/files`|GET|[src/app/api/grid-guides/[id]/files/route.ts](../src/app/api/grid-guides/[id]/files/route.ts)|是|
|`/api/grid-guides/[id]`|DELETE/GET/PATCH|[src/app/api/grid-guides/[id]/route.ts](../src/app/api/grid-guides/[id]/route.ts)|是|
|`/api/grid-guides/attachments/[id]/preview`|GET|[src/app/api/grid-guides/attachments/[id]/preview/route.ts](../src/app/api/grid-guides/attachments/[id]/preview/route.ts)|是|
|`/api/grid-guides`|GET/POST|[src/app/api/grid-guides/route.ts](../src/app/api/grid-guides/route.ts)|是|
|`/api/images/edits`|POST|[src/app/api/images/edits/route.ts](../src/app/api/images/edits/route.ts)|是|
|`/api/images/generate`|POST|[src/app/api/images/generate/route.ts](../src/app/api/images/generate/route.ts)|是|
|`/api/ingest`|POST|[src/app/api/ingest/route.ts](../src/app/api/ingest/route.ts)|是|
|`/api/opencode/health`|GET|[src/app/api/opencode/health/route.ts](../src/app/api/opencode/health/route.ts)|是|
|`/api/papers`|GET/POST|[src/app/api/papers/route.ts](../src/app/api/papers/route.ts)|是|
|`/api/patents/[id]/download`|GET|[src/app/api/patents/[id]/download/route.ts](../src/app/api/patents/[id]/download/route.ts)|是|
|`/api/patents/[id]/generate`|DELETE/GET/POST|[src/app/api/patents/[id]/generate/route.ts](../src/app/api/patents/[id]/generate/route.ts)|是|
|`/api/patents/[id]`|DELETE/GET/PATCH|[src/app/api/patents/[id]/route.ts](../src/app/api/patents/[id]/route.ts)|是|
|`/api/patents`|GET/POST|[src/app/api/patents/route.ts](../src/app/api/patents/route.ts)|是|
|`/api/ppt-voice/[id]/ai`|POST|[src/app/api/ppt-voice/[id]/ai/route.ts](../src/app/api/ppt-voice/[id]/ai/route.ts)|是|
|`/api/ppt-voice/[id]/build`|POST|[src/app/api/ppt-voice/[id]/build/route.ts](../src/app/api/ppt-voice/[id]/build/route.ts)|是|
|`/api/ppt-voice/[id]/chat`|POST|[src/app/api/ppt-voice/[id]/chat/route.ts](../src/app/api/ppt-voice/[id]/chat/route.ts)|是|
|`/api/ppt-voice/[id]/check`|POST|[src/app/api/ppt-voice/[id]/check/route.ts](../src/app/api/ppt-voice/[id]/check/route.ts)|是|
|`/api/ppt-voice/[id]/download`|GET|[src/app/api/ppt-voice/[id]/download/route.ts](../src/app/api/ppt-voice/[id]/download/route.ts)|是|
|`/api/ppt-voice/[id]/export-video`|POST|[src/app/api/ppt-voice/[id]/export-video/route.ts](../src/app/api/ppt-voice/[id]/export-video/route.ts)|是|
|`/api/ppt-voice/[id]/preview`|POST|[src/app/api/ppt-voice/[id]/preview/route.ts](../src/app/api/ppt-voice/[id]/preview/route.ts)|是|
|`/api/ppt-voice/[id]/render`|POST|[src/app/api/ppt-voice/[id]/render/route.ts](../src/app/api/ppt-voice/[id]/render/route.ts)|是|
|`/api/ppt-voice/[id]`|DELETE/GET/PATCH|[src/app/api/ppt-voice/[id]/route.ts](../src/app/api/ppt-voice/[id]/route.ts)|是|
|`/api/ppt-voice/[id]/slides`|PATCH|[src/app/api/ppt-voice/[id]/slides/route.ts](../src/app/api/ppt-voice/[id]/slides/route.ts)|是|
|`/api/ppt-voice`|GET/POST|[src/app/api/ppt-voice/route.ts](../src/app/api/ppt-voice/route.ts)|是|
|`/api/ppt-voice/settings`|GET/POST|[src/app/api/ppt-voice/settings/route.ts](../src/app/api/ppt-voice/settings/route.ts)|是|
|`/api/ragpack`|GET/POST/PUT|[src/app/api/ragpack/route.ts](../src/app/api/ragpack/route.ts)|是|
|`/api/records`|DELETE/GET/PATCH|[src/app/api/records/route.ts](../src/app/api/records/route.ts)|是|
|`/api/reindex`|GET/POST|[src/app/api/reindex/route.ts](../src/app/api/reindex/route.ts)|是|
|`/api/research-review/artifacts/[id]`|GET|[src/app/api/research-review/artifacts/[id]/route.ts](../src/app/api/research-review/artifacts/[id]/route.ts)|是|
|`/api/research-review/attachments/[id]/preview`|GET|[src/app/api/research-review/attachments/[id]/preview/route.ts](../src/app/api/research-review/attachments/[id]/preview/route.ts)|是|
|`/api/research-review/attachments`|DELETE/GET/POST|[src/app/api/research-review/attachments/route.ts](../src/app/api/research-review/attachments/route.ts)|是|
|`/api/research-review/conversations/[id]`|DELETE/GET/PATCH|[src/app/api/research-review/conversations/[id]/route.ts](../src/app/api/research-review/conversations/[id]/route.ts)|是|
|`/api/research-review/conversations/[id]/title`|POST|[src/app/api/research-review/conversations/[id]/title/route.ts](../src/app/api/research-review/conversations/[id]/title/route.ts)|是|
|`/api/research-review/conversations`|GET/POST|[src/app/api/research-review/conversations/route.ts](../src/app/api/research-review/conversations/route.ts)|是|
|`/api/research-review/export`|POST|[src/app/api/research-review/export/route.ts](../src/app/api/research-review/export/route.ts)|是|
|`/api/research-review`|POST|[src/app/api/research-review/route.ts](../src/app/api/research-review/route.ts)|是|
|`/api/schema`|GET|[src/app/api/schema/route.ts](../src/app/api/schema/route.ts)|是|
|`/api/scheme-solve/[id]/artifact`|GET|[src/app/api/scheme-solve/[id]/artifact/route.ts](../src/app/api/scheme-solve/[id]/artifact/route.ts)|是|
|`/api/scheme-solve/[id]/brainstorm`|POST|[src/app/api/scheme-solve/[id]/brainstorm/route.ts](../src/app/api/scheme-solve/[id]/brainstorm/route.ts)|是|
|`/api/scheme-solve/[id]/events`|GET|[src/app/api/scheme-solve/[id]/events/route.ts](../src/app/api/scheme-solve/[id]/events/route.ts)|是|
|`/api/scheme-solve/[id]/export`|POST|[src/app/api/scheme-solve/[id]/export/route.ts](../src/app/api/scheme-solve/[id]/export/route.ts)|是|
|`/api/scheme-solve/[id]/mgplan/clone`|POST|[src/app/api/scheme-solve/[id]/mgplan/clone/route.ts](../src/app/api/scheme-solve/[id]/mgplan/clone/route.ts)|是|
|`/api/scheme-solve/[id]/mgplan/file`|GET|[src/app/api/scheme-solve/[id]/mgplan/file/route.ts](../src/app/api/scheme-solve/[id]/mgplan/file/route.ts)|是|
|`/api/scheme-solve/[id]/mgplan/files`|POST|[src/app/api/scheme-solve/[id]/mgplan/files/route.ts](../src/app/api/scheme-solve/[id]/mgplan/files/route.ts)|是|
|`/api/scheme-solve/[id]/mgplan/results`|GET|[src/app/api/scheme-solve/[id]/mgplan/results/route.ts](../src/app/api/scheme-solve/[id]/mgplan/results/route.ts)|是|
|`/api/scheme-solve/[id]/mgplan`|GET/PUT|[src/app/api/scheme-solve/[id]/mgplan/route.ts](../src/app/api/scheme-solve/[id]/mgplan/route.ts)|是|
|`/api/scheme-solve/[id]/mgplan/solve`|POST|[src/app/api/scheme-solve/[id]/mgplan/solve/route.ts](../src/app/api/scheme-solve/[id]/mgplan/solve/route.ts)|是|
|`/api/scheme-solve/[id]/research`|POST|[src/app/api/scheme-solve/[id]/research/route.ts](../src/app/api/scheme-solve/[id]/research/route.ts)|是|
|`/api/scheme-solve/[id]`|DELETE/GET|[src/app/api/scheme-solve/[id]/route.ts](../src/app/api/scheme-solve/[id]/route.ts)|是|
|`/api/scheme-solve/attachments/[id]/preview`|GET|[src/app/api/scheme-solve/attachments/[id]/preview/route.ts](../src/app/api/scheme-solve/attachments/[id]/preview/route.ts)|是|
|`/api/scheme-solve/attachments`|GET/POST|[src/app/api/scheme-solve/attachments/route.ts](../src/app/api/scheme-solve/attachments/route.ts)|是|
|`/api/scheme-solve`|GET/POST|[src/app/api/scheme-solve/route.ts](../src/app/api/scheme-solve/route.ts)|是|
|`/api/search`|GET/POST|[src/app/api/search/route.ts](../src/app/api/search/route.ts)|是|
|`/api/self-learning/agent`|POST|[src/app/api/self-learning/agent/route.ts](../src/app/api/self-learning/agent/route.ts)|是|
|`/api/self-learning`|DELETE/GET/PATCH|[src/app/api/self-learning/route.ts](../src/app/api/self-learning/route.ts)|是|
|`/api/settings/probe`|POST|[src/app/api/settings/probe/route.ts](../src/app/api/settings/probe/route.ts)|是|
|`/api/settings`|GET/POST|[src/app/api/settings/route.ts](../src/app/api/settings/route.ts)|是|
|`/api/settings/test`|POST|[src/app/api/settings/test/route.ts](../src/app/api/settings/test/route.ts)|是|
|`/api/skills/[id]`|DELETE/GET/PUT|[src/app/api/skills/[id]/route.ts](../src/app/api/skills/[id]/route.ts)|是|
|`/api/skills/agent`|POST|[src/app/api/skills/agent/route.ts](../src/app/api/skills/agent/route.ts)|是|
|`/api/skills`|GET/POST|[src/app/api/skills/route.ts](../src/app/api/skills/route.ts)|是|
|`/api/stats`|GET|[src/app/api/stats/route.ts](../src/app/api/stats/route.ts)|是|
|`/api/system/context-usage`|GET|[src/app/api/system/context-usage/route.ts](../src/app/api/system/context-usage/route.ts)|是|
|`/api/system/model-context`|GET|[src/app/api/system/model-context/route.ts](../src/app/api/system/model-context/route.ts)|是|
|`/api/system/runtime`|GET|[src/app/api/system/runtime/route.ts](../src/app/api/system/runtime/route.ts)|是|
|`/api/system/subagent-router`|GET/POST|[src/app/api/system/subagent-router/route.ts](../src/app/api/system/subagent-router/route.ts)|是|
|`/api/system/thinking-levels`|GET|[src/app/api/system/thinking-levels/route.ts](../src/app/api/system/thinking-levels/route.ts)|是|
|`/api/virtual-sim/[id]/artifact`|GET|[src/app/api/virtual-sim/[id]/artifact/route.ts](../src/app/api/virtual-sim/[id]/artifact/route.ts)|是|
|`/api/virtual-sim/[id]`|DELETE/GET|[src/app/api/virtual-sim/[id]/route.ts](../src/app/api/virtual-sim/[id]/route.ts)|是|
|`/api/virtual-sim/[id]/run`|POST|[src/app/api/virtual-sim/[id]/run/route.ts](../src/app/api/virtual-sim/[id]/run/route.ts)|是|
|`/api/virtual-sim/[id]/viz`|GET|[src/app/api/virtual-sim/[id]/viz/route.ts](../src/app/api/virtual-sim/[id]/viz/route.ts)|是|
|`/api/virtual-sim`|GET/POST|[src/app/api/virtual-sim/route.ts](../src/app/api/virtual-sim/route.ts)|是|

Hono 还直接定义 `/api/health`、`/api/jobs`、`/api/jobs/:id` 等基础接口；其实现见 [server/api/routes.ts](../server/api/routes.ts)。`/api/jobs` 与 `/:id` 的方法/权限请直接查看该文件，不存在同名 Next Route 文件也不代表接口缺失。

## 3. 仓库内技能定义

以下枚举 `.opencode/skills/` 中有 `SKILL.md` 的目录。技能是否对某用户可见、能否执行，以及运行时 materialize 后的路径，由共享技能和权限代码决定；不等于每项都已经完成业务验收。

|技能目录|定义文件|
|---|---|
|`docx`|[.opencode/skills/docx/SKILL.md](../.opencode/skills/docx/SKILL.md)|
|`energy-autonomous-research`|[.opencode/skills/energy-autonomous-research/SKILL.md](../.opencode/skills/energy-autonomous-research/SKILL.md)|
|`esopt`|[.opencode/skills/esopt/SKILL.md](../.opencode/skills/esopt/SKILL.md)|
|`image-generation`|[.opencode/skills/image-generation/SKILL.md](../.opencode/skills/image-generation/SKILL.md)|
|`markitdown`|[.opencode/skills/markitdown/SKILL.md](../.opencode/skills/markitdown/SKILL.md)|
|`mgplan-calculation`|[.opencode/skills/mgplan-calculation/SKILL.md](../.opencode/skills/mgplan-calculation/SKILL.md)|
|`modelica-standard-style`|[.opencode/skills/modelica-standard-style/SKILL.md](../.opencode/skills/modelica-standard-style/SKILL.md)|
|`nwxs-theoretical-loss-calculation`|[.opencode/skills/nwxs-theoretical-loss-calculation/SKILL.md](../.opencode/skills/nwxs-theoretical-loss-calculation/SKILL.md)|
|`openalex`|[.opencode/skills/openalex/SKILL.md](../.opencode/skills/openalex/SKILL.md)|
|`paper-reproduce`|[.opencode/skills/paper-reproduce/SKILL.md](../.opencode/skills/paper-reproduce/SKILL.md)|
|`patent-aris-claims`|[.opencode/skills/patent-aris-claims/SKILL.md](../.opencode/skills/patent-aris-claims/SKILL.md)|
|`patent-aris-review`|[.opencode/skills/patent-aris-review/SKILL.md](../.opencode/skills/patent-aris-review/SKILL.md)|
|`patent-aris-specification`|[.opencode/skills/patent-aris-specification/SKILL.md](../.opencode/skills/patent-aris-specification/SKILL.md)|
|`patent-aris-structure`|[.opencode/skills/patent-aris-structure/SKILL.md](../.opencode/skills/patent-aris-structure/SKILL.md)|
|`patent-audit`|[.opencode/skills/patent-audit/SKILL.md](../.opencode/skills/patent-audit/SKILL.md)|
|`patent-claims`|[.opencode/skills/patent-claims/SKILL.md](../.opencode/skills/patent-claims/SKILL.md)|
|`patent-clarification`|[.opencode/skills/patent-clarification/SKILL.md](../.opencode/skills/patent-clarification/SKILL.md)|
|`patent-disclosure`|[.opencode/skills/patent-disclosure/SKILL.md](../.opencode/skills/patent-disclosure/SKILL.md)|
|`patent-drawings`|[.opencode/skills/patent-drawings/SKILL.md](../.opencode/skills/patent-drawings/SKILL.md)|
|`patent-ref-cn-format`|[.opencode/skills/patent-ref-cn-format/SKILL.md](../.opencode/skills/patent-ref-cn-format/SKILL.md)|
|`patent-ref-principles`|[.opencode/skills/patent-ref-principles/SKILL.md](../.opencode/skills/patent-ref-principles/SKILL.md)|
|`patent-specification`|[.opencode/skills/patent-specification/SKILL.md](../.opencode/skills/patent-specification/SKILL.md)|
|`patent-strategy`|[.opencode/skills/patent-strategy/SKILL.md](../.opencode/skills/patent-strategy/SKILL.md)|
|`pdf`|[.opencode/skills/pdf/SKILL.md](../.opencode/skills/pdf/SKILL.md)|
|`power-dispatch-optimization`|[.opencode/skills/power-dispatch-optimization/SKILL.md](../.opencode/skills/power-dispatch-optimization/SKILL.md)|
|`pptx`|[.opencode/skills/pptx/SKILL.md](../.opencode/skills/pptx/SKILL.md)|
|`pv-wind-load-forecast`|[.opencode/skills/pv-wind-load-forecast/SKILL.md](../.opencode/skills/pv-wind-load-forecast/SKILL.md)|
|`scheme-technical-report`|[.opencode/skills/scheme-technical-report/SKILL.md](../.opencode/skills/scheme-technical-report/SKILL.md)|
|`self-learning`|[.opencode/skills/self-learning/SKILL.md](../.opencode/skills/self-learning/SKILL.md)|
|`ses-iesp-esopt`|[.opencode/skills/ses-iesp-esopt/SKILL.md](../.opencode/skills/ses-iesp-esopt/SKILL.md)|
|`sgcc-tech-guide`|[.opencode/skills/sgcc-tech-guide/SKILL.md](../.opencode/skills/sgcc-tech-guide/SKILL.md)|
|`shared-paper-peer-review`|[.opencode/skills/shared-paper-peer-review/SKILL.md](../.opencode/skills/shared-paper-peer-review/SKILL.md)|
|`shared-sgcc-tech-guide`|[.opencode/skills/shared-sgcc-tech-guide/SKILL.md](../.opencode/skills/shared-sgcc-tech-guide/SKILL.md)|
|`shared-technical-report-ppt-pipeline`|[.opencode/skills/shared-technical-report-ppt-pipeline/SKILL.md](../.opencode/skills/shared-technical-report-ppt-pipeline/SKILL.md)|
|`shared-two-slide-paper-ppt-codegen`|[.opencode/skills/shared-two-slide-paper-ppt-codegen/SKILL.md](../.opencode/skills/shared-two-slide-paper-ppt-codegen/SKILL.md)|
|`tdmg-acopf-dispatch`|[.opencode/skills/tdmg-acopf-dispatch/SKILL.md](../.opencode/skills/tdmg-acopf-dispatch/SKILL.md)|
|`writing-source-grounded-research-reviews`|[.opencode/skills/writing-source-grounded-research-reviews/SKILL.md](../.opencode/skills/writing-source-grounded-research-reviews/SKILL.md)|
|`xlsx`|[.opencode/skills/xlsx/SKILL.md](../.opencode/skills/xlsx/SKILL.md)|

## 4. 工具根目录

|目录|直接存在的说明/依赖文件|
|---|---|
|`tools/caj2pdf-fresh/`|从系统架构文档列出的具体入口查阅|
|`tools/chart-discovery/`|[tools/chart-discovery/SKILL.md](../tools/chart-discovery/SKILL.md)|
|`tools/docx/`|[tools/docx/SKILL.md](../tools/docx/SKILL.md)|
|`tools/esopt/`|[tools/esopt/README.md](../tools/esopt/README.md)<br>[tools/esopt/requirements.txt](../tools/esopt/requirements.txt)|
|`tools/image-generation/`|[tools/image-generation/SKILL.md](../tools/image-generation/SKILL.md)|
|`tools/markitdown/`|[tools/markitdown/SKILL.md](../tools/markitdown/SKILL.md)<br>[tools/markitdown/requirements.txt](../tools/markitdown/requirements.txt)|
|`tools/mgplan/`|[tools/mgplan/README.md](../tools/mgplan/README.md)<br>[tools/mgplan/SKILL.md](../tools/mgplan/SKILL.md)<br>[tools/mgplan/requirements.txt](../tools/mgplan/requirements.txt)|
|`tools/nwxs-loss/`|[tools/nwxs-loss/README.md](../tools/nwxs-loss/README.md)<br>[tools/nwxs-loss/SKILL.md](../tools/nwxs-loss/SKILL.md)<br>[tools/nwxs-loss/requirements.txt](../tools/nwxs-loss/requirements.txt)|
|`tools/office-docs/`|[tools/office-docs/requirements.txt](../tools/office-docs/requirements.txt)|
|`tools/openalex/`|[tools/openalex/SKILL.md](../tools/openalex/SKILL.md)|
|`tools/openmodelica-gateway/`|[tools/openmodelica-gateway/requirements.txt](../tools/openmodelica-gateway/requirements.txt)|
|`tools/paper-reproduce/`|从系统架构文档列出的具体入口查阅|
|`tools/pdf/`|[tools/pdf/SKILL.md](../tools/pdf/SKILL.md)|
|`tools/pdf2md/`|[tools/pdf2md/requirements.txt](../tools/pdf2md/requirements.txt)|
|`tools/power-dispatch/`|[tools/power-dispatch/README.md](../tools/power-dispatch/README.md)<br>[tools/power-dispatch/SKILL.md](../tools/power-dispatch/SKILL.md)<br>[tools/power-dispatch/requirements-min.txt](../tools/power-dispatch/requirements-min.txt)<br>[tools/power-dispatch/requirements-full.txt](../tools/power-dispatch/requirements-full.txt)<br>[tools/power-dispatch/pyproject.toml](../tools/power-dispatch/pyproject.toml)|
|`tools/ppt-native/`|从系统架构文档列出的具体入口查阅|
|`tools/ppt-voice/`|[tools/ppt-voice/requirements.txt](../tools/ppt-voice/requirements.txt)|
|`tools/pptx/`|[tools/pptx/SKILL.md](../tools/pptx/SKILL.md)|
|`tools/pv-wind-load-forecast/`|[tools/pv-wind-load-forecast/README.md](../tools/pv-wind-load-forecast/README.md)<br>[tools/pv-wind-load-forecast/SKILL.md](../tools/pv-wind-load-forecast/SKILL.md)<br>[tools/pv-wind-load-forecast/requirements.txt](../tools/pv-wind-load-forecast/requirements.txt)|
|`tools/self-learning/`|[tools/self-learning/SKILL.md](../tools/self-learning/SKILL.md)|
|`tools/ses-iesp-esopt/`|[tools/ses-iesp-esopt/README.md](../tools/ses-iesp-esopt/README.md)|
|`tools/tdmg-acopf-dispatch/`|[tools/tdmg-acopf-dispatch/SKILL.md](../tools/tdmg-acopf-dispatch/SKILL.md)<br>[tools/tdmg-acopf-dispatch/requirements.txt](../tools/tdmg-acopf-dispatch/requirements.txt)|
|`tools/xlsx/`|[tools/xlsx/SKILL.md](../tools/xlsx/SKILL.md)|
