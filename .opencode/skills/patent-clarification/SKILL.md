---
name: patent-clarification
description: 由 OpenCode 复核交底并主动提问（含申请人/发明人确认）；写出 clarification.json / blockers.json
compatibility: opencode
metadata:
  workflow: patent
---

# patent-clarification

读取 `disclosure.json`、`SOURCE.md`、`ANSWERS.md`、`META.json`。

目标：**该问则问**。申请人/发明人等身份确认**由你（OpenCode）主动提出**，不要假设 TypeScript 已替你问过。

写入 `clarification.json`：

```json
{
  "readyForDrafting": false,
  "supplementaryFacts": [],
  "stillMissing": [{"severity":"P0","question":"","reason":"","options":[]}]
}
```

若存在未解决 P0，同时写入 `blockers.json`（**必须是数组**；无问题时写 `[]`，禁止写 `{}`）：

```json
[
  {
    "id": "confirm-inventors",
    "severity": "P0",
    "category": "identity",
    "question": "",
    "reason": "",
    "answer": ""
  }
]
```

身份确认规则（必须由本 skill 执行）：

1. 核对 `ANSWERS.md`：若用户尚未明确确认发明人/申请人，即使 `META.json` / SOURCE 已识别出姓名与单位，也必须提问确认。
2. 发明人问题建议 `id=confirm-inventors`；申请人问题建议 `id=confirm-applicant`。
3. 若 SOURCE/META 已有候选，把候选写入 `answer` 字段供用户确认或修改，并在 `question` 中写明「已识别为…，请确认或修改」。
4. 一次可同时列出发明人与申请人两个 P0（优先），再加最多 3 个关键技术 P0/P1。

其他规则：

1. 独立权利要求必要特征、保护边界等无法推断时必须提问。
2. 公知原理/符号化方程/上位概括可写入 `supplementaryFacts`，不要提问。
3. 禁止因公式排版、附图草图、公知参数、仿真软件品牌而提问。
4. 无未解决 P0 时：`readyForDrafting=true`，`stillMissing=[]`。
5. 有未解决 P0：写 `STATUS.json={"status":"needs_input"}` 并**停止后续撰写**。
6. 字符串数组元素必须是字符串。
