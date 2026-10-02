# PPTX 规格

```json
{
  "preset": "cn-business",
  "title": "汇报标题",
  "author": "能元",
  "slides": [
    {
      "title": "页标题",
      "subtitle": "可选副标题",
      "bullets": ["条目一", "条目二"],
      "notes": "讲稿",
      "figures": [{ "path": "chart.png", "caption": "可选" }]
    }
  ]
}
```

`preset`：`cn-report`、`cn-business`、`en-report`、`memo`。画布固定 16:9（13.333×7.5 英寸）。

`content` 可作为 `bullets` 的别名。无母版、无复杂公式时用本规格；科研模板复刻走 `technical-report-ppt-pipeline`。
