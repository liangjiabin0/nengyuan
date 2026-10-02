import pyoptinterface as poi
from pyoptinterface import gurobi, quicksum


class PRM:
    # variable domain
    CONTINUOUS = poi.VariableDomain.Continuous
    BINARY = poi.VariableDomain.Binary
    INTEGER = poi.VariableDomain.Integer
    # constraint sense
    EQUAL = poi.ConstraintSense.Equal
    GREATER_EQUAL = poi.ConstraintSense.GreaterEqual
    LESS_EQUAL = poi.ConstraintSense.LessEqual
    # objective sense
    MINIMIZE = poi.ObjectiveSense.Minimize
    MAXIMIZE = poi.ObjectiveSense.Maximize


class Model:
    def __init__(self):
        self.model = gurobi.Model()
        self.var_dict = {}
        self.con_dict = {}

    def add_variables(self, *coords, lb=-float('inf'), ub=float('inf'), domain=PRM.CONTINUOUS, name=""):
        assert name not in self.var_dict
        variables = self.model.add_variables(*coords, lb=lb, ub=ub, domain=domain, name=name)
        self.var_dict[name] = variables
        return variables

    def add_linear_constraint(self, expr, sense, rhs, name=""):
        assert name not in self.con_dict
        linear_constraint = self.model.add_linear_constraint(expr, sense=sense, rhs=rhs, name=name)
        self.con_dict[name] = linear_constraint
        return linear_constraint

    def set_variable_bounds(self, var, lb=None, ub=None):
        if lb is not None:
            self.model.set_variable_attribute(var, poi.VariableAttribute.LowerBound, lb)
        if ub is not None:
            self.model.set_variable_attribute(var, poi.VariableAttribute.UpperBound, ub)

    def set_objective(self, expr, sense=PRM.MINIMIZE):
        if type(expr) in [int, float]:
            expr = quicksum([expr])
        self.model.set_objective(expr, sense)

    def optimize(self):
        self.model.optimize()
