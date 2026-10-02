# 能元（AI4ES）迁移部署

现有服务器的恢复操作优先遵循 `docs/recovery-deployment.md`；本文保留新机器的部署参考。人工或 Agent 按章节从上到下执行，一步失败就停在该步，修好再继续。不要跳过验收。数据、密钥和商业许可证不在 Git 里，缺了它们时对应功能会失败，其余服务仍应能启动。

仓库：`https://github.com/liangjiabin0/nengyuan-recovery-merged.git`。克隆后的目录就是项目根。下面的命令都在项目根执行。

## 0. 不要提交、不要覆盖

这些目录由本机生成或属于数据，不要 `git add`：

| 路径 | 原因 |
| --- | --- |
| `node_modules/`、`.next/`、`tools/*-venv/` | `npm ci` 和 `pip install` 重建 |
| `tools/opencode/`、`tools/ripgrep/` | GitHub Releases 下载 |
| `tools/libreoffice/`、`tools/mupdf/`、`tools/poppler/` | 官网或 GitHub 下载 |
| `tools/tdmg-acopf-dispatch/scripts/_vendor/` | 与 `tools/tdmg-acopf-dispatch/requirements.txt` 相同的 PyPI 包，装进 `tools/tdmg-venv` 即可 |
| `storage/`、`数据/`、`dist/`、`output/`、`deliverables/` | 运行数据、语料、便携包、临时产物 |
| `.env.local`、`storage/settings.json`、`tools/mgplan/scripts/openTEPES.mapbox_token`、`gurobi.lic` | 密钥和许可证 |

以下非 Git 资源需从可信旧部署恢复（可使用 `scripts/restore-runtime-assets.py`）：`tools/esopt/work/DCOPF/build/` 下的 `esoptc.exe`、`dc_opf.exe`、HiGHS 与 MinGW DLL；`tools/ses-iesp-esopt/build/openTEPES_esopt.exe` 及同目录 DLL；风电预测权重 `tools/pv-wind-load-forecast/wind/wind-power-forcast-kaggle/weights/*.hdf5`。光伏 / 负荷 / 电量的 `weights/**/*.keras` 不入库，预测时若没有匹配权重会现场训练。

## 1. 基础软件

Windows x64，管理员 PowerShell，装完重开终端：

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Python.Python.3.12 -e
winget install --id Git.Git -e
winget install --id OpenModelica.OpenModelica.Official -e
winget install --id PostgreSQL.PostgreSQL.17 -e
```

验收必须看到版本号，Python 必须是 3.12 x64，不要用 3.13 建项目虚拟环境：

```powershell
node --version
npm --version
python --version
git --version
omc --version
```

`better-sqlite3` 若没有预编译包，再装 Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”。PPT 语音的 COM 自动化需要本机已安装的 Microsoft PowerPoint。

Ubuntu 用 `scripts/linux/bootstrap.sh`（需要 sudo）。它安装编译工具、Python venv、ripgrep、poppler、mupdf-tools、LibreOffice、中文字体、ffmpeg、tmux，并创建 PostgreSQL 角色 `ai4es` / 库 `ai4es`。角色已存在时不重置密码；新角色必须显式提供至少12位 `AI4ES_DB_PASSWORD`，并写入 `.env.local`。OpenModelica 另执行 `scripts/linux/install-openmodelica.sh`。

## 2. 克隆与环境文件

```powershell
git clone https://github.com/liangjiabin0/nengyuan-recovery-merged.git ai4es
Set-Location .\ai4es
Copy-Item .env.example .env.local
```

编辑 `.env.local`，至少填这两项，密码做 URL 编码：

```text
DATABASE_URL=postgres://ai4es:<url-encoded-password>@127.0.0.1:5432/ai4es
DEFAULT_ADMIN_PASSWORD=<至少 12 位，仅首次建管理员时使用>
```

模型地址沿用 `.env.example` 里的 `LLM_BASE_URL` / `LLM_MODEL`，或改成这台机器能访问的 OpenAI 兼容 `/v1`。`LLM_API_KEY`、`MAPBOX_TOKEN`、`GRB_LICENSE_FILE`、`WLSSECRET`、`DASHSCOPE_API_KEY` 没有就留空。不要把填好的 `.env.local` 提交。

## 3. PostgreSQL

在 `psql -U postgres` 中：

```sql
CREATE ROLE ai4es LOGIN PASSWORD '<与 DATABASE_URL 相同的明文密码>';
CREATE DATABASE ai4es OWNER ai4es;
```

然后：

```powershell
Test-NetConnection 127.0.0.1 -Port 5432
npm run postgres:check
```

端口必须通，`postgres:check` 必须能用 `DATABASE_URL` 登录。应用第一次连上会自己建表。已有库的业务数据用主人提供的备份恢复，不要用仓库里的空库冒充。

## 4. 安装项目内运行时

需要能访问 npm、`cdn.sheetjs.com`（锁文件里的 `xlsx` 包）、PyPI、GitHub Releases、mupdf.com、LibreOffice 镜像。

```powershell
npm ci
npm run portable:install
```

`portable:install` 依次做这些事，不要拆开漏项：

1. `npm ci`（部署脚本会再跑一次；单独跑 portable 时已包含）
2. 下载 OpenCode 与 ripgrep 到 `tools/opencode`、`tools/ripgrep`
3. 用 Python 3.12 创建并安装这些虚拟环境：`esopt-venv`、`tdmg-venv`、`pdf2md-venv`、`caj2pdf-venv`、`power-dispatch-venv`、`nwxs-loss-venv`、`forecast-venv`、`ppt-voice-venv`、`mgplan-venv`、`openmodelica-gateway-venv`、`markitdown-venv`、`office-docs-venv`
4. 解压便携 LibreOffice 到 `tools/libreoffice`
5. 下载 MuPDF 到 `tools/mupdf/mutool.exe`
6. 下载 Poppler，使 `pdftoppm.exe` 位于 `tools/poppler`
7. 若还没有语料，写入空的 `storage/knowledge-corpus/MANIFEST.md`

Linux 对应 `bash scripts/linux/install-runtime.sh`。OpenCode Linux 二进制由 `bash scripts/linux/opencode-sidecar.sh install` 从 GitHub 下载。`mutool` / `pdftoppm` / LibreOffice 用系统包，见 `scripts/linux/bootstrap.sh`。

没有公网时，在一台能联网的 Windows 上执行 `npm run pack:intranet`，把生成的 `dist\能元-AI4ES-内网便携-*` 整目录拷走，目标机只跑 `npm run start:intranet`。

## 5. 启动

开发（改代码）：

```powershell
npm run start:intranet
```

生产（先构建）：

```powershell
npm run build
npm run start:intranet:prod
```

浏览器打开 `http://localhost:3000`。局域网用脚本打印的本机 IP。停止：终端 `Ctrl+C`，再执行 `npm run opencode:stop`。

进程与端口：Web `3000`，API `4000`，OpenCode `4097`，LLM gateway `4098`，OpenModelica gateway `18088`。

已有 `.env.local` 且 PostgreSQL 已就绪时，也可以：

```powershell
npm run deploy:intranet -- -SkipGitPull
```

该命令会 `npm ci`、`portable:install`、检查 PostgreSQL、`npm run build`、`npm run portable:audit`，然后以生产模式启动。

## 6. 验收

下面每条都要实际执行。健康检查通过不等于求解通过。

```powershell
npm run opencode:status
npm run compute:status
npm run mgplan:status
npm run modelica:status
npm run ppt-voice:status
Test-Path .opencode\skills\paper-reproduce\SKILL.md
Test-Path tools\mupdf\mutool.exe
Test-Path tools\esopt\work\DCOPF\build\esoptc.exe
Test-Path storage\knowledge-corpus\MANIFEST.md
npm run test:power-compute
npm run test:scheme-solvers
npm run typecheck
```

通过标准：

- `opencode:status` 里 sidecar 与 gateway 为健康。
- `compute:status` 中调度的 Pandapower/Pyomo/HiGHS、线损引擎、预测的 sklearn 为真。Keras/TensorFlow 为真才算深度预测就绪；为假时预测会退回统计模型，要在记录里写明。
- `test:scheme-solvers` 里 ESOPT 的 DCOPF、LP、MIP 以及 TDMG 的 IEEE9 快照和多时段 scenario 必须是 `live: true`。
- MGPlan 在没有正式 Gurobi 许可证时允许失败。`gurobiFullLicense` 不是 `true` 就保持“未完成”，不要把 pip 自带的受限许可当成通过。
- `modelica:status` 要有 `ok: true` 和 `ompython: true`。只有 `/health` 不算仿真完成。
- 文档预览：`npm run test:office-docs` 与 `npm run test:build-docx`。没有 LibreOffice 时 Windows 可退回 Office COM；Excel 公式重算只认 LibreOffice。

导入论文、专利、书籍、基金之后执行 `npm run corpus:export`，用导出的 `MANIFEST.md` 替换空占位。空占位只能让对话进程启动，不能当成已有知识库。

## 7. 缺了外部条件时会怎样

| 缺什么 | 结果 | 能否放进 Git |
| --- | --- | --- |
| Gurobi 正式 / 学术 / WLS 许可 | MGPlan 的 sSEP 不能标完成 | 否 |
| LLM 端点或 Key | 对话没有模型 | 否，写 `.env.local` 或设置页 |
| DashScope / 百炼 | PPT 语音合成不可用 | 否 |
| Mapbox token | openTEPES 网络地图不可用 | 否 |
| Microsoft PowerPoint | PPT 语音 COM 与 Office 回退渲染不可用 | 否 |
| `数据/` 与数据库备份 | 检索没有业务内容 | 否，数据不入库 |
| OpenModelica | 仿真网关起不来 | 否，用 winget / apt 安装 |

详细的组件状态和历史验收记录见 `SYSTEM_DEPENDENCIES.md`。
