import os


def _isv_config():
    name = os.environ.get("MGPLAN_GUROBI_ISV_NAME", "").strip()
    app = os.environ.get("MGPLAN_GUROBI_ISV_APP", "").strip()
    key = os.environ.get("MGPLAN_GUROBI_ISV_KEY", "").strip()
    if not (name and app and key):
        return {}
    expiration = int(os.environ.get("MGPLAN_GUROBI_ISV_EXPIRATION", "0") or 0)
    return {
        "GURO_PAR_ISVNAME": name,
        "GURO_PAR_ISVAPPNAME": app,
        "GURO_PAR_ISVEXPIRATION": expiration,
        "GURO_PAR_ISVKEY": key,
    }


def poi_gurobi_model(output_flag=True):
    from pyoptinterface import gurobi
    gurobi_env = gurobi.Env(empty=True)
    gurobi_env.set_raw_parameter_int('OutputFlag', 1 if output_flag else 0)
    for key, value in _isv_config().items():
        if isinstance(value, int):
            gurobi_env.set_raw_parameter_int(key, value)
        elif isinstance(value, str):
            gurobi_env.set_raw_parameter_string(key, value)
    gurobi_env.start()
    model = gurobi.Model(gurobi_env)
    return model

def pyomo_gurobi_solver(name:str="gurobi_direct"):
    import pyomo.environ as pyo
    solver = pyo.SolverFactory(name, manage_env=True, options=_isv_config())
    return solver

def gurobipy_model():
    import gurobipy as gp
    env = gp.Env(empty=True)
    for key, value in _isv_config().items():
        env.setParam(key, value)
    env.start()
    model = gp.Model(env=env)
    return model
