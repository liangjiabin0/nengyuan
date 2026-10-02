# 能元 PPTX 约定

官方 `SKILL.md` 仍然有效。这里只写能元环境差异。

## 路径与依赖

- 禁止会话里 `npm install` 或创建 venv。
- Node：`$env:NODE_PATH="$env:AI4ES_PROJECT_ROOT\node_modules"`，然后 `require('pptxgenjs')`。仓库已安装 `pptxgenjs` 4.x：`addChart(type, data, opts)` 的 `data` 直接是系列数组 `[{ name, labels, values }]`，不要再包一层。
- Python 脚本用 `$env:AI4ES_PROJECT_ROOT\tools\office-docs-venv\Scripts\python.exe`（有 python-pptx、pypdfium2、Pillow）。
- 解包打包用 `scripts/office/package.py unpack|pack`，不要写 bash `unzip`，也不要自己写 `zipfile` 循环。
- 成品写入 `deliverables/`。
- 读已有 PPT 附件用 `markitdown`。
- 要看论文 PDF 某几页的图：`scripts/office/render.py 论文.pdf --pages --dpi 150` 直接出页图，不需要 fitz / pdfplumber。

## 公式与字体

幻灯片上的数学变量用 Times New Roman 斜体，不要用默认 Calibri。汉字用宋体、黑体或微软雅黑。数字、运算符、单位用 Times New Roman 正体。

## 校验

`writeFile()` 之后依次跑 `scripts/office/preflight.py`（结构，一秒，退出码 1 表示 PowerPoint 打不开，例如形状宽高为负）、`scripts/office/validate.py`（schema）和 `scripts/office/deliverable_check.py`（交付合规，退出码 1 不能交）。

交付合规闸门拦的是：语料路径（`knowledge-corpus/...`）、文件行号（`....md：120-180`）、`[E1]`/`[L2]` 角标、盘符与服务器绝对路径、仓库目录（`repro/`、`storage/`、`tools/`）和 `opencode` 等运行时名称，以及 Markdown/LaTeX 源码。要标出处就写作者、年份、DOI 或链接。

## 预览必须看

预览一律用 `scripts/office/render.py deck.pptx --pdf 构建目录/deck.pdf --pages --json`。项目自带便携 LibreOffice（`tools/libreoffice`），Windows 上还能退到 PowerPoint COM，全程带超时，所以正常情况下一定能出页图。**交付前逐页看页图**，检查文字溢出、重叠和图表是否为空。退出码 3 表示本机确实没有渲染器，如实说明“未看幻灯片图”；禁止自己 `New-Object -ComObject PowerPoint.Application`。

LibreOffice 对坏文件比 PowerPoint 宽容：页图正常不代表 PowerPoint 能打开，所以 preflight 和 validate 不能省。
