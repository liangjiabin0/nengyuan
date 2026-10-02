# 能源系统恢复（合并版）

能元（AI4ES）系统的**可编译、可运行**重建源码。这一版把两份恢复成果合在一起，各取所长：

- **claude 版**（`liangjiabin0/nengyuan-recovery-full-claude`）：TypeScript 源码最新、最全，逐模块对照线上部署产物校正过。
- **codex 版**（`liangjiabin0/nengyuan-recovery-full-codex`）：带有完整的 `tools/` 计算工具和 `solverCompetition/`，还有详细的恢复记录。

## 合并规则：每块用谁的

| 内容 | 采用 | 理由 |
|---|---|---|
| `src/`、`server/`（前后端 TS 源码） | claude 版 | 与线上产物比对，后端 0 缺模块；codex 版缺 11 个模块，后端靠反编译 JS 运行 |
| `src/components/ppt-voice-settings-panel.tsx` | codex 版 | 唯一比 claude 版新的源码文件（健康检查多了 LibreOffice/ffmpeg/嵌入引擎、Linux 说明） |
| `scripts/` | claude 版 + 6 个按线上替换 | `intranet-start.ps1`、`llm-gateway.mjs`、`opencode-sidecar.ps1`、`organize-data-dir.py`、`pack-intranet.ps1`、`remap-data-paths.js` 原先误用了旧版，现与线上一致 |
| `package.json`、`next.config.js`、`.env.example` 等 | claude 版 | 与线上完全一致（96 个 npm 脚本） |
| `.opencode/`（技能、智能体、插件） | claude 版 | 比 codex 多 237 个模板/素材文件；另补入 `.opencode/tools/*.ts` 与 `subagent-router.json` |
| `tools/`（约 2000 个文件） | codex 版 | claude 版没有。含 esopt、tdmg 潮流调度、配网损耗、风光负荷预测、微网规划、PPT 配音、Office 文档等 |
| `solverCompetition/` | codex 版 | claude 版没有 |
| `AGENTS.md`、`CLAUDE.md`、`DEPLOY.md`、`SYSTEM_DEPENDENCIES.md` | 线上部署目录 | 原项目文档；原 README 放在 `docs/原项目/README.md` |
| `docs/codex恢复记录/` | codex 版 | codex 的恢复过程、来源清单、脱敏记录，留作溯源 |

没有收进来的：codex 的 `server/recovered/`（反编译 JS，本版用 TS 源码，不需要；需要时到 codex 仓库查）、`scripts/tmp-*` 等临时脚本。

## 源码里的标记

- **【按线上版本补回】**：源码缺失，依据线上产物补回。
- **【按线上版本还原】**：源码比线上旧，按线上逻辑改写。
- **【重建说明】**：只为通过编译做的最小改动。
- **【合并版】**：合并时做的改动。

`git grep -E "【按线上版本|【重建说明】|【合并版】"` 可列出全部改动点。

## 验证结果（2026-10-02，Node 24 / PostgreSQL 16）

- `npm run typecheck`：0 错误
- `npm run build`：成功
- `npm run bundle:server`：成功，0 警告
- 连接用 2026-09-30 备份还原的数据库启动 API 与前端：登录、对话、语料、技能、设置、子智能体路由等接口都返回 200，17 个页面正常打开（`/data`、`/patent`、`/research-review` 本身是跳转页，返回 307）

## 本地运行

```bash
npm ci
cp .env.example .env.local   # 填 DATABASE_URL、DEFAULT_ADMIN_PASSWORD、OPENALEX_API_KEY 等，切勿提交
npm run build                # 内存不足可设 AI4ES_BUILD_MEMORY_MB=6144
npm run bundle:server
node dist/runtime/check-postgres.mjs
AI4ES_ROLE=api AI4ES_USE_JOB_QUEUE=1 node dist/runtime/api.mjs        # :4000
AI4ES_ROLE=worker AI4ES_USE_JOB_QUEUE=0 node dist/runtime/worker.mjs
AI4ES_SPLIT=1 AI4ES_API_URL=http://127.0.0.1:4000 npx next start -p 3000
```

当前 Linux 服务器以 systemd 启动 `scripts/linux/intranet-start.sh prod`；修复后的约定见 `docs/recovery-deployment.md`。PM2 为可选策略，不是必装依赖。注意：前端构建时会把 `AI4ES_API_URL` 写进路由转发，改 API 端口后要重新 `npm run build`。

各计算工具的 Python 环境需要单独安装，见各 `tools/*/SKILL.md`。`tools/tdmg-acopf-dispatch/scripts/_vendor/` 不入库，运行该目录下的 `bootstrap.py` 会自动装好。

## 不在仓库里的

`node_modules/`、`.next/`、`dist/`、`.env.local`、`storage/`、`数据/`（论文等语料）、数据库备份、各工具的 Python venv 和二进制（mupdf、LibreOffice 等）。OpenAlex 的 key 已从代码中移除，改为从环境变量 `OPENALEX_API_KEY` 读取。
