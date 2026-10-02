# Web Agent 嵌入与调用标准说明

## 1. 系统定位

把本 Skill 放在“用户/Agent”和“数值后端”之间，不要把 SKILL.md 当成求解器。

```text
用户自然语言 / UI 配置
        ↓
Agent Planner
        ↓
RunSpec JSON
        ↓
Skill Validator / Capability Router
        ↓
Case + Profile + Resource Builder
        ↓
OptimizationBackend
        ↓
AC / Physical Validation
        ↓
ResultBundle
        ↓
Web 图表 + Agent 解释
```

## 2. 后端接入方式

### 方案 A：作为 Python 包调用

```python
from power_dispatch_skill.io import load_spec
from power_dispatch_skill.orchestrator import DispatchOrchestrator

spec = load_spec("examples/inputs/ieee14_acopf.yaml")
result = DispatchOrchestrator().run(spec)
```

### 方案 B：通过 FastAPI

```bash
uvicorn web.fastapi_app:app --host 0.0.0.0 --port 8000
```

核心 API：
- `GET /api/cases`
- `GET /api/backends`
- `POST /api/run/validate`
- `POST /api/run`
- `GET /api/result/{run_id}`

## 3. Agent 的工具定义

Agent 不直接调用 solver。Agent 只应：
1. 解析用户意图；
2. 生成 RunSpec；
3. 调 `/api/run/validate`；
4. 若有效，调用 `/api/run`；
5. 根据 ResultBundle 解释结果。

`web/agent_tool_contract.json` 可作为 Function Calling/MCP/自定义工具的字段参考。

## 4. Web 页面建议

- 左侧：自然语言需求 + 历史任务；
- 中间：算例/能力/时间尺度/PQ/资源/目标/约束配置；
- 右侧：RunSpec 高级编辑；
- 下方：运行步骤、solver status、KPI、PCC P/Q/V、电压、线路负载、SOC、目标分项、工况比较。

## 5. 主配微自由组合

UI 不要只放“主配微”一个开关，应拆成：

`网络层级 × 时间尺度 × P/Q × 资源 × 目标 × 算法 backend`

Agent 把用户自然语言转换成这些字段，再由兼容性校验器决定是否可运行。

## 6. 数值可信性

Web UI 必须显式展示：
- backend；
- solver；
- termination condition；
- model fidelity；
- AC validation；
- warnings；
- 结果是否来自 dry-run。

不要只展示“优化成功”。

## 7. 生产部署建议

- API 服务和求解任务分离；
- 每个 Run 使用独立工作目录/容器；
- 限制 CPU、内存、超时时间；
- 将 RunSpec、result、solver log 和输入数据版本一起归档；
- 长任务用队列/任务状态接口，不要阻塞 Web Worker；
- 商业求解器许可证通过服务器安全配置注入，不进入 Skill 包。

## 8. 新算法接入

只需实现：

```python
from power_dispatch_skill.backends.base import OptimizationBackend

class MyResearchBackend(OptimizationBackend):
    name = "my_research_backend"
    def run(self, spec, context):
        ...
        return result_dict
```

并注册：

```python
orchestrator.registry.register(MyResearchBackend())
```

Web API、Agent 提示词和 RunSpec 都无需改动。
