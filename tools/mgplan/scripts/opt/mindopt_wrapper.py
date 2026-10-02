from mindoptpy import MDO, quicksum
import mindoptpy as mp


class PRM:
    # variable domain
    CONTINUOUS = MDO.CONTINUOUS
    BINARY = MDO.BINARY
    INTEGER = MDO.INTEGER
    # constraint sense
    EQUAL = MDO.EQUAL
    GREATER_EQUAL = MDO.GREATER_EQUAL
    LESS_EQUAL = MDO.LESS_EQUAL
    # objective sense
    MINIMIZE = MDO.MINIMIZE
    MAXIMIZE = MDO.MAXIMIZE


class Model:
    def __init__(self):
        self.model = mp.Model()
        self.var_dict = {}
        self.con_dict = {}

    def add_variables(self, *coords, lb=-float('inf'), ub=float('inf'), domain=PRM.CONTINUOUS, name=""):
        assert name not in self.var_dict
        variables = self.model.addVars(*coords, lb=lb, ub=ub, vtype=domain, name=name)
        self.var_dict[name] = variables
        return variables

    def add_linear_constraint(self, expr, sense, rhs, name=""):
        assert name not in self.con_dict
        linear_constraint = self.model.addLConstr(expr, sense=sense, rhs=rhs, name=name)
        self.con_dict[name] = linear_constraint
        return linear_constraint

    @staticmethod
    def set_variable_bounds(var, lb=None, ub=None):
        if lb is not None:
            var.LB = lb
        if ub is not None:
            var.UB = ub

    def set_objective(self, expr, sense=PRM.MINIMIZE):
        if type(expr) in [int, float]:
            expr = quicksum([expr])
        return self.model.setObjective(expr, sense=sense)

    def optimize(self):
        self.model.optimize()
