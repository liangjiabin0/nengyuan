# 本机版本发布说明（2026-10-13）

本次以本机 `能元合并版` 的当前源码为发布内容，目标仓库为
`https://github.com/liangjiabin0/nengyuan`，通过 PR 提交到 `main`。

## 本次内容

- 恢复管理员侧栏中的「模型配置」，位于科研数据表与系统设置之间。
- 纳入论文智能评审页面、专用模型配置、后台任务、评审/复现/Word 与两页 PPT 输出流程。
- 纳入 paper-peer-review v8 与 two-slide-paper-ppt-graphical v3 技能快照及原生 PPT 构建适配器。
- 保留快照文件的原始字节，避免 Git 换行转换导致任务启动时的 SHA-256 校验失败。
- Linux 的评审 PPT 最终渲染使用现有 LibreOffice / Poppler；Windows 使用 PowerPoint。
- 包含本机的任务队列、数据库结构与隔离工作目录调整。

## 部署位置

服务器：`10.1.4.166`。独立发布目录：
`/data/ai4es-recovery-20261002/releases/local-20261013`。

由现有 user systemd 服务 `ai4es.service` 管理整套进程，Web 3000、API 4000、
OpenCode 4097、模型网关 4098。使用服务器已有数据库、语料、模型配置、密钥和计算工具运行环境。
本机的 Windows 路径及本机运行配置不覆盖服务器配置。

发布前备份目录：`/data/ai4es-backup-20261002/local-20261013`。
保留旧发布目录、systemd 配置、数据库备份与运行数据备份。
切换时先停止旧服务，补齐运行数据备份并重新导出数据库，再启动新服务。
启动健康检查失败时恢复原 systemd 配置并启动原部署。
数据库回退须另行评估，避免覆盖发布后新增的数据。

## 发布检查

- 本机导航修复已通过生产构建与 TypeScript 检查，并在页面中确认。
- 发布源码检查排除环境文件、密钥、数据库、运行数据与生成产物。
- 两套导入技能在 Git 索引中的文件 SHA-256 须与其 manifest 全部一致。
- 服务器执行依赖安装、API/Worker 构建、Web 构建和 Linux PPT 渲染检查。
- 切换后检查 systemd、Web/API/OpenCode/模型网关，以及页面和新增 API 路由。

最终部署结果记录在发布目录的 `DEPLOYED_REVISION` 和服务器私有发布日志中。
