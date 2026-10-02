# 能元 PDF 约定

官方 `SKILL.md` 仍然有效。这里只写能元环境差异。

## 路径与依赖

- 禁止会话里 `pip install` 或创建 venv。
- 使用 `$env:AI4ES_PROJECT_ROOT\tools\office-docs-venv\Scripts\python.exe` 运行 `pypdf`、`pdfplumber`、`reportlab` 和本技能 `scripts/`。
- 成品写入 `deliverables/`。
- 读用户上传的已有 PDF 用 `markitdown`。本技能负责新建、合并、拆分、填表。

## 中文与页面

- 页面 A4。汉字嵌入本机宋体/黑体（Windows `C:\Windows\Fonts` 的 simsun / simhei）。
- 禁止 Unicode 上下标字符（₀¹²），改用 ReportLab `<sub>` / `<super>`。
- 抽不出中文或出现方框时先检查是否嵌入了中文字体。

## 公式

正文汉字宋体。数学变量用 Times New Roman / Times-Italic，不要用宋体排 `P`、`Δ`。不要把 `$...$` 写进 PDF。

## Word 转 PDF 不走本技能

用户要的是某份 Word 的 PDF 版时，必须用 `docx` 技能的 `scripts/office/render.py` 由 Word/LibreOffice 渲染，禁止用 `reportlab`、`pdfplumber` 或 `python-docx` 读段落文本再重排。段落文本里没有 `m:t` 数学运行，重排出来的 PDF 会静默丢掉全部公式，表格和版面也不是原件。本技能只负责从零新建 PDF、合并、拆分和填表。

## 交付文件禁止出现系统内部引用

PDF 正文不得出现语料路径（`knowledge-corpus/...`）、文件行号（`....md：120-180`）、`[E1]`/`[L2]` 角标、盘符与服务器绝对路径、仓库目录（`repro/`、`storage/`、`tools/`）和 `opencode` 等运行时名称。那套路径引用只用于对话回答的前端角标；要标出处就写作者、年份、DOI 或链接。

## 预览

用 docx 技能的 `scripts/office/render.py 文件.pdf --pages --dpi 100` 出页图（有 pdftoppm 用 pdftoppm，没有就用 pypdfium2），逐页抽查。不要为了看页图去装 fitz。
