# ESOPT 桥接

本目录是可随项目迁移的最小 ESOPT 运行时。

- 桥接：`tools/esopt/esopt_bridge`
- 求解器与 PGLib 算例：`tools/esopt/work/DCOPF`
- Python 依赖：`tools/esopt-venv`（执行 `npm run portable:install` 自动创建）
- MCP 启动器：`scripts/esopt-mcp.cmd`

编排器会调用 `inspect` / `compare` / `solve --pslp` / 增量会话（`model-new` → `add-var` → `optimize`）。

## Linux 原生 ESOPT（可选）

官方仓库：https://github.com/yuntaoju2022/smart-energy-system 。安装包固定为提交 `38d7df0e679d93da848e05f30327a4f2a56dc60b`，SHA256 在安装脚本中校验。
仓库提供 SDK 头文件和预编译库；未发现独立的开源许可证，不能据此认定核心库可自由修改或再分发。SDK 不入本项目 Git，由部署方直接下载。

Ubuntu 22.04 x86_64 已验证。需要 gcc/g++（C++20）、cmake、curl、python3 和 OpenSSL 3 运行库：

```bash
bash tools/esopt/native/install-linux.sh
bash tools/esopt/esopt.sh capabilities
bash tools/esopt/esopt.sh template knapsack --solve
bash tools/esopt/esopt.sh solve case24 --pslp
```

SDK 默认安装到 `tools/esopt/upstream-linux`，HiGHS 1.12.0 单独编译，不覆盖现有 Python 环境。自定义目录使用 `ESOPT_NATIVE_HOME`；必须使用 ASCII 路径。

Linux JSON 模型、增量模型和 DCOPF 自动优先使用原生 ESOPT。未配置 ESOPT 许可证时，超过 300 个变量或 300 条约束会选择 highspy，返回 `backend_selection_reason`。`ESOPT_BACKEND=native` 可强制原生（超过试用限制报错），`highspy` 可强制 HiGHS，默认 `auto`。显式 PSLP 要求原生 ESOPT，不允许静默降级。

完整 ESOPT 许可证由作者提供，通过 `LICENSE_LOCATION=/absolute/path/customer.ini` 配置；文件存在不代表授权有效，仍由 SDK 校验。ESOPT 许可证与 Gurobi 许可证分别管理。本接口目前只暴露线性 LP/MIP/DCOPF；MPS/LP 文件仍直接使用 HiGHS；非线性、二次模型及其他商业求解器未接入。

`capabilities.native_esopt.ready` 会执行小模型探测。PSLP 仅表示可调用，求解器可能跳过整数模型的预处理，结果中的 `pslp_requested` 不保证预处理实际执行。服务器验收命令：

```bash
ESOPT_ROOT="$PWD/tools/esopt" PYTHONPATH="$PWD/tools/esopt/esopt_bridge" \
  tools/esopt-venv/bin/python tools/esopt/tests/test_native_integration.py
```
