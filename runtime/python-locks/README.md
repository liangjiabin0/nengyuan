# 已验证服务器 Python 依赖快照

2026-10-02 从现有可信工具环境导出，12个原工具环境及新MGPlan GPU环境均通过 `pip check`。这些文件用于记录实际版本和对比重装结果，不替代各工具 requirements，也不是跨平台安装清单。原工具环境使用Python3.12；`mgplan-gpu-python311-linux.txt`使用Python3.11，CUDA12.9轮子。

GPU轮子须单独提供；不在PyPI普通索引或Git仓库中。文件名 `gurobipy-13.0.2+cu129-cp311-cp311-manylinux_2_24_x86_64.whl`，SHA256为 `10f0a10fed0c0f959d11bc4f60d36d4ef04a13c48ecf649cd557e8b952de0680`。先安装匹配轮子再核对依赖。安装不授予商业求解许可。

MGPlan与TDMG分别使用自己的Python环境，不能将GPU环境的MGPLAN_PYTHON当作TDMG解释器。
