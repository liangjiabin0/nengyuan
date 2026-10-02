# 能元（AI4ES）

本地科研数据检索与智能对话工作台：导入论文 / 专利 / 书籍 / 导师档案与基金 Excel，基于本机 PostgreSQL 做检索与 Agent 问答。

新机器部署只按 [DEPLOY.md](DEPLOY.md) 从上到下做。那里写了基础软件、`.env.local`、PostgreSQL、`npm ci`、`npm run portable:install`（OpenCode、Python 虚拟环境、LibreOffice、MuPDF、Poppler、空语料清单）、启动和验收。数据、密钥、Gurobi 许可不在仓库里。公网能下载的二进制由安装脚本拉取；公网不能下载、运行又需要的求解器二进制和风电权重已经在 Git 中，清单见 DEPLOY.md 第 0 节。

## 快速开始

```powershell
Set-Location <Git 克隆后的项目目录>
npm ci
npm run postgres:setup
npm run start:intranet
```

主库是本机 PostgreSQL（`DATABASE_URL`）。从旧 SQLite 迁库：`npm run db:migrate-pg`。旧 `rag.sqlite` 只作备份。

默认以**开发服务器**启动（拆分架构），并自动拉起 OpenCode sidecar、API、Worker。  
浏览器打开 `http://localhost:3000`。模型（含图像）与数据根目录在「设置」页配置，写入 `storage/settings.json`。

### 拆分架构（Web / API / Worker）

| 进程 | 端口 | 说明 |
|------|------|------|
| Web (Next) | 3000 | 仅 UI；`AI4ES_SPLIT=1` 时把 `/api/*` 反代到 API |
| API (Hono) | 4000 | 挂载原 `src/app/api/**/route.ts`；`AI4ES_USE_JOB_QUEUE=1` |
| Worker | — | 消费 `background_jobs` 队列（导入 / 重建 / 专利等重活） |
| OpenCode | 4097 | 既有 sidecar |

单独启动：

```powershell
npm run api:dev      # 或 api:start
npm run worker:dev   # 或 worker:start
$env:AI4ES_SPLIT='1'; npm run dev
```

PM2（需本机已装 `pm2`）：`npm run pm2:start` / `npm run pm2:stop`。

不拆分、单进程 Next（脚本调试）时不要设 `AI4ES_SPLIT`，API 仍由 Next 自带路由处理。

### 开发 / 生产模式

| 命令 | 模式 | 说明 |
|------|------|------|
| `npm run start:intranet` | 开发（默认） | `next dev`，热更新，日常改代码用这个 |
| `npm run start:intranet:prod` | 生产 | 需先 `npm run build`，再 `next start` |
| `$env:AI4ES_MODE='prod'; npm run start:intranet` | 生产 | 与上一行等价 |

> 旧逻辑：只要存在 `.next` 就走生产。现已取消，避免改完代码却仍跑运营包、看不到热更新。

## Git 同步与内网自动部署

仓库中的源码、`.opencode/agents`、`.opencode/skills`、MCP 桥接、ESOPT/HiGHS/TDMG/SES-IESP 求解代码与所需运行文件全部使用项目相对定位。虚拟环境、`node_modules`、运行日志、数据库、语料和密钥不提交；部署脚本会在克隆目录内创建运行环境。

首次部署：

```powershell
git clone <内网 Git 仓库地址> ai4es
Set-Location .\ai4es
Copy-Item .env.example .env.local
# 填写 DATABASE_URL、DEFAULT_ADMIN_PASSWORD 和所需的内网模型/服务配置
npm run deploy:intranet -- -SkipGitPull
```

后续更新：

```powershell
Set-Location .\ai4es
npm run deploy:intranet
```

部署命令依次执行 `git pull --ff-only`、`npm ci`、项目内运行时安装、PostgreSQL 检查、生产构建、便携审计和整套服务启动。服务器已有 Python 环境时可用 `-SkipPython`，只验收不启动可用 `-NoStart`。目标机无法访问公网时，先在可联网机器执行 `npm run pack:intranet`，再复制生成的完整便携目录。

生产构建默认只编译 Web 页面与 `/healthz`；98 个 `/api/*` 路由由独立 Hono API 进程承载，并通过 Next `beforeFiles` rewrite 转发，避免重复打包导致的内存膨胀。默认 Node 堆为 8 GB，可用 `AI4ES_BUILD_MEMORY_MB` 调整；只有需要 Next 单进程 API 时才设置 `AI4ES_BUILD_ALL_ROUTES=1`。

## 内网便携（拷贝开箱即用）

要求：Windows x64、已安装 Node.js 20+、能访问在 `.env.local` 或设置页配置的内网模型（示例值见 `.env.example`，不要在代码中固化服务器地址）。

**打包机**（可访问 npm / GitHub 一次）：

```powershell
npm run pack:intranet
```

生成目录在 `dist\能元-AI4ES-内网便携-*`（含 `node_modules`、`tools\opencode`、`tools\ripgrep`、语料）。需要 zip 时加：`npm run pack:intranet -- -Zip`。

**目标机**：拷贝该文件夹后执行：

```powershell
npm run start:intranet
```

本机打开 `http://localhost:3000`；同事在同一局域网用脚本打印的地址（如 `http://本机IP:3000`）。停止：终端 `Ctrl+C`，再执行 `npm run opencode:stop`。

交付给不改代码的同事时，可先在打包机 `npm run build`，目标机用 `npm run start:intranet:prod`。

更换模型：设置页（写入 `storage/settings.json`）后重新 `start:intranet`。默认数据根为项目内 `数据/`。

## 数据目录约定

`DATA_ROOT_DIR`（默认见设置中的 `dataRootDir`，未配置时为项目内 `数据/`）指向：

```text
数据/                         # 原始资料（与解析产物隔离）
├─ 论文信息/
│  ├─ pdf/
│  └─ caj/
├─ 专利信息/
├─ 导师信息/
├─ 书籍/
└─ 基金信息/                  # 基金 CSV 等源文件

storage/
├─ parsed/                    # 可读文件名（与 数据/ 隔离；英文目录）
│  ├─ funds/
│  └─ books/
└─ knowledge-corpus/          # Agent 只读此处 Markdown（hash 文件名），不查库读正文
   ├─ projects/
   ├─ papers/
   ├─ patents/
   ├─ books/
   └─ people/
```

- 磁盘导入：数据页「导入磁盘资料」→ `POST /api/data-import`
- Excel/CSV 导入：数据页「导入表格」→ `POST /api/ingest`（扫描项目根、`数据/`、`知识问答/`）
- 便携包：数据页 Ragpack 面板，或 `npm run ragpack:export` / `ragpack:import`

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm run start:intranet` | 开发：OpenCode + API + Worker + `next dev` |
| `npm run start:intranet:prod` | 生产：同上，Web 用 `next start`（需先 build） |
| `npm run api:dev` / `worker:dev` | 单独启动 API / Worker |
| `npm run pm2:start` / `pm2:stop` | PM2 托管 api/worker/web |
| `npm run pack:intranet` | 打内网便携整包 |
| `npm run portable:install` / `portable:audit` | 创建项目内运行时 / 审计绝对路径和关键资产 |
| `npm run deploy:intranet` | Git 拉取、安装、构建、审计并启动生产服务 |
| `npm run opencode:start` / `stop` | 单独启停 OpenCode sidecar |
| `Test-Path .opencode\skills\paper-reproduce\SKILL.md` | 验证随 Git 同步的项目内论文复现 Skill |
| `npm run import:readonly` | 只读探测磁盘导入 |
| `npm run typecheck` | TypeScript 检查 |

## 说明

- 论文下载子系统已移除；论文源文件仅保留 `数据/论文/{pdf,caj}`。
- 模型 API Key（含图像）放在 `storage/settings.json`；分发前请自行脱敏，勿把密钥提交到公开仓库。
