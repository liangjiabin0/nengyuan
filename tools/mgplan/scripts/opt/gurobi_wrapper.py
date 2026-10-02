# coding:utf-8



from gurobipy import GRB, quicksum
import gurobipy as gp
from .gurobi import gurobipy_model


class PRM:
    # variable domain
    CONTINUOUS = GRB.CONTINUOUS
    BINARY = GRB.BINARY
    INTEGER = GRB.INTEGER
    # constraint sense
    EQUAL = GRB.EQUAL
    GREATER_EQUAL = GRB.GREATER_EQUAL
    LESS_EQUAL = GRB.LESS_EQUAL
    # objective sense
    MINIMIZE = GRB.MINIMIZE
    MAXIMIZE = GRB.MAXIMIZE


class Model:
    def __init__(self):
        self.model = gurobipy_model()
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

    def add_quadratic_constraint(self, expr, sense, rhs, name=""):
        assert name not in self.con_dict
        quadratic_constraint = self.model.addQConstr(expr, sense=sense, rhs=rhs, name=name)
        self.con_dict[name] = quadratic_constraint
        return quadratic_constraint

    def add_general_constraint(self, constr, name=""):
        assert name not in self.con_dict
        general_constraint = self.model.addConstr(constr, name=name)
        self.con_dict[name] = general_constraint
        return general_constraint

    def set_parameter(self, name, value):
        assert name in ['MIPGap']
        self.model.setParam(name, value)

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

    def get_value(self, expr_or_var):
        if isinstance(expr_or_var, gp.tupledict):
            return self.model.getAttr("X", expr_or_var)
        elif isinstance(expr_or_var, gp.LinExpr):
            return expr_or_var.getValue()
        else:
            print(f"unsupported type for {type(expr_or_var)}")
            exit(-1)
