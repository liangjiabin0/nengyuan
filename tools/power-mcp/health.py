"""Read-only component probe; each process is independently bounded by its caller."""

import importlib
import importlib.metadata
import json
import sys

name = sys.argv[1]
try:
    version = importlib.metadata.version(name)
    module = importlib.import_module(name)
    if name == "powermcp":
        from powermcp.registry import get_tool

        for engine in ["pandapower", "pypsa", "andes"]:
            if not get_tool(engine).resolve_entry_script().is_file():
                raise RuntimeError(engine + " MCP 入口缺失")
    if name == "powerio":
        for api in ["parse", "emit", "serialize", "diagnostic_records"]:
            if not callable(getattr(module, api, None)):
                raise RuntimeError(api + " 接口缺失")
    if name == "pypsa":
        import highspy

        if "HiGHS" not in str(type(highspy.Highs())) and not highspy.Highs().version():
            raise RuntimeError("HiGHS 不可用")
    print(json.dumps(dict(component=name, status="available", version=version)))
except Exception:
    print(
        json.dumps(
            dict(
                component=name,
                status="unavailable",
                version=None,
                error="组件导入或依赖检查失败，请查看部署日志",
            )
        )
    )
    sys.exit(1)
