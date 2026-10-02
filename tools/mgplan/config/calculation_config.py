"""mgplan skill 的默认运行配置。"""

DEFAULT_CASE = "sSEP"
DEFAULT_SOLVER = "gurobi"
DEFAULT_LOG = "Yes"

# 原始计算内核中的求解参数由 openTEPES_ProblemSolving.py 管理。
# 设备授权白名单由 scripts/openTEPES_Main.py 管理，本配置不覆盖它。
# 原始主函数当前使用自身硬编码值，本文件仅作默认值说明。
