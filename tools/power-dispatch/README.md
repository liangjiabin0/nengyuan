# Power Dispatch Optimization Skill

一个面向电力系统优化运行、主配微多时间尺度有功/无功协同优化和能力自由组合的 Skill 工程包。

## 你可以把它理解成什么

它不是“某一个固定算法脚本”，而是 Web Agent 与数值优化引擎之间的**标准协议层 + 编排层**：

`用户自然语言 -> Agent -> RunSpec -> Skill Router -> Case/Scenario -> Optimization Backend -> AC Validation -> ResultBundle -> Web 图表/解释`

## 包内包含

- `SKILL.md`：Agent/Codex 的核心执行规则。
- `references/`：研究边界、算例、P/Q、多时间尺度、主配微、求解器、验收规范。
- `schemas/`：RunSpec 与 ResultBundle JSON Schema。
- `src/`：Python 可调用核心库。
- `scripts/`：CLI 入口、Schema 校验、运行、算例列表、组合算例生成。
- `web/`：FastAPI Agent/Run/Result 接口示例。
- `examples/inputs/`：IEEE 14/30/57/118、case33bw、主配微多时间尺度样例输入。
- `examples/profiles/`：24 h / 96 点负荷与光伏示例曲线。
- `tests/`：不依赖求解器的 smoke tests。
- `docs/`：Web Agent 集成说明与开发规范。

## 依赖层级

### 最小依赖（只做 Schema/Agent/接口联调）

```bash
pip install -r requirements-min.txt
```

### 完整参考执行环境

```bash
pip install -r requirements-full.txt
```

完整环境推荐额外安装一个可用求解器。Pyomo/求解器属于插件层；静态标准算例 OPF 可直接使用 pandapower 后端。

## 30 秒快速体验

```bash
python scripts/list_cases.py
python scripts/validate_spec.py examples/inputs/ieee14_acopf.yaml
python scripts/run_task.py examples/inputs/ieee14_acopf.yaml --dry-run
```

`--dry-run` 不执行数值求解，适合 Web 前后端先联调完整协议。

安装 pandapower 后：

```bash
python scripts/run_task.py examples/inputs/ieee14_acopf.yaml --output runs/ieee14
```

## 重要边界

1. `ieee14/30/57/118` 是标准测试网络标识。
2. `main_dist_micro_demo` 是**组合模板**，不是某个官方 IEEE 主配微标准算例。
3. LLM 不计算最优解；所有数值必须来自 backend。
4. 线性化/凸化/分解算法必须在结果中声明 fidelity，并按适用性执行 AC 回代校核。
5. 研究算法请实现 `OptimizationBackend`，无需改变 Web API。

详细说明见：`docs/WEB_AGENT_INTEGRATION.md` 和 `docs/WEB_AGENT_INTEGRATION.docx`。
