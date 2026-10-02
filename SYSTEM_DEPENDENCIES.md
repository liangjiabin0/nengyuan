# 能元系统依赖状态与新电脑复现清单

最后核对：2026-09-24。新机器的操作顺序以 [DEPLOY.md](DEPLOY.md) 为准，本文保留组件状态和不能自动生成的外部条件。

执行者必须逐项安装、逐项运行验收命令，并如实保留失败项；健康探针、样例输出或缓存结果不能代替真实求解测试。

## 1. 当前机器状态

| 组件 | 当前状态 | 实测结果或阻塞 |
| --- | --- | --- |
| Node.js / npm | 完成 | Node `v24.18.0`，npm `11.16.0` |
| Python | 完成 | Python `3.12.10` x64 |
| Git / ripgrep | 完成 | Git `2.55.0.windows.3`，ripgrep `15.2.0` |
| 项目 Node 依赖 | 完成 | 已补入源码直接依赖的 `pg 8.23.0` 与 `@types/pg 8.23.1` |
| OpenCode sidecar | 完成 | `1.18.2`，OpenCode `4097` 与 LLM gateway `4098` 健康 |
| 论文复现 skill | 完成 | `paper-reproduce` 已安装，7 个 reference 文件 |
| ESOPT | 完成 | DCOPF、LP、MIP 均为真实求解，非 fixture |
| TDMG AC-OPF | 完成 | IEEE9 快照与多时段 scenario 真实求解成功 |
| 调度 / 线损 / 预测 | 完成 | 三类 sidecar 健康，完整 `test:power-compute` 通过 |
| OpenModelica | 完成 | OpenModelica `1.26.3`、MSL `4.1.0`；BatterySOC 返回 `time` 与 `SOC` 时序 |
| MGPlan / openTEPES | 部分完成 | Python、openTEPES、PyOptInterface、Gurobi `13.0.2` 已安装；缺少可供 PyOptInterface 使用的正式/学术/WLS Gurobi 许可证 |
| PostgreSQL | 完成 | `postgres://ai4es:***@127.0.0.1:5432/ai4es` 实际连接通过 |
| PPT 语音 | 部分完成 | Python 包、`python-pptx`、PowerPoint COM 正常；百炼/DashScope API key 未配置 |
| LLM / SearXNG | 外部服务 | 必须提供可达的小模型端点；大模型端点可选；SearXNG 按部署环境配置 |
| 原始数据与语料 | 外部数据 | `数据/`、PostgreSQL 数据、`storage/knowledge-corpus` 需要迁移或重新导入，不能从代码仓库生成 |

## 2. 不能由 AI 自动生成的内容

以下内容必须由系统所有者提供。任何 AI 都不能伪造、绕过或把样例结果当成这些内容已经可用：

- Gurobi 正式、学术、WLS 或有效 ISV 许可证。
- ESOPT/HiGHS 的桥接、SDK、8 个 DCOPF 算例和 Windows x64 运行文件已位于 `tools/esopt`；若改用受许可的商业求解器，许可证仍由系统所有者提供。
- LLM、DashScope/百炼、Mapbox 等 API key 和 WLS secret。
- PostgreSQL 管理员密码、应用数据库密码和已有业务数据备份。
- 论文、专利、书籍、导师、基金等原始资料和知识语料。
- Microsoft PowerPoint/Office 的合法安装。

所有密钥只放在新电脑的 `.env.local`、`storage/settings.json`、Windows 凭据或许可证文件中。不要写入本文档、`.env.example`、Git 提交、日志或聊天回复。

## 3. 新电脑安装顺序

### 3.1 基础软件

在管理员 PowerShell 中安装；安装完成后重新打开终端：

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Python.Python.3.12 -e
winget install --id Git.Git -e
winget install --id OpenModelica.OpenModelica.Official -e
winget install --id PostgreSQL.PostgreSQL.17 -e
```

PPT 语音还要求 Microsoft PowerPoint。若 npm 原生模块没有匹配的预编译包，再安装 Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”，不要预先把它当成所有机器的硬性要求。

基础验收：

```powershell
node --version
npm --version
python --version
git --version
omc --version
```

推荐基线是 Node 24、Python 3.12 x64、Git 2.55+、OpenModelica 1.26.3 或已验证的兼容新版。不要用 Python 3.13 替代项目的 3.12 虚拟环境。

### 3.2 项目与项目内运行时

进入项目根目录后执行：

```powershell
npm ci
Copy-Item .env.example .env.local
npm run portable:install
```

`npm ci` 必须成功并执行项目 `postinstall`。不要使用 `npm audit fix --force` 自动升级主版本；先审计再单独处理。

### 3.3 PostgreSQL

源码通过 `DATABASE_URL` 使用 PostgreSQL，不再以 `DATABASE_PATH` 的 SQLite 文件作为主库。创建登录角色和 `ai4es` 数据库，例如在 `psql -U postgres` 中执行：

```sql
CREATE ROLE ai4es LOGIN PASSWORD '<由系统所有者生成的强密码>';
CREATE DATABASE ai4es OWNER ai4es;
```

在 `.env.local` 配置 URL 编码后的密码：

```text
DATABASE_URL=postgres://ai4es:<url-encoded-password>@127.0.0.1:5432/ai4es
PG_POOL_MAX=12
```

验收端口并启动应用；应用首次连接会自动应用 schema：

```powershell
Test-NetConnection 127.0.0.1 -Port 5432
npm run start:intranet
```

### 3.4 OpenCode、ripgrep 与论文复现 Skill

需要访问 GitHub：

```powershell
npm run opencode:install
npm run opencode:status
Test-Path .opencode\skills\paper-reproduce\SKILL.md
```

`paper-reproduce` 已在 `.opencode/skills/paper-reproduce` 中随 Git 同步，不再从用户目录安装或使用机器绝对路径。`npm run portable:install` 和启动脚本会在缺少语料时写入空的 `storage/knowledge-corpus/MANIFEST.md`，只为让 OpenCode 能启动。有数据库内容后必须运行 `npm run corpus:export` 覆盖它。

### 3.5 调度、线损和预测 sidecar

这些命令分别创建项目内 Python 3.12 虚拟环境：

```powershell
npm run dispatch:install
npm run loss:install
npm run forecast:install
npm run compute:status
```

健康结果必须明确显示：调度的 Pandapower/Pyomo/HiGHS、线损引擎，以及预测的 sklearn/Keras/TensorFlow 均为 `true`。

### 3.6 MGPlan / openTEPES / Gurobi

先安装软件依赖：

```powershell
npm run mgplan:install
npm run mgplan:status
npx tsx scripts/test-mgplan.ts
```

项目优先使用 `tools/mgplan-venv/Scripts/python.exe`。完整 sSEP 使用 `pyoptinterface.gurobi` 的原生 Gurobi 接口；pip 自带的受限许可证只允许 `gurobipy`，因此出现以下错误时不能标记为完成：

```text
PIP license can only be used from gurobipy interface
```

从 Gurobi 官方取得合法许可证后，使用以下方式之一配置：

- 将 `gurobi.lic` 放在 Gurobi 默认许可位置，或用 `GRB_LICENSE_FILE` 指向它。
- 在本机环境中设置 `WLSACCESSID`、`WLSSECRET`、`LICENSEID`。
- 只有确实持有厂商 ISV 许可时，才设置 `MGPLAN_GUROBI_ISV_*`；普通学术/商业/WLS 许可保持这些变量为空。

许可证验收必须同时满足：

```powershell
npm run mgplan:status
$env:RUN_MGPLAN_INTEGRATION_TESTS='1'
npx tsx scripts/test-mgplan.ts
```

只有状态中 `gurobiFullLicense: true` 且真实 sSEP 集成测试成功，MGPlan 才能从“部分完成”改成“完成”。

### 3.7 OpenModelica 网关

OpenModelica 桌面软件与 Python 网关是两层依赖：

```powershell
npm run modelica:install
npm run modelica:start
npm run modelica:status
npm run test:power-compute
```

`modelica:status` 必须返回 `ok: true`、`ompython: true` 和 MSL 版本。完整测试还必须打印 `modelica [ 'time', 'SOC' ]`；只有 `/health` 成功不算仿真完成。日志位于 `storage/openmodelica-gateway.out.log` 与 `storage/openmodelica-gateway.err.log`。

### 3.8 ESOPT MCP

ESOPT 已收拢到项目内，默认配置如下，通常无需在 `.env.local` 重复填写：

```text
ESOPT_ROOT=tools/esopt
ESOPT_BRIDGE=tools/esopt/esopt_bridge
ESOPT_NATIVE_ROOT=tools/esopt
ESOPT_PYTHON=
ESOPT_MCP_LAUNCHER=
```

空的 Python 与启动器设置会自动解析到 `tools/esopt-venv/Scripts/python.exe` 和 `scripts/esopt-mcp.cmd`。安装并重启 OpenCode 后验收：

```powershell
npm run opencode:restart
npx tsx scripts/test-esopt-mps.ts
npm run test:scheme-solvers
```

验收必须包含 ESOPT DCOPF、LP、MIP 的 `live: true`，不能只验证 MCP 进程存在。

### 3.9 TDMG AC-OPF

TDMG 源码和要求文件位于项目内；`npm run portable:install` 会把固定兼容版本安装到 `tools/tdmg-venv`。如需单独恢复：

```powershell
python -m venv tools\tdmg-venv
tools\tdmg-venv\Scripts\python.exe -m pip install -r tools\tdmg-acopf-dispatch\requirements.txt
```

可在 `.env.local` 设置 `TDMG_PYTHON`，否则运行时使用 `tools/tdmg-venv`。使用 `npm run test:scheme-solvers` 验收 IEEE9 快照和多时段 scenario 均为 `live: true`。

### 3.10 PDF、CAJ、PPT 与语音

论文解析和 PPT 语音环境可由 `npm run portable:install` 统一创建；也可按下列方式单独恢复：

```powershell
python -m venv tools\pdf2md-venv
tools\pdf2md-venv\Scripts\python.exe -m pip install -r tools\pdf2md\requirements.txt
python -m venv tools\caj2pdf-venv
tools\caj2pdf-venv\Scripts\python.exe -m pip install -r tools\caj2pdf-fresh\caj2pdf-master\requirements.txt
npm run ppt-voice:install
npm run ppt-voice:status
```

`npm run portable:install` 会下载这些公网程序（也可单独执行脚本）：

- `scripts/install-mupdf.ps1`：官方 Windows 包，落到 `tools/mupdf/mutool.exe`。CAJ 转换调用 `mutool`。Linux 用系统包 `mupdf-tools`。
- `scripts/install-poppler.ps1`：Poppler Windows 版，`pdftoppm.exe` 在 `tools/poppler`。启动脚本会把它加进 PATH。也可以在 `.env.local` 设置 `PDFTOPPM_PATH`。Linux 用 `poppler-utils`。
- Microsoft PowerPoint，供 PPT 语音的 COM 自动化使用。
- `DASHSCOPE_API_KEY`、`BAILIAN_WORKSPACE_ID`、`BAILIAN_BASE_URL`，用于真实语音合成。

### 3.11 LLM、搜索与数据

至少配置一套可达的小模型 OpenAI-compatible 端点：

```text
LLM_BASE_URL=<小模型 /v1 地址>
LLM_MODEL=<小模型 ID>
LLM_API_KEY=<如端点要求>
LLM_THINK=0
```

`LLM_LARGE_*` 是可选外部大模型配置，不应成为基础部署的强依赖。导师联网检索另需 `SEARXNG_BASE_URL`。模型设置也可能保存在 `storage/settings.json`，迁移时必须脱敏检查。

需要迁移或重建的状态数据包括：

- `数据/` 原始资料目录。
- PostgreSQL 数据库备份。
- `storage/knowledge-corpus/` 只读 Markdown 语料及 `MANIFEST.md`。
- 必要的 `storage/settings.json`，迁移前移除旧机器密钥和绝对路径。

### 3.12 Word / Excel / CSV / PDF / PPTX 生成

智能对话要交付 Word、Excel、CSV、PDF 或普通 PPTX 时，加载内置 `docx` / `xlsx` / `pdf` / `pptx` 技能（Anthropic 官方 document-skills + `ai4es.md`）。Word 报告由模型写 Markdown，再用 `tools/docx/scripts/build_docx.py` 经 pandoc 套 `tools/docx/assets/cn-tech-report.docx`（或用户模板）生成，禁止手写 `word/document.xml`。不要把 Markdown 改后缀交差。公式变量用 Times New Roman 斜体。

`tools/office-docs-venv` 只给这些官方技能的 Python 库（`python-docx`、`pypandoc_binary`（自带 pandoc）、`openpyxl`、`pandas`、`reportlab`、`pypdf`、`pypdfium2`、`lxml`、`defusedxml` 等）和校验脚本用；`tools/office-docs/` 只剩建 venv 的 `run.py`、`requirements.txt` 和校验器自测 `selftest_ooxml.py`。`defusedxml` 缺失会让 `scripts/office/validate.py` 直接 import 失败，必须装上。

页面预览（`scripts/office/render.py`）和 Excel 重算（`recalc.py`）优先用 `tools/libreoffice` 里的便携 LibreOffice：Windows 由 `scripts/install-libreoffice.ps1` 解压（`install-portable-runtime.ps1` 会自动调用），Linux 服务器用系统包安装 `libreoffice-writer libreoffice-impress libreoffice-calc` 和中文字体。

```powershell
npm run office-docs:install
npx tsx scripts/test-office-docs.ts
npm run test:build-docx
```

`tools/{docx,xlsx,pptx}/scripts/office` 下四个脚本在 Windows 和 Linux 上命令完全相同，测试会校验三份副本逐字节一致：

| 脚本 | 用途 | 是否需要外部程序 |
| --- | --- | --- |
| `preflight.py` | 结构预检，判断 Word/Excel/PowerPoint 能否打开；退出码 1 = 打不开 | 不需要 |
| `validate.py` | XSD 与修订校验 | 不需要（要 `lxml`、`defusedxml`） |
| `package.py` | 解包、打包、替换部件、查孤立部件 | 不需要 |
| `render.py` | 转 PDF 与页图预览，全程带超时 | LibreOffice 或 Windows Office，缺则退出码 3 |

渲染引擎按 LibreOffice → Windows Office COM 顺序回退。LibreOffice 从 `AI4ES_SOFFICE`、`SOFFICE_PATH`、`PATH` 和常见安装目录解析，Windows 上优先用 `soffice.com`；没有 LibreOffice 时，Word/Excel/PowerPoint COM 由 `render.py` 在子进程里驱动并在超时后连带清理自己启动的 Office 进程。本机当前无 LibreOffice，走 Office COM 通路，`render.py --probe` 会如实报出来。

Excel 公式重算（`scripts/recalc.py`）只能用 LibreOffice，没有就必须在答复里说明未重算。PDF 页图依赖 `pdftoppm` 或 `PDFTOPPM_PATH`（本机由 MiKTeX 提供）。中文排版依赖本机宋体、黑体、微软雅黑、仿宋、Times New Roman。

`scripts/project-env.ps1` 与 `scripts/linux/common.sh` 统一设置 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`，避免中文 Windows 上子进程按 cp936 输出、Agent 读到乱码报错。

## 4. 最终验收

依赖全部落位后依次执行：

```powershell
npm run opencode:status
npm run compute:status
npm run mgplan:status
npm run modelica:status
Test-Path .opencode\skills\paper-reproduce\SKILL.md
npm run ppt-voice:status
npm run office-docs:install
npm run test:office-docs
npm run test:power-compute
npm run test:scheme-solvers
npm run typecheck
npm run build
```

验收记录至少要包含命令、时间、退出码、真实/fixture 标记和失败原因。`test:scheme-solvers` 当前允许把 MGPlan 许可证阻塞记录在报告中而整体退出 0，所以不能只看进程退出码；还必须检查 `failCount`、每行 `live` 和 MGPlan 的 `gurobiFullLicense`。

## 5. 当前待办边界

截至 2026-09-04：

1. OpenModelica 环境已补齐，Windows PowerShell 5.1 启动兼容问题已修复，真实 BatterySOC 仿真通过。
2. MGPlan 软件依赖已补齐，失效的硬编码 ISV key 已移除；唯一的求解阻塞是外部 Gurobi 原生许可证。
3. PostgreSQL 当前机器连接通过；新服务器仍需创建数据库、应用角色并恢复业务备份。
4. PPT 语音缺少外部 DashScope/百炼凭据。
5. 新电脑无需再迁移 ESOPT 或 TDMG 代码；仍需恢复业务数据库、原始数据和知识语料，并提供外部许可证与密钥。
6. 迁移验收中 ESOPT DCOPF/LP/MIP、TDMG 两类 AC-OPF、调度、线损、预测、OpenModelica 均真实通过；另用项目内 `tools/ses-iesp-esopt/run.cmd` 完成 case6 的 59.6 万约束、136.6 万变量求解。Python MGPlan 仍按其独立许可证探针标记为受限。
