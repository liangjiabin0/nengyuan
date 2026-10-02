# Excel / CSV 规格

## 工作簿 JSON

```json
{
  "preset": "cn-workbook",
  "title": "可选工作簿标题",
  "author": "能元",
  "sheets": [
    {
      "name": "汇总",
      "freeze": "A2",
      "filter": true,
      "columns": [
        { "key": "name", "title": "方案", "width": 16, "format": "text" },
        { "key": "capex", "title": "投资 / 万元", "format": "number" },
        { "key": "total", "title": "合计", "format": "number", "formula": "={col:capex}+{col:om}" }
      ],
      "rows": [{ "name": "A", "capex": 80, "om": 12 }],
      "totals": { "sum": ["capex", "total"] },
      "charts": [{ "kind": "bar", "title": "投资", "x": "name", "y": ["capex"], "anchor": "F2" }],
      "notes": "脚注"
    }
  ]
}
```

`format`：`text`、`number`、`int`、`percent`、`currency`、`date`。百分比存小数（`0.15` 显示 15%）。

`formula` 模板：

- `{col:字段名}` → 该列当前行，如 `B2`
- `{row}` → 当前行号
- `{字段名}` 同 `{col:字段名}`

合计行用 `totals.sum` 生成 `=SUM(B2:B3)`，不要只写入 Python 算死的数字。

`kind`：`bar`、`line`、`pie`。

只有一张表时，可以把 `columns` / `rows` 放在根上，引擎会包成一个 sheet。

## CSV JSON

```json
{
  "encoding": "utf-8-sig",
  "delimiter": ",",
  "columns": ["time", "load_mw"],
  "rows": [{ "time": "00:00", "load_mw": 62.1 }]
}
```

`rows` 也可以是数组的数组，顺序与 `columns` 一致。`encoding` 仅在用户明确要求兼容老 Excel 时用 `gbk`。
