# 能元 Word 约定

官方 `SKILL.md` 里的通用知识仍然有效；**用什么方式生成 Word 以本文件为准**。会话工作目录不是仓库根。

## 先选路线

| 任务 | 做法 |
|---|---|
| 技术报告、研究报告、规划报告、方案、说明书，以及任何含公式、表格、图的中文文档 | 写 Markdown，用 `scripts/build_docx.py` 生成（pandoc 转换） |
| 用户给了 Word 模板，要“按这个模板出报告” | 同上，加 `--template 用户模板.docx` |
| 修改用户已有的 Word（改几段文字、替换表内数据） | python-docx 打开原文件，用它的段落/表格 API 修改后另存 |
| Markdown 表达不了的特殊版式（公文红头、信函、表单） | docx-js 脚本（官方 SKILL.md 的 Create 分支） |

**禁止手写 `word/document.xml`，禁止用 ElementTree、正则或字符串拼接生成正文 XML。** 以往反复修几十分钟的“Word 提示文件已损坏”、公式属性顺序错、`mc:Ignorable` 命名空间丢失、目录空白，全部出自手写 XML。

## 用 build_docx.py 生成报告

1. 先读完整示例 `assets/report-example.md`（封面、摘要、目录、编号公式、三线表、图都有），照它的写法把全部内容写成一个 Markdown 文件。Markdown 和图片放在工作区里（不要放进 `deliverables/`）。
2. 运行（Windows）：

   ```powershell
   & "$env:AI4ES_PROJECT_ROOT\tools\office-docs-venv\Scripts\python.exe" "$env:AI4ES_PROJECT_ROOT\tools\docx\scripts\build_docx.py" report.md -o "deliverables\报告.docx"
   ```

   Linux：`"$AI4ES_PROJECT_ROOT/tools/office-docs-venv/bin/python" "$AI4ES_PROJECT_ROOT/tools/docx/scripts/build_docx.py" report.md -o deliverables/报告.docx`
3. 看它输出的 JSON：`"ok": true` 表示 preflight、validate、deliverable_check 三项全过且公式在 PDF 里没丢。`render.pages.files` 是逐页图片（在 Markdown 同目录的 `_preview/`），用 read 逐页看一遍版面。
4. 发现问题就改 Markdown 再跑一次。不要打开 docx 去改 XML。

脚本做的事：pandoc 把 Markdown 转成合法的 docx（原生 Word 公式、真表格、图题表题），套用模板的样式、页眉页脚和页边距；然后统一处理三线表和列宽、公式编号、封面与摘要分页、带页码的目录，最后渲染并检查。

### Markdown 写法

- 开头 YAML：`title`/`subtitle`/`author`/`date` 生成封面，`abstract` 生成摘要页，`toc: true` 生成带页码的目录，`header` 是页眉文字；页码自动加。
- 标题写 `# 1 引言`、`## 1.1 研究边界`，编号自己写。
- 段落之间空一行，不要手动缩进，首行缩进由样式负责。
- 行内公式 `$...$`，独立公式单独成段写 `$$...$$`，自动编号 (1)(2)…。多行公式用 `\begin{aligned}`；很长的模型必须分行，单行不要超出版心。公式外不要写 LaTeX 命令。
- 表格用管道表，表题写在表格正上方一行：`: 表1 算例参数`。自动转三线表并按内容分配列宽；单元格内不要换行。
- 图：`![图1 系统结构](fig1.png){width=80%}`，方括号里的文字就是图题（在图下方）。
- `**加粗**`、列表等 Markdown 语法会被正确转换，不会残留在 Word 里。不要写 HTML。
- 中文引号直接打“”。
- 参考文献写成普通段落：`[1] 作者. 题名[J]. 期刊, 年份. DOI: …`。

### 模板与纸张

默认模板 `assets/cn-tech-report.docx`（正文仿宋/Times New Roman，标题黑体），纸张默认 A4。用户模板用 `--template`，沿用其样式、页眉页脚和页边距；要保留模板自身的纸张大小，在 YAML 写 `papersize: template`。模板标题的自动编号会被去掉，编号以 Markdown 里写的为准。

## 路径与依赖

- 禁止 `npm install`、`pip install`、`python -m venv`、`Test-Path` 探路。
- Python 一律用 `$env:AI4ES_PROJECT_ROOT\tools\office-docs-venv\Scripts\python.exe`（Linux：`tools/office-docs-venv/bin/python`）。其中已有 python-docx、pandoc（pypandoc_binary）、pypdf、pypdfium2、openpyxl。
- Node（仅 docx-js 路线）：`$env:NODE_PATH="$env:AI4ES_PROJECT_ROOT\node_modules"`，然后 `require('docx')`。
- 读用户上传的已有 Word 用 `markitdown`。
- 成品写入 `deliverables/`，并在 `deliverables/manifest.json` 用 `file` 和 `title` 登记。

## 非 build_docx 路线交付前必须跑的三步

python-docx 修改或 docx-js 生成的文件，自己依次跑（build_docx.py 已自动跑过）：

1. `scripts/office/preflight.py 成品.docx`：退出码 1 表示 Word 会拒绝打开，报告里写了原因。
2. `scripts/office/validate.py 成品.docx`：XSD 校验。
3. `scripts/office/deliverable_check.py 成品.docx`：交付合规闸门，退出码 1 不能交。

## 交付文件禁止出现系统内部引用

成品正文不得出现语料路径（`knowledge-corpus/...`）、文件行号（`....md：120-180`）、`[E1]`/`[L2]` 角标、会话工作区路径、盘符或服务器绝对路径、仓库目录（`repro/`、`storage/`、`tools/`、`deliverables/`）和 `opencode`、`knowledge-qa`、`AI4ES_PROJECT_ROOT` 这类运行时名称。

`[knowledge-corpus/papers/….md:10-15]` 这种写法只用于对话回答；交付文件按学术规范写：正文编号角标，文末参考文献写作者、标题、期刊/专利号、年份、DOI 或 URL。

## 版面预览：只用 render.py

`scripts/office/render.py 成品.docx --pdf 构建目录/preview.pdf --pages --dpi 100 --json`。项目自带便携 LibreOffice（`tools/libreoffice`），Windows 上还可退到 Office COM，全程带超时。对 `deliverables/` 里的成品预览时必须用 `--pdf` 指向构建目录。

- `math.status` 为 `missing`（退出码 5）表示这份 PDF 丢了公式，不能交；为 `review` 时只是个别公式在 PDF 文本层里抽不出来，去页图上看一眼即可，**不要为了过检查去改写公式**。
- 退出码 3 = 本机没有任何渲染器，在答复里写明“未看页图”后继续交付。退出码 4 = 渲染超时。
- 禁止自己写 `New-Object -ComObject Word.Application`、`ExportAsFixedFormat`，也禁止用 reportlab、pandoc 直出 PDF 或任何“读段落文本再重排”的方式生成交付 PDF。

## Windows 终端

系统已在每条命令前把 PowerShell 输出切成 UTF-8（`.opencode/plugins/powershell-utf8.ts`），中文报错和路径可以直接读，不需要再写 `chcp` 或 `[Console]::OutputEncoding`。

PowerShell 不支持 `<<EOF` heredoc；多行 Python 写成 .py 文件再运行。脚本不要命名为 `inspect.py`、`bisect.py` 这类与标准库同名的文件。

## docx-js 路线的补充

- 公式：`npx tsx "$env:AI4ES_PROJECT_ROOT\tools\docx\scripts\latex_to_omml.ts" --display --paragraph "…"` 生成结构化 OMML；不要把 ASCII 伪公式塞进一个 `m:r`。
- 表格：表 `columnWidths` 与每格 `width` 都用 `WidthType.DXA`，底纹 `ShadingType.CLEAR`；表题在上，图题在下。
- 目录：无界面渲染不刷新 TOC 字段，`separate` 与 `end` 之间要写可读的缓存目录文本。
