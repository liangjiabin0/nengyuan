from pyomo.environ import *
from gurobi import *

# 1. 使用pyomo定义简单优化问题
model = ConcreteModel() # 定义模型
model.x = Var(within=NonNegativeReals) # 声明决策变量 x
model.y = Var(within=NonNegativeReals) # 声明决策变量 y
model.obj = Objective(expr=model.x + model.y, sense = minimize) # 声明目标函数为 x+y, minimize 表示极小化
model.constrs = Constraint(expr=model.x + model.y <= 1) # 添加约束 x+y <= 1
model.write('model.lp') # 输出模型文件
model.pprint() # 打印模型信息

# 2. 使用pyomo定义简单优化问题
# (1) 使用 Gurobi 求解器
# opt = SolverFactory('gurobi') # 指定Gurobi为求解器
# solution = opt.solve(model) # 调用求解器求解

# (2) 使用免激活 Gurobi 求解器
# model = poi_gurobi_model()
solver = pyomo_gurobi_solver()
# model1 = gurobipy_model()
solution = solver.solve(model)

# 输出结果
print(solution)