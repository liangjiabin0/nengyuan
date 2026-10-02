# 能元 Excel / CSV 约定

官方 `SKILL.md` 仍然有效。这里只写能元环境差异。

## 路径与依赖

- 禁止会话里 `pip install` 或创建 venv。
- 使用 `$env:AI4ES_PROJECT_ROOT\tools\office-docs-venv\Scripts\python.exe` 运行 `openpyxl`、`pandas` 和 `scripts/recalc.py`。
- 成品写入 `deliverables/`。CSV 使用 `utf-8-sig`。
- 读已有表格附件用 `markitdown`；纯 CSV 可直接 `read`。

## 公式（工作表）

单元格合计必须写成 Excel 公式（如 `=SUM(B2:B9)`），不要把 Python 算死的数字当合计交付。有公式时运行：

```text
<venv-python> <本技能>/scripts/recalc.py deliverables/book.xlsx
```

`recalc.py` 会自己找 LibreOffice：先找项目自带的便携版 `tools/libreoffice`，再找 `AI4ES_SOFFICE`、`PATH` 和常见安装目录，Windows 和 Linux 一样。返回 `error` 说明没找到或没重算，就在答复里如实说明未重算，不要假装已经验证公式。不要使用 `XLOOKUP` 等 LibreOffice 无法计算的函数。

`scripts/office/preflight.py`、`scripts/office/validate.py` 和 `scripts/office/deliverable_check.py` 不依赖 LibreOffice，任何平台都要跑；`scripts/office/render.py --probe` 一次查清本机有哪些引擎。

`deliverable_check.py` 退出码 1 不能交。它拦语料路径（`knowledge-corpus/...`）、文件行号（`....md：120-180`）、`[E1]`/`[L2]` 角标、盘符与服务器绝对路径、仓库目录（`repro/`、`storage/`、`tools/`）和 `opencode` 等运行时名称，以及单元格里的 Markdown/LaTeX 源码。那套路径引用只用于对话回答的前端角标，表格读者查不到；要标出处就写作者、年份、DOI 或链接。

数学符号（变量 \(P\)、\(\Delta\)）若出现在单元格说明文字中，用 Times New Roman 斜体；`=SUM` 这类工作表公式本身不受此项约束。

## 中文字体

汉字用微软雅黑或宋体，西文 Arial 或 Times New Roman。不要通篇 Calibri。
