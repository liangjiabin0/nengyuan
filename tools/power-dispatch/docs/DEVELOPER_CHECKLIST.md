# Developer Checklist

## Skill
- [ ] SKILL.md 被 Agent 运行时加载
- [ ] references 按任务类型按需加载
- [ ] RunSpec Schema 校验在求解前执行

## Backend
- [ ] 新 backend 继承 OptimizationBackend
- [ ] 声明 capability
- [ ] 不伪造 solver status
- [ ] 返回 model_fidelity
- [ ] 必要时返回 AC validation

## Web
- [ ] 用户可查看 Agent 生成的 RunSpec
- [ ] warnings 可见
- [ ] dry-run 与 numeric result 明确区分
- [ ] 结果可导出

## Scientific QA
- [ ] 标准 case 来源明确
- [ ] 组合 case 不冒充标准 IEEE 主配微 case
- [ ] P/Q 正负号统一
- [ ] 时间状态继承正确
- [ ] 多目标权重透明
