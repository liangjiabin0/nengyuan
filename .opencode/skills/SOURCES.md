# Skills 来源说明

## 国网指南

| 本仓库 skill 名 | 来源 | 用途 |
|-----------------|------|------|
| `sgcc-tech-guide` | `sgcc-tech-guide-portable-20260813` | 总部科技项目指南编制（证据树 + 固定母版） |

适配：隔离工作目录下必须先建「本次任务」子文件夹；允许构想 + 知识库启动；目录对齐 V7 产品化成果树，不落 V6 副本和逐页 PNG。

## 技术报告转科研 PPT（已移除）

| 本仓库 skill 名 | 来源 | 用途 |
|-----------------|------|------|
| `technical-report-ppt-pipeline` | `technical-report-ppt-pipeline-v2-editable-rebuild` | 报告→提示词→预览图→可编辑 PPTX |

已在技能库中删除（`storage/.opencode/removed-skills` 有标记，目录已不在仓库中）；提示词只在它重新安装后才会提到它。

适配：生图改为能元设置页图像端点（gpt-image-2 `/images/generations` 与 `/images/edits`）；读文档用 markitdown；重建用 python-pptx，不调用 ChatGPT `imagegen` / `@oai/artifact-tool`。

# Patent Skills 来源说明

## 本仓库现状（历史）

此前 `.opencode/skills/patent-*`（disclosure / clarification / strategy / claims / drawings / specification / audit）主要为**本项目手写适配层**：对接 `patents/{id}/opencode/` 工作区文件契约与能元流水线，并非从公开 skill 市场原样拷贝。

## 现已引入的成熟开源 Skills（MIT）

来源仓库：**ARIS / Auto-claude-code-research-in-sleep**  
https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep  
（亦收录于 ThomasMoreAI/legal-skills-open 的 patent-pipeline）

| 本仓库 skill 名 | 上游 skill | 用途 |
|-----------------|-----------|------|
| `patent-aris-structure` | `invention-structuring` | 发明交底结构化 |
| `patent-aris-claims` | `claims-drafting` | 权利要求撰写原则与流程 |
| `patent-aris-specification` | `specification-writing` | 说明书撰写原则与流程 |
| `patent-aris-review` | `patent-review` | 审查员视角多轮审校 |
| `patent-ref-cn-format` | `shared-references/patent-format-cn.md` | CNIPA 格式指南 |
| `patent-ref-principles` | `shared-references/patent-writing-principles.md` | 通用撰写原则 |

适配说明：

- 输出路径改为本系统工作区：`patents/{projectId}/opencode/` 下的约定文件名。
- 上游依赖的 `mcp__codex__codex` 外部审查模型：在本环境改为**同模型审查员角色 + patent-aris-review / patent-audit**，不强制 Codex MCP。
- 上游 `Bash` / WebSearch：在 patent-drafter 中仍禁用；检索由系统 prior-art 模块负责。

本项目原有 `patent-disclosure` 等适配 skill 继续负责**文件契约与流水线对接**，并应优先加载上述成熟 skill 获取专业规则。
