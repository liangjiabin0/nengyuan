# ESOPT 桥接

本目录是可随项目迁移的最小 ESOPT 运行时。

- 桥接：`tools/esopt/esopt_bridge`
- 求解器与 PGLib 算例：`tools/esopt/work/DCOPF`
- Python 依赖：`tools/esopt-venv`（执行 `npm run portable:install` 自动创建）
- MCP 启动器：`scripts/esopt-mcp.cmd`

编排器会调用 `inspect` / `compare` / `solve --pslp` / 增量会话（`model-new` → `add-var` → `optimize`）。
