# ESOPT 接入与验收（2026-10-02）

已将用户指定仓库 https://github.com/yuntaoju2022/smart-energy-system 的 Linux SDK 接入 10.1.4.166 上的修复版能元系统。SDK 固定提交 `38d7df0e679d93da848e05f30327a4f2a56dc60b`，安装包 SHA256 为 `f19eebd9a9be971445581ed7bdc51d3ad752657ce1bfdfc8f29610b582ee6a03`。核心以预编译库提供，仓库未发现独立开源许可证，不能当作可自由再分发的完整开源求解器；本项目仅提交适配器源码与安装入口，不提交供应商二进制或许可证。

安装位置：`/data/ai4es-recovery-20261002/tools/esopt/upstream-linux`。环境为 Ubuntu22.04 x86_64、glibc2.35、GCC11.4。SDK 的 ESOPT/PSLP/TinyCC/OpenSSL3 动态依赖通过检查；另编译 HiGHS1.12.0，使用 nlohmann JSON3.12.0 解析输入，下载均有 SHA256 校验。服务器现有 Python 环境保留。

系统的 JSON 线性模型、增量建模、DCOPF 与 MCP 共用新的桥接，默认优先原生 ESOPT。未配置 ESOPT 许可证时，大于300变量或300约束的模型选择 highspy，并返回真实 `backend`、`engine` 和原因。显式 PSLP 或 `ESOPT_BACKEND=native` 不允许静默降级。已有 MPS/LP 文件保持直接 HiGHS 路径，并纠正返回的求解引擎名称。

|验收项目|结果|
|---|---|
|线性配餐模型|原生 ESOPT 最优值7.5|
|0/1背包模型|原生 ESOPT 最优值7，a=1、b=1、c=0|
|自由下界、区间约束|分别得最优值-2和3；区间约束在highspy路径也为3|
|不可行模型|状态8、不返回伪解|
|300/301变量及300/301约束边界|300使用原生，301使用highspy；强制原生301变量明确拒绝|
|24节点DCOPF|133变量、101约束，目标58448.6388；与原highspy路径一致，功率平衡误差小于1e-7|
|24节点PSLP|实际日志显示缩减至101变量、88约束，目标一致|
|500节点DCOPF|超过试用规模，明确使用highspy并求得最优解|
|系统TypeScript调用|JSON文件、增量建模、DCOPF原生调用通过；PSLP实际执行日志通过|
|系统服务与界面接口|已有管理员认证后/runtime返回200并显示原生引擎；Web/API健康200；退出测试会话|
|工程检查|typecheck、lint、Linux server bundle通过；可重复安装脚本与正式集成测试通过|

仍有限制：本次接口暴露线性LP/MIP/DCOPF及PSLP；二次/非线性和其他商业求解器尚未接入。完整ESOPT许可证需要向作者申请，配置 `LICENSE_LOCATION`，许可证文件存在不能证明有效，仍由SDK验证。Gurobi完整许可证也仍需另行提供；本次不会替换MGPlan的Gurobi求解配置。未运行所有科研长流程，也没有将上述小模型验收描述为完整生产业务验收。

安装和后端选择方法见 [ESOPT说明](../tools/esopt/README.md)。代码变更并入原修复分支与同一个草稿PR，服务器原部署和先前完整备份保留。
