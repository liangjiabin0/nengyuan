---
name: markitdown
title: 读取文档附件
description: 用 Microsoft MarkItDown 把 PDF、Word、PowerPoint、Excel 等不能直接当纯文本 read 的文件转成 Markdown。用户上传或提到这类附件、需要抽取正文或表格时使用。
---

# 用 MarkItDown 读取疑难文件

本技能只调用开源成熟转换器，禁止手写 PDF/Office 解析器，也禁止用本仓库的 `pdf-parse` / `mammoth` / SheetJS 去抽附件。

默认工具是 [Microsoft MarkItDown](https://github.com/microsoft/markitdown)（MIT）。PDF 转换结果明显缺字、乱码或几乎为空时，再改用 [pymupdf4llm](https://github.com/pymupdf/pymupdf4llm)（Artifex，MIT）。

## 何时使用

出现下面任一情况就用：

- 工作区里有 `.pdf` `.doc` `.docx` `.ppt` `.pptx` `.xls` `.xlsx` `.rtf` `.epub` `.msg` 等原文件，且同目录还没有 `.converted.md`
- 用户要你根据这些附件回答、摘表格、对原文
- 直接 `read` 原文件得到的是乱码、二进制或几乎无正文

不要用本技能：

- `.txt` `.md` `.json` `.xml` `.yaml` `.csv` `.html` `.py` 等本就是 UTF-8 文本：直接 `read` 原文件
- 同目录已经有 `.converted.md`：直接 `read` 它，不要再转换，不要建 venv
- 图片附件：系统已作为视觉输入提交，不要再转一遍
- `.zip`：系统不会自动解压。若任务需要其中的 PDF/Word/表格，先解压再对本技能支持的文件转换；不需要内部文档时不要解压整个包
- `.exe`：不是文档。已加载求解技能时用技能路径执行，不要哈希 exe
- `.mat` `.mps` `.lp`：按对应求解技能处理，不要转 Markdown

## 读哪一个文件

提示里的附件路径优先用 `.orig.pdf` / `.orig.docx` 这类**原文件**。同目录没有 `.orig` 的 `.md` 只是系统说明，不是原文。若同目录已有 `.converted.md`，那才是转换正文。

转换结果写到原文件同目录，例如：

```text
knowledge-corpus/attachments/<会话hash>/<hash>.orig.pdf
knowledge-corpus/attachments/<会话hash>/<hash>.converted.md
```

先看是否已有 `.converted.md`；没有再转换，然后 `read` 它。不要只复述系统说明。

## 环境（固定仓库根，禁止探路）

会话工作目录是 `storage/chat-workspaces/...`，不是能元仓库根。禁止在会话目录创建 `tools/markitdown-venv`，禁止 `Test-Path` 多个候选路径，禁止自己 `python -m venv` 或 pip。

Windows 调用仓库 `tools/markitdown.cmd`，Linux 用 `tools/markitdown.sh`（也可用 `tools/markitdown-venv` 里的 python `-m markitdown`）。用 `AI4ES_PROJECT_ROOT` 定位。该脚本使用并在缺失时创建仓库根下的 `tools/markitdown-venv`，不要另建一份。

```text
tools/markitdown.cmd "原文件路径" -o "同目录/同名.converted.md"
"$AI4ES_PROJECT_ROOT/tools/markitdown.sh" "原文件路径" -o "同目录/同名.converted.md"
```

旧版 `.ppt` / `.doc` 不是 zip OOXML：先由 LibreOffice 转为 `.pptx` / `.docx` 再转换。系统同步附件时通常已经写出 `.converted.md`，有转换稿就直接 `read`，不要重复转换。

## 转换步骤

1. 同目录已有非空 `.converted.md` 就直接 `read`，结束。
2. 否则调用上面的包装命令（不要自己解析 ZIP/OLE/PDF 结构）。
3. 检查输出：文件应非空，并含可读中文/英文句子或 Markdown 表格。
4. 再 `read` 转换结果，据此回答。引用附件时用转换后的相对路径和行号。

本技能与求解技能互不阻塞：用户要跑算例时，求解命令先发出；只有用户问题需要读这份 Word/PDF 时才转换。

## PDF 质量不够时

仅当 MarkItDown 的 PDF 结果过短、乱码或表格坍缩时，用 pymupdf4llm（官方 `to_markdown`，不是自研抽取）。解释器和脚本路径均从 `AI4ES_PROJECT_ROOT` 下的相对路径解析。

扫描件、纯图片页仍然可能没有文字：如实说明文本不足，可结合已提交的视觉图片；不要假装已经读到正文。不要调用 Azure Document Intelligence 或任何云 OCR 账号。

## 失败时

- 缺依赖：再运行一次包装命令，让它自行安装；清华源失败再回退官方 PyPI。
- 某格式报 missing extra：用提示词里的解释器执行 `python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple "markitdown[pdf,docx,pptx,xlsx,xls]"`。
- 仍失败：报告命令、stderr 和文件类型，不要编造文件内容，也不要改用手写解析。
