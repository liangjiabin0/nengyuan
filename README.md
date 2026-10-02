# 能源系统恢复（claude版）

能元（AI4ES）系统的**可编译、可运行**重建源码。由 Claude 从多层恢复材料拼装，并逐模块对照服务器线上部署产物（`dist/runtime/*.mjs` 与 `.next`）校正。

## 来源（`_来源清单.json` 逐文件记录）

| 标记 | 来源 | 文件数 |
|---|---|---|
| `bk` | 服务器被清空后残留的配置、`public/`、`.opencode/` 技能与非 TS 脚本 | 662 |
| `00` | 旧版完整源码 e856183（仅取 `server/`、`scripts/`） | 139 |
| `01` | 快照源码（`src/`、tsconfig 等） | 424 |
| `04` | 从服务器磁盘直接恢复的最新 TS 源码（优先级最高） | 41 |

后加载的覆盖先加载的。之后再与线上编译产物逐一比对，把落后于线上的文件改成线上版本：

- 文件里标 **【按线上版本补回】**：源码缺失，依据线上产物补回（如 `/models` 页面、`scripts/check-postgres.ts`）。
- 标 **【按线上版本还原】**：源码比线上旧，按线上逻辑改写（附件自动转 Markdown、记忆钉住/搜索、对话切换模型等）。
- 标 **【重建说明】**：仅为通过编译做的最小改动。

`git grep -E "【按线上版本|【重建说明】"` 可列出全部改动点。

## 验证结果（2026-10-02，Node 24 / PostgreSQL 16）

- `npm run typecheck`：0 错误
- `npm run build`：成功，22 个页面路由，与线上清单一致
- `npm run bundle:server`：成功，0 警告
- 用 2026-09-30 数据库备份在本机还原后，API、worker、前端均可启动；19 个页面与主要接口返回真实数据

## 本地运行

```bash
npm ci
cp .env.example .env.local   # 填 DATABASE_URL、DEFAULT_ADMIN_PASSWORD 等，切勿提交
npm run build                # 内存不足可设 AI4ES_BUILD_MEMORY_MB=6144
npm run bundle:server
node dist/runtime/check-postgres.mjs
AI4ES_ROLE=api AI4ES_USE_JOB_QUEUE=1 node dist/runtime/api.mjs        # :4000
AI4ES_ROLE=worker AI4ES_USE_JOB_QUEUE=0 node dist/runtime/worker.mjs
AI4ES_SPLIT=1 AI4ES_API_URL=http://127.0.0.1:4000 npx next start -p 3000
```

线上用 pm2 管理，见 `ecosystem.config.cjs`。注意：前端构建时会把 `AI4ES_API_URL` 写进路由转发，改 API 端口需重新 `npm run build`。

## 不在仓库里的

`node_modules/`、`.next/`、`dist/`、`.env.local`、`storage/`、`数据/`（论文等语料）、数据库备份、各工具的 Python venv。
