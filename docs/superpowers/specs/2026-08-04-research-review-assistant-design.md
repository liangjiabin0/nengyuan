# 科研传承助手（综述生成）设计规格

日期：2026-08-04  
状态：已批准（待实现）  
范围：新增独立页面与 API，基于 OpenCode + 固定 skill 生成文献综述长文本，并支持 DOCX 导出。

## 1. 目标

在能元（AI4ES）中新增「科研传承助手」：交互形态对齐「学科知识问答」，但强制使用用户提供的 skill 包 `writing-source-grounded-research-reviews`，基于用户上传的多篇文献或文献 zip 生成中文综述/研究缺口报告，并支持导出 DOCX。

非目标：

- 不改写、不二次创作 skill 包内容
- 不做 Markdown 导出
- 不与学科知识问答共用会话历史
- 不默认开启联网检索（证据边界以用户上传文献为准）

## 2. 已确认决策

| 项 | 决策 |
|---|---|
| 实现路径 | 克隆对话工作台 + 专利式固定 Skill（方案 1） |
| 附件体积 | 本功能单独提高上限，单文件约 200MB，支持 zip 上传后服务端解压 |
| 会话 | 完全独立命名空间与 API |
| 导出 | 仅 DOCX |
| zip 篇数 | 不设篇数硬顶；全部可解析文献入库，对话时注入路径列表 |
| Skill 来源 | `writing-source-grounded-research-reviews-skill.zip` 原样安装 |
| 验收材料 | `微网韧性相关文献.zip` |

## 3. 信息架构与页面

- 侧栏 Overview 新增「科研传承助手」，靠近「学科知识问答」
- 首页可增加对应入口卡片
- 路由：`/research-review`
- 页面结构：左会话列表 + 右流式对话 + 底输入区（附件/发送），视觉与交互对齐 `ChatWorkbench`
- 标题：科研传承助手；副标题说明「基于文献的综述/研究缺口报告生成」

## 4. 附件与文献喂入

### 4.1 上传

- UI 与对话页同构，支持多选
- 接受：`.zip` 以及现有文献类扩展名（至少 `.pdf .docx .md .txt`；与现有解析能力对齐的表格类可按需保留）
- 单文件上限约 **200MB**（覆盖验收用文献包）

### 4.2 zip 解压

- 服务端解压；忽略 `__MACOSX`、隐藏文件等垃圾项
- 对可解析文献逐篇登记为附件条目
- zip 包本身保留「来源包」元数据以便追溯
- 单篇解析失败不阻断整包；UI 展示成功/失败列表，允许补传

### 4.3 喂给 OpenCode

- 沿用 `writeOpenCodeAttachments` 思路：将解析文本写成 sidecar 可读路径
- 每轮 prompt 注入已挂载文献相对路径清单
- 明确声明：这些文件是证据边界；禁止用常识顶替缺失证据

### 4.4 隔离

- 附件存储使用独立目录（建议 `storage/research-review-attachments/`）
- 会话/附件与 `/chat` 数据隔离，禁止串会话

## 5. Agent / Skill / Prompt

### 5.1 Skill 安装

- 将 `writing-source-grounded-research-reviews-skill.zip` **原样解压**到：
  `.opencode/skills/writing-source-grounded-research-reviews/`
- 保持目录名与 `SKILL.md` 中 `name: writing-source-grounded-research-reviews` 不变
- **禁止**改写 skill 正文、references、scripts、examples

### 5.2 Agent

- 新增 `.opencode/agents/research-reviewer.md`
- 运行参数对齐专利模式：`agent: research-reviewer`，`tools.skill: true`
- 允许：`read` / `list` / `glob` / `grep` / `skill`
- 默认关闭：`websearch` / `webfetch`（避免跳出上传证据边界）
- `opencode.json` 与 agent `permission.skill` 仅放行 `writing-source-grounded-research-reviews`（或等价精确名称）

### 5.3 固定 Prompt

每轮由服务端注入（用户消息拼接其后），至少包含：

1. 必须先用 skill 工具加载 `writing-source-grounded-research-reviews`
2. 严格遵循该 skill 的 Mandatory Workflow、Output Contract、Citation Contract
3. 本轮文献路径列表及「证据边界」声明
4. 以对话框流式长文本为主要交付（可多轮修订）

不另造第二套综述写作规范；规范以 skill 包为准。

## 6. 导出（仅 DOCX）

- 助手消息工具栏提供「导出 DOCX」
- 导出对象：指定助手消息，或会话中最新一篇综述正文
- 服务端生成 `.docx`；排版尽量对齐 skill 的 `references/word-format-spec.md`（标题层级、引用上标等能落地的规则优先落地）
- 有条件时调用 skill 自带检查脚本做一致性校验；校验失败仍返回文件，并提示校验结果
- **不做** Markdown 导出

## 7. API 与数据

独立于 `/api/chat`：

| 能力 | 建议路由 |
|---|---|
| 流式对话 | `POST /api/research-review` |
| 会话 CRUD | `/api/research-review/conversations`（含 `[id]`、`title`） |
| 附件 | `/api/research-review/attachments`（含 zip） |
| 导出 | `/api/research-review/.../export` → DOCX |

实现要点：

- 前端可 fork `ChatWorkbench` 为 `ResearchReviewWorkbench`（或等价命名），替换 API base、agent、附件 accept/上限、导出按钮
- 后端新增 `runOpenCodeResearchReview`（对齐 `runOpenCodeChat` / 专利 runner）
- 若使用 Hono 拆分挂载，须同步注册到 `server/api/routes.ts`
- OpenCode 会话映射与学科问答分开

## 8. 测试验收

使用用户提供的真实文件，不另造材料：

1. 安装 skill：`writing-source-grounded-research-reviews-skill.zip`
2. 打开「科研传承助手」TAB
3. 上传 `微网韧性相关文献.zip`（约 178MB），确认解压/解析反馈
4. 输入微网韧性相关综述问题，获得流式长文本；可多轮追问修订
5. 导出 DOCX 成功打开
6. 抽查：引用与结构应符合 skill 约束，且不引入未上传文献中的伪造条目

## 9. 主要落地文件（预期）

- `src/app/(dashboard)/research-review/page.tsx`
- `src/components/research-review-workbench.tsx`（或从 chat-workbench 派生）
- `src/components/dashboard-nav.tsx`、`home-dashboard.tsx`（入口）
- `src/app/api/research-review/**`
- `src/lib/opencode/research-review.ts`（或等价）
- `src/lib/research-review-attachments.ts`（或扩展附件模块）
- `.opencode/agents/research-reviewer.md`
- `.opencode/skills/writing-source-grounded-research-reviews/**`（来自用户 zip）
- `opencode.json`（skill 权限）

## 10. 风险与约束

- 大 zip（~200MB）上传/解压可能较慢：需进度或明确处理中状态，避免前端超时误判
- PDF 解析质量依赖现有平台能力；skill 说明 OCR 为最后手段，本功能不额外承诺 OCR
- DOCX 导出对「原生公式/三线表」的还原可能无法 100% 覆盖 skill Word 规范；以实现可落地规则 + 校验提示为准
