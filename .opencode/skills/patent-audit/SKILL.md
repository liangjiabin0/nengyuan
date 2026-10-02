---
name: patent-audit
description: 适配层：加载成熟 patent-review 做多角度审校并写 audit.json
compatibility: opencode
metadata:
  workflow: patent
  adapts: patent-aris-review
---

# patent-audit（适配层）

1. 加载 `patent-ref-principles`、`patent-ref-cn-format`、`patent-aris-review`。  
2. 若有 `QUALITY_REPORT.json`，严格按其中 `angle` 深审。  
3. 读取 disclosure / PRIOR_ART / strategy / draft / claims / drawings-plan / SOURCE。  
4. 按成熟审查员流程审查并就地修订后，写入 `audit.json`：

```json
{
  "issues": [{"id":"M1","severity":"error","category":"","message":"","location":"","suggestion":""}],
  "supportMatrix": [{"claim":1,"supported":true,"evidence":["A1"],"note":""}],
  "remainingRisks": []
}
```

`severity` **只能**是 `error` | `warning` | `info`。已就地修好的问题必须记 `info`（不要写 `error` + “已修改…”、也不要写 `fixed`/`resolved`/`P0`）。未修好才标 `error`。

若任务要求，另写 `audit-round-{n}.json`。禁止只做结构打勾；error 能修则修，不能修则如实记录。
