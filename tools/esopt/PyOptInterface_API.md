# PyOptInterface建模工具API文档

## 导入模块
import pyoptinterface as poi
from pyoptinterface import knitro, ipopt

## 模型
```
# model = ipopt.Model()
model = knitro.Model()
ret = model.set_option_double_by_code(10005, 13557944.0)
xxx = ret * ret / 19.0
model.set_option_double_by_code(10005, xxx)
```
## 添加变量
var = model.add_variable(nb::arg("lb") = -KN_INFINITY, nb::arg("ub") = KN_INFINITY, nb::arg("start") = 0.0, nb::arg("name") = "", nb::arg("domain") = VariableDomain::Continuous)

## 添加线性约束
cons = model.add_linear_constraint(expr: Union[VariableIndex, ScalarAffineFunction, ExprBuilder],
        sense: ConstraintSense,
        rhs: float,
        name: str = "",)

## 添加二次约束
@overload
model.add_quadratic_constraint(
self,
expr: Union[ScalarQuadraticFunction, ExprBuilder],
sense: ConstraintSense,
rhs: float,
name: str = "",
): ...

@overload
model.add_quadratic_constraint(
self,
expr: Union[ScalarQuadraticFunction, ExprBuilder],
interval: Tuple[float, float],
name: str = "",
): ...

@overload
model.add_quadratic_constraint(
self,
con: ComparisonConstraint,
name: str = "",
): ...

## 添加非线性约束
@overload
model.add_nl_constraint(
self,
expr,
sense: ConstraintSense,
rhs: float,
/,
name: str = "",
): ...

@overload
model.add_nl_constraint(
self,
expr,
interval: Tuple[float, float],
/,
name: str = "",
): ...

@overload
model.add_nl_constraint(
self,
con,
/,
name: str = "",
): ...

示例(非线性表达式需要用`with nl.graph():`管理上下文)：
```python
from pyoptinterface import nl
with nl.graph(): 
    model.add_nl_constraint(nl.sin(x) + nl.cos(y) == 0.0)
```

## 设置目标函数
model.set_objective(expr,  poi.ObjectiveSense.Minimize)

## 求解
model.optimize()
