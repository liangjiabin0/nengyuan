# Word / PDF 共用规格

`render-docx` 与 `render-pdf` 使用同一份 JSON。也可用 `--markdown`，引擎会先转成该规格再排版。

## 顶层字段

| 字段 | 说明 |
| --- | --- |
| preset | `cn-report`（默认）、`cn-business`、`en-report`、`memo` |
| title | 题名 |
| subtitle | 副题 |
| author / org / date | 封面信息 |
| toc | 是否生成目录 |
| header / footer | 页眉页脚；页眉默认用 title |
| page_numbers | 默认 true |
| confidential | true 时页眉加「内部资料」 |
| sections | 章节数组 |
| references | 参考文献字符串数组，按 GB/T 顺序号排出 |

## sections[]

- `heading`：章节标题。空字符串表示不输出标题，只输出 blocks。
- `level`：1–3，对应 Heading 1–3。
- `blocks`：见下。

## blocks[]

```json
{ "type": "paragraph", "text": "……", "indent": true }
{ "type": "list", "ordered": true, "items": ["条目"] }
{ "type": "table", "title": "表1 …", "headers": ["列"], "rows": [["值"]], "style": "three-line" }
{ "type": "figure", "path": "charts/load.png", "caption": "图1 …", "width_cm": 14 }
{ "type": "equation", "latex": "P = UI", "number": "1" }
{ "type": "quote", "text": "说明" }
{ "type": "pagebreak" }
{ "type": "code", "text": "print(1)" }
```

`figure.path` 相对于规格文件所在目录，或给绝对路径。图片须先真实存在。

## Markdown 约定

```markdown
---
preset: cn-report
title: 题名
author: 能元
date: 2026-09-02
toc: true
---

# 1 标题

正文段落。

表1 方案对比

| 方案 | 成本 / 万元 |
| --- | ---: |
| A | 12.0 |

$$
P = UI
$$
```

不要把 Markdown 文件直接改名为 `.docx` / `.pdf`。

## 预设字体

| 预设 | 汉字 | 西文 | 标题 |
| --- | --- | --- | --- |
| cn-report | 宋体 | Times New Roman | 黑体 |
| cn-business | 微软雅黑 | Calibri | 微软雅黑 |
| en-report | Times New Roman | Times New Roman | Times New Roman |
| memo | 宋体 | Times New Roman | 黑体 |

页面 A4。`cn-report` 边距上 2.5 / 下 2.5 / 左 3.0 / 右 2.5 cm。
