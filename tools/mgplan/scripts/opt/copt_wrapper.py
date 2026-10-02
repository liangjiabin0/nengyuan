from coptpy import COPT, quicksum
import coptpy as cp


class PRM:
    # variable domain
    CONTINUOUS = COPT.CONTINUOUS
    BINARY = COPT.BINARY
    INTEGER = COPT.INTEGER
    # constraint sense
    EQUAL = COPT.EQUAL
    GREATER_EQUAL = COPT.GREATER_EQUAL
    LESS_EQUAL = COPT.LESS_EQUAL
    # objective sense
    MINIMIZE = COPT.MINIMIZE
    MAXIMIZE = COPT.MAXIMIZE


class Model:
    def __init__(self):
        env = cp.Envr()
        self.model = env.createModel()
        self.var_dict = {}
        self.con_dict = {}

    def add_variables(self, *coords, lb=-float('inf'), ub=float('inf'), domain=PRM.CONTINUOUS, name=""):
        assert name not in self.var_dict
        new_coords = tuple(list(i if type(i) in [int, float, str] else repr(i) for i in coord) for coord in coords)
        variables = self.model.addVars(*new_coords, lb=lb, ub=ub, vtype=domain, nameprefix=name)
        variables = TupledictWrapper(variables)
        self.var_dict[name] = variables
        return variables

    def add_linear_constraint(self, expr, sense, rhs, name=""):
        assert name not in self.con_dict
        linear_constraint = self.model.addConstr(expr, sense=sense, rhs=rhs, name=name)
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
        self.model.solve()


class TupledictWrapper:
    # the tupledict of copt only supports int/float/str indexing
    def __init__(self, tupledict):
        self.tupledict = tupledict

    def __getitem__(self, key):
        if type(key) is tuple:
            return self.tupledict.__getitem__(tuple(i if type(i) in [int, float, str] else repr(i) for i in key))
        else:
            return self.tupledict.__getitem__(key if type(key) in [int, float, str] else repr(key))

    def __setitem__(self, key, value):
        if type(key) is tuple:
            self.tupledict.__setitem__(tuple(i if type(i) in [int, float, str] else repr(i) for i in key), value)
        else:
            self.tupledict.__setitem__(key if type(key) in [int, float, str] else repr(key), value)
