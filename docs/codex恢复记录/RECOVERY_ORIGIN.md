# 服务器源码保全记录

来源：`user@10.1.4.166:/data/ai4es/.codex-preview-root-3010`。

本目录的源码通过 SFTP 从服务器复制，没有混入本机旧版源码。服务器部署文件未被修改。

- `src/` 共 456 个文件，其中 450 个 TypeScript / TSX 文件。
- 已复制预览目录的 `package.json`、`tsconfig.json`、`next.config.js`、`tailwind.config.ts` 和 `next-env.d.ts`。
- 4 个关键文件的 SHA-256 与服务器读取得到的摘要一致：`package.json`、`tsconfig.json`、`src/lib/db.ts`、`src/components/chat-workbench.tsx`。
- `src/` 全部 456 个文件的相对路径与文件 SHA-256 汇总校验一致，汇总值为 `4e9f4e29a1a02f90f9a256abb041aa0b78ac394cdfc9f99a1da95eab501fb5bf`。
- 未复制 `.env.local`、数据库、语料、node_modules 和开发编译缓存。

这是一份服务器预览源码快照，不保证与当前线上代码完全一致。`package.json` 与主界面文件的服务器修改时间在 2026-09-16（UTC），当前部署的后端构建记录为 2026-09-28（UTC）；文件时间只能作为线索，不能证明版本一致。

## 当前已知缺口

线上 `api-app.mjs` 和 `worker-app.mjs` 的模块标记合并后有 316 个独立路径，其中 303 个在这份源码中存在。路径相同不代表内容相同。缺少以下 13 个路径：

1. `server/api/index.ts`
2. `server/api/routes.ts`
3. `server/worker/index.ts`
4. `src/app/api/chat/conversations/[id]/question/route.ts`
5. `src/app/api/system/subagent-router/route.ts`
6. `src/app/api/system/thinking-levels/route.ts`
7. `src/lib/opencode/chat-ask.ts`
8. `src/lib/opencode/session-routing.ts`
9. `src/lib/self-learning-search.ts`
10. `src/lib/subagent-router-store.ts`
11. `src/lib/subagent-router.ts`
12. `src/lib/thinking-levels-core.ts`
13. `src/lib/thinking-levels.ts`

初始预览快照未包含 `scripts/`、工具目录和后端启动配置。后续备份已另外从部署主目录保存 `scripts/`、`tools/`、`.opencode/` 中的明文代码及配套文本，详见 README.md 和 SERVER_SOURCE_MANIFEST.json；缺失的主项目后端入口仍未补齐，不能直接称为已完成的本地可运行版本。

服务器用户的 VS Code/Cursor 编辑器文件历史中未找到与能元相关的资源记录；后续另在 Cursor 的 agent-transcripts 与 retrieval/checkpoints 中找到部分相关对话和网关脚本修改记录，这些原始记录仅保存在本地，不上传到本仓库。已检查的 `/tmp`、`/var/tmp`、`/root`、其他用户目录和 `/var/backups` 中未找到上述缺失源码。部署主目录没有主项目 `.git`。上述检索有范围和深度限制，不能据此断言服务器任何位置都没有其它副本。

预览目录的开发编译文件包含内嵌 source map，但主要是 Next.js 框架源码和少量预览代码；未找到上述缺失模块的原始源码。后续应继续以服务器材料比对、补齐并验收，避免用本机旧版替代当前版本。
