import type { SchemeProblemClass } from '@/lib/scheme-solve/types';

export const VIRTUAL_SIM_API_BASE = '/api/virtual-sim';
export const VIRTUAL_SIM_TOOL_STORAGE_KEY = 'virtual-sim-tool';
export const VIRTUAL_SIM_CAPABILITY_STORAGE_KEY = 'virtual-sim-capability';

export type VirtualSimToolId = SchemeProblemClass;

export type VirtualSimTool = {
  id: VirtualSimToolId;
  label: string;
  shortLabel: string;
  engine: string;
  skill: string;
  description: string;
  prompt: string;
  starters: Array<{ label: string; value: string }>;
  defaults: {
    decisions: string;
    limits: string;
    goal: string;
    caseHint?: string;
    whySolvable: string;
  };
};

export type VirtualSimCapabilityGroupId = 'forecast' | 'dispatch' | 'acopf' | 'loss' | 'modelica' | 'esopt';

export type VirtualSimCapabilityId =
  | 'pv'
  | 'wind'
  | 'load'
  | 'energy'
  | 'dispatch'
  | 'acopf'
  | 'loss'
  | 'modelica'
  | 'dcopf'
  | 'lp'
  | 'mip';

export type VirtualSimCapability = {
  id: VirtualSimCapabilityId;
  groupId: VirtualSimCapabilityGroupId;
  toolId: VirtualSimToolId;
  label: string;
  shortLabel: string;
  engine: string;
  integration: string;
  method: string;
  description: string;
  fidelity?: string;
  boundary?: string;
  prompt: string;
  starters: Array<{ label: string; value: string }>;
};

export const VIRTUAL_SIM_CAPABILITY_GROUPS: Array<{
  id: VirtualSimCapabilityGroupId;
  label: string;
  description: string;
}> = [
  { id: 'forecast', label: '源荷预测', description: '光伏、风电、负荷与 ERCOT 电量预测' },
  { id: 'dispatch', label: '优化调度', description: 'RunSpec / ResultBundle 调度求解' },
  { id: 'acopf', label: '交流潮流', description: 'AC-OPF 与主配微协同' },
  { id: 'loss', label: '理论线损', description: '南网方法 04 与标准结果表' },
  { id: 'modelica', label: 'Modelica', description: '物理系统动态仿真' },
  { id: 'esopt', label: 'ESOPT', description: 'DCOPF、LP 与 MIP' }
];

export const VIRTUAL_SIM_TOOLS: VirtualSimTool[] = [
  {
    id: 'modelica',
    label: 'Modelica 动态仿真',
    shortLabel: 'Modelica',
    engine: 'OpenModelica',
    skill: 'modelica-standard-style',
    description: '按 Modelica Standard Library 风格建模，经 OpenModelica 网关做 checkModel 与动态仿真，输出时序曲线。',
    prompt: '描述要仿真的物理系统、参数与观察量…',
    starters: [
      {
        label: '电池 SOC 放电一小时',
        value: '建立电池荷电状态模型：额定能量 100 kWh，初始 SOC=0.8，以 20 kW 恒功率放电 1 小时，输出 time 与 SOC 曲线。'
      },
      {
        label: 'RC 串联电路',
        value: '用 Modelica 标准库风格建立 RC 串联电路，观察电容电压与电流的动态响应，仿真 1 秒。'
      }
    ],
    defaults: {
      decisions: '模型结构、参数与输出变量',
      limits: '单位、初值与仿真区间需自洽',
      goal: 'checkModel 通过并得到时序曲线',
      whySolvable: '走 OpenModelica 仿真网关，遵循 Modelica Standard Library 风格。'
    }
  },
  {
    id: 'mgplan',
    label: '多能系统规划',
    shortLabel: '多能规划',
    engine: 'openTEPES',
    skill: 'mgplan-calculation',
    description: '源网荷储投资与 8760 运行模拟，输出成本、投资、储能与网损等规划结果。本机没有 Gurobi 时会失败并说明原因，不会用样例冒充最优。',
    prompt: '描述微网规划范围、投资对象与目标…',
    starters: [
      {
        label: '三节点微网 sSEP',
        value: '对三节点微网做源网荷储规划：电源与储能投资、8760 运行模拟、购售电与弃电成本，用 openTEPES 求最小综合成本。'
      }
    ],
    defaults: {
      decisions: '电源与储能投资容量、运行策略',
      limits: '负荷平衡、网络与设备容量',
      goal: '最小化综合规划成本',
      caseHint: 'sSEP',
      whySolvable: '走 openTEPES 多能规划（sSEP 算例）。'
    }
  },
  {
    id: 'acopf',
    label: '交流最优潮流 / 主配微协同',
    shortLabel: 'AC-OPF',
    engine: 'TDMG / PYPOWER',
    skill: 'tdmg-acopf-dispatch',
    description: 'IEEE/MATPOWER 交流最优潮流，支持主配微模块化组合与多时段情景。',
    prompt: '描述电网范围、目标与约束…',
    starters: [
      {
        label: 'IEEE 9 节点',
        value: '对 IEEE 9 节点系统做交流最优潮流，最小化发电成本并满足电压与线路极限。'
      },
      {
        label: 'IEEE 39 节点',
        value: '对 IEEE 39 节点系统做交流最优潮流，最小化发电成本，校核电压与支路潮流。'
      }
    ],
    defaults: {
      decisions: '各机组有功/无功出力',
      limits: '节点电压、线路极限与功率平衡',
      goal: '最小化发电成本',
      caseHint: 'case9',
      whySolvable: '走 TDMG / PYPOWER 交流最优潮流。'
    }
  },
  {
    id: 'dispatch',
    label: '优化调度',
    shortLabel: '优化调度',
    engine: 'power-dispatch',
    skill: 'power-dispatch-optimization',
    description: '把运行意图落成 RunSpec，再交给 pandapower/Pyomo 做日前/日内或资源调度。',
    prompt: '描述调度周期、资源与目标…',
    starters: [
      {
        label: 'IEEE 14 节点日前调度',
        value: '对 IEEE 14 节点系统做日前优化调度：含常规机组与负荷曲线，最小化发电成本并满足潮流与备用约束。'
      }
    ],
    defaults: {
      decisions: '各时段机组出力与储能充放',
      limits: '爬坡、备用、网络与 SOC',
      goal: '最小化调度运行成本',
      caseHint: 'ieee14',
      whySolvable: '走电力系统优化调度 Skill（RunSpec + pandapower/Pyomo）。本工具没有 IEEE 9 日前模板，请用 IEEE 14/30/33 或上传 RunSpec。'
    }
  },
  {
    id: 'loss',
    label: '理论线损',
    shortLabel: '理论线损',
    engine: 'nwxs-loss',
    skill: 'nwxs-theoretical-loss-calculation',
    description: '南网配网馈线理论线损计算，输出线损率、损耗分布与结果表。未上传含 dms_def_feeder 的馈线 JSON 时，会明确使用样例馈线，不会冒充你的数据。',
    prompt: '描述馈线范围，或上传含 dms_def_feeder 的馈线 JSON…',
    starters: [
      {
        label: '样例馈线理论线损',
        value: '用系统自带的样例馈线计算理论线损：统计线路损耗、变压器损耗与线损率，并给出分时结果表。请在结果里标明这是样例馈线，不是我上传的数据。'
      }
    ],
    defaults: {
      decisions: '计算时段与方法（默认方法 04）',
      limits: '需要完整拓扑、设备参数与运行数据',
      goal: '给出线损率与损耗分布',
      whySolvable: '走南网理论线损计算（17 张结果表）。'
    }
  },
  {
    id: 'forecast',
    label: '源荷预测',
    shortLabel: '源荷预测',
    engine: 'pv-wind-load-forecast',
    skill: 'pv-wind-load-forecast',
    description: '光伏、风电、负荷或 ERCOT 电量预测。输出曲线、MAE/RMSE/MAPE/SMAPE 与可回灌调度的 dispatch-profile.csv。',
    prompt: '描述预测对象、模型、步长与数据来源…',
    starters: [
      {
        label: '未来 24 小时光伏',
        value: '预测未来 24 小时光伏出力，使用 PVDAQ 多特征 LSTM 论文实现，输出预测曲线与误差指标。'
      },
      {
        label: '未来 24 小时风电',
        value: '预测未来 24 小时风电出力，使用风机多特征 LSTM，优先加载现成 hdf5 权重，输出曲线与误差。'
      },
      {
        label: '未来 24 小时负荷 V3',
        value: '预测未来 24 小时系统负荷，使用多特征负荷 V3（若干历史时刻的功率、温度、湿度、风速）。'
      },
      {
        label: '德州电量日前预测',
        value: '对 ERCOT 电量做日前 24 小时预测，使用德州论文的 Conv1D + 双向 LSTM/GRU 网络，并合并天气。'
      }
    ],
    defaults: {
      decisions: '预测对象、模型与步长',
      limits: '历史曲线长度与缺失值处理',
      goal: '给出可用的预测曲线与指标',
      whySolvable: '走光伏/风电/负荷预测建模。'
    }
  },
  {
    id: 'dcopf',
    label: '直流最优潮流',
    shortLabel: 'DCOPF',
    engine: 'ESOPT / HiGHS',
    skill: 'esopt',
    description: '标准电网算例或自定义直流最优潮流，最小化发电成本并满足线路极限。',
    prompt: '描述电网算例或自定义 DCOPF…',
    starters: [
      {
        label: 'IEEE 24 节点',
        value: '对 IEEE/PGLib 24 节点系统做直流最优潮流，最小化发电成本并满足负荷与线路极限。'
      }
    ],
    defaults: {
      decisions: '各机组有功出力',
      limits: '节点功率平衡与线路极限',
      goal: '最小化发电成本',
      caseHint: 'case24',
      whySolvable: '走 ESOPT 直流最优潮流。'
    }
  },
  {
    id: 'lp',
    label: '线性规划',
    shortLabel: '线性规划',
    engine: 'ESOPT / HiGHS',
    skill: 'esopt',
    description: '自定义线性规划：变量、约束与目标一次性交给 ESOPT 求解；也可直接上传 .mps / .lp 由 HiGHS 读取。',
    prompt: '描述决策变量、约束与目标，或上传 MPS/LP…',
    starters: [
      {
        label: '最小成本配料',
        value: '在营养与预算约束下选择食物配比，建立线性规划并求最小成本。'
      },
      {
        label: '求解上传的 MPS',
        value: '请用 ESOPT / HiGHS 直接求解附件中的 MPS 线性规划模型，不要改写成配料或背包例题，返回求解状态与目标值。'
      }
    ],
    defaults: {
      decisions: '连续决策变量',
      limits: '线性等式/不等式约束',
      goal: '最小化或最大化线性目标',
      whySolvable: '走 ESOPT 线性规划。'
    }
  },
  {
    id: 'mip',
    label: '混合整数规划',
    shortLabel: '整数规划',
    engine: 'ESOPT / HiGHS',
    skill: 'esopt',
    description: '含 0-1 / 整数变量的投资、组合或选址问题，由 ESOPT 求最优；也可上传 .mps / .lp。',
    prompt: '描述整数决策、容量上限与目标…',
    starters: [
      {
        label: '背包式投资组合',
        value: '在容量/资金上限下选择若干项目或设备，建立 0-1 规划使收益最大。'
      }
    ],
    defaults: {
      decisions: '整数/0-1 选择变量',
      limits: '容量、资金或逻辑约束',
      goal: '最大化收益或最小化成本',
      whySolvable: '走 ESOPT 混合整数规划。'
    }
  }
];

export const VIRTUAL_SIM_CAPABILITIES: VirtualSimCapability[] = [
  {
    id: 'pv',
    groupId: 'forecast',
    toolId: 'forecast',
    label: '光伏预测',
    shortLabel: '光伏',
    engine: 'pv-wind-load-forecast',
    integration: '论文复现已接入',
    method: '多特征 PVDAQ LSTM',
    description: '预测曲线与 MAE/RMSE/MAPE/SMAPE，可导出 CSV、PNG 和 dispatch-profile.csv。',
    fidelity: '论文兼容复现 / 适配实验 / 回退基线',
    prompt: '描述光伏数据、预测步长、特征与实验要求…',
    starters: [
      {
        label: 'PVDAQ LSTM · 24h',
        value: '使用 PVDAQ 多特征 LSTM 预测未来 24 小时光伏出力，输出预测曲线、MAE、RMSE、MAPE、SMAPE、CSV、PNG 和可回灌调度的 dispatch-profile.csv，并明确 fidelity。'
      }
    ]
  },
  {
    id: 'wind',
    groupId: 'forecast',
    toolId: 'forecast',
    label: '风电预测',
    shortLabel: '风电',
    engine: 'pv-wind-load-forecast',
    integration: '论文复现已接入',
    method: '多特征 LSTM / GRU / GAF-CNN',
    description: '探测仓库现成权重，必要时现场训练，输出预测曲线和误差指标。',
    fidelity: '论文兼容复现 / 适配实验 / 回退基线',
    boundary: '现场训练权重只标记为 trained，不表述为论文作者预训练权重。',
    prompt: '描述风机数据、LSTM/GRU/GAF-CNN、预测步长与训练要求…',
    starters: [
      {
        label: 'LSTM · 现成权重优先',
        value: '使用风机多特征 LSTM 预测未来 24 小时风电出力，优先探测仓库现成权重；若现场训练则明确 weightStatus=trained，不得称为论文作者预训练权重。输出曲线与 MAE、RMSE、MAPE、SMAPE。'
      },
      {
        label: 'GRU · 24h',
        value: '使用风机多特征 GRU 预测未来 24 小时风电出力，输出预测曲线、误差指标、权重状态和 fidelity。'
      },
      {
        label: 'GAF-CNN · 24h',
        value: '使用 GAF-CNN 预测未来 24 小时风电出力，输出预测曲线、误差指标、权重状态和 fidelity。'
      }
    ]
  },
  {
    id: 'load',
    groupId: 'forecast',
    toolId: 'forecast',
    label: '负荷预测',
    shortLabel: '负荷',
    engine: 'pv-wind-load-forecast',
    integration: '论文复现已接入',
    method: '多特征负荷 V1-V5',
    description: 'V1 上一时刻全特征；V2 功率加当前天气；V3 多步窗口；V4 季节；V5 季节加日/周/月周期。',
    fidelity: '论文兼容复现 / 适配实验 / 回退基线',
    prompt: '描述负荷数据、V1-V5、历史窗口与预测步长…',
    starters: [
      { label: 'V1 · 上一时刻全特征', value: '使用多特征负荷 V1 预测未来 24 小时负荷：输入上一时刻全特征，输出误差指标、预测曲线和调度回灌曲线。' },
      { label: 'V2 · 功率 + 当前天气', value: '使用多特征负荷 V2 预测未来 24 小时负荷：输入上一时刻功率和当前天气，输出误差指标、预测曲线和调度回灌曲线。' },
      { label: 'V3 · 多步历史窗口', value: '使用多特征负荷 V3 预测未来 24 小时负荷：输入多步历史功率与天气窗口，输出误差指标、预测曲线和调度回灌曲线。' },
      { label: 'V4 · 季节拆分', value: '使用多特征负荷 V4 按季节拆分后预测未来 24 小时负荷，输出误差指标、预测曲线和调度回灌曲线。' },
      { label: 'V5 · 季节 + 周期', value: '使用多特征负荷 V5，组合季节与日/周/月周期预测未来 24 小时负荷，输出误差指标、预测曲线和调度回灌曲线。' }
    ]
  },
  {
    id: 'energy',
    groupId: 'forecast',
    toolId: 'forecast',
    label: '电量 / ERCOT 预测',
    shortLabel: 'ERCOT',
    engine: 'pv-wind-load-forecast',
    integration: '论文复现已接入',
    method: 'Conv1D + 双向 LSTM/GRU + SimpleRNN',
    description: '使用 ERCOT 电量与 FST 天气特征，按明确的数据列与时间切分运行。',
    fidelity: '论文兼容复现 / 适配实验 / 回退基线',
    boundary: '必须明确数据集、目标列、天气来源和时间切分。',
    prompt: '描述 ERCOT 数据集、目标列、天气来源、时间切分与网络组合…',
    starters: [
      {
        label: 'ERCOT 日前 24h',
        value: '对 ERCOT 电量做日前 24 小时预测，使用 ERCOT 数据与 FST 天气特征，采用 Conv1D + 双向 LSTM/GRU + SimpleRNN 组合，并明确目标列、天气来源、时间切分、指标和 fidelity。'
      }
    ]
  },
  {
    id: 'dispatch',
    groupId: 'dispatch',
    toolId: 'dispatch',
    label: '优化调度',
    shortLabel: '调度',
    engine: 'power-dispatch-optimization-skill',
    integration: '虚拟仿真已接入 · 论文复现待开放',
    method: 'RunSpec / ResultBundle',
    description: 'IEEE 14/30/57/118、case33bw，支持日前/日内、多时间尺度、P/Q、储能与主配微组合。',
    boundary: 'C&CG、DRO、MPC、MARL 仅是可插拔研究 Backend 接口，不代表已实现。',
    prompt: '描述算例、调度周期、资源、目标与约束…',
    starters: [
      { label: 'IEEE 14 · 日前 24h', value: '对 IEEE 14 节点系统做日前 24 小时优化调度，使用 RunSpec/ResultBundle 协议，包含常规机组、负荷曲线与备用约束，最小化运行成本。' },
      { label: 'case33bw · P/Q 24h', value: '对 case33bw 做 24 小时 P/Q 协同调度，包含储能 SOC 与柔性负荷，输出 ResultBundle 和分时曲线。' }
    ]
  },
  {
    id: 'acopf',
    groupId: 'acopf',
    toolId: 'acopf',
    label: '交流最优潮流 / 主配微协同',
    shortLabel: 'AC-OPF',
    engine: 'tdmg-acopf-dispatch',
    integration: '虚拟仿真已接入 · 论文复现待开放',
    method: 'AC-OPF / P-Q 协同 / 多时段场景',
    description: 'IEEE/MATPOWER 算例，支持主网、配网、微网、储能 SOC、柔性负荷与边界等值。',
    boundary: '不支持完整 AC/DC 耦合、三相不平衡、机组组合、N-1 和全局随机/鲁棒联合优化。',
    prompt: '描述 IEEE/MATPOWER 算例、网络范围、目标与约束…',
    starters: [
      { label: 'IEEE 9 · 快照', value: '对 IEEE 9 节点系统做交流最优潮流快照，最小化发电成本并校核电压、无功与支路极限。' },
      { label: '主配微 · 多时段', value: '建立主网、配网、微网多时段协同 AC-OPF，包含储能 SOC、柔性负荷和边界等值，输出全部审计产物。' }
    ]
  },
  {
    id: 'loss',
    groupId: 'loss',
    toolId: 'loss',
    label: '南网理论线损',
    shortLabel: '线损',
    engine: 'nwxs-theoretical-loss-calculation',
    integration: '虚拟仿真已接入 · 论文复现待开放',
    method: '方法 04 / 多时间点 / 17 个标准结果表',
    description: '输入馈线 JSON，输出 Excel 汇总、4 张图、HTML 报告和标准结果表。',
    boundary: '论文复现必须使用用户实际馈线数据；样例结果只能标记 source=sample。',
    prompt: '上传实际馈线 JSON，并描述时点与方法…',
    starters: [
      { label: '方法 04 · 实际馈线', value: '使用我上传的实际馈线 JSON 按方法 04 计算理论线损，输出 17 个标准结果表、Excel 汇总、4 张图和 HTML 报告；不得用样例结果替代。' },
      { label: '样例 · 仅验证链路', value: '使用系统样例馈线验证理论线损计算链路，并在所有结果中明确标记 source=sample，不得表述为用户实际馈线结果。' }
    ]
  },
  {
    id: 'modelica',
    groupId: 'modelica',
    toolId: 'modelica',
    label: 'Modelica 动态仿真',
    shortLabel: 'Modelica',
    engine: 'OpenModelica',
    integration: '虚拟仿真已接入 · 论文复现待开放',
    method: 'checkModel + 动态仿真',
    description: '按 Modelica Standard Library 风格建立物理模型并输出时序曲线。',
    prompt: '描述物理系统、参数、初值、仿真区间与观察量…',
    starters: [
      { label: '电池 SOC · 1h', value: '建立电池荷电状态模型：额定能量 100 kWh，初始 SOC=0.8，以 20 kW 恒功率放电 1 小时，先运行 checkModel，再输出 time 与 SOC 曲线。' },
      { label: 'RC 串联电路 · 1s', value: '用 Modelica 标准库风格建立 RC 串联电路，先运行 checkModel，再仿真 1 秒并输出电容电压与电流动态响应。' }
    ]
  },
  {
    id: 'dcopf',
    groupId: 'esopt',
    toolId: 'dcopf',
    label: '直流最优潮流',
    shortLabel: 'DCOPF',
    engine: 'ESOPT / HiGHS',
    integration: '论文复现已接入',
    method: '标准算例 DCOPF',
    description: '最小化发电成本并满足节点功率平衡与线路极限。',
    prompt: '描述电网算例、负荷与线路约束…',
    starters: [
      { label: 'IEEE 24 · DCOPF', value: '使用 ESOPT / HiGHS 对 IEEE/PGLib 24 节点系统做直流最优潮流，最小化发电成本并满足负荷与线路极限。' }
    ]
  },
  {
    id: 'lp',
    groupId: 'esopt',
    toolId: 'lp',
    label: '线性规划',
    shortLabel: 'LP',
    engine: 'ESOPT / HiGHS',
    integration: '论文复现已接入',
    method: 'LP / MPS',
    description: '求解连续变量线性模型，支持直接上传 .mps / .lp。',
    prompt: '描述变量、线性约束与目标，或上传 MPS/LP…',
    starters: [
      { label: '上传 MPS / LP', value: '请用 ESOPT / HiGHS 直接求解附件中的 MPS 或 LP 线性规划模型，返回 termination_status、目标值与决策变量，不要改写成示例题。' }
    ]
  },
  {
    id: 'mip',
    groupId: 'esopt',
    toolId: 'mip',
    label: '混合整数规划',
    shortLabel: 'MIP',
    engine: 'ESOPT / HiGHS',
    integration: '论文复现已接入',
    method: 'MIP / 0-1 规划',
    description: '求解投资、组合、选址等整数或 0-1 决策问题。',
    prompt: '描述整数决策、逻辑约束与目标…',
    starters: [
      { label: '0-1 投资组合', value: '使用 ESOPT / HiGHS 建立 0-1 投资组合模型，在资金与容量约束下最大化收益，返回 termination_status、目标值与选择变量。' }
    ]
  }
];

const TOOL_MAP = new Map(VIRTUAL_SIM_TOOLS.map((item) => [item.id, item]));
const CAPABILITY_MAP = new Map(VIRTUAL_SIM_CAPABILITIES.map((item) => [item.id, item]));

export function isVirtualSimToolId(value: unknown): value is VirtualSimToolId {
  return typeof value === 'string' && TOOL_MAP.has(value as VirtualSimToolId);
}

export function getVirtualSimTool(id: string): VirtualSimTool {
  const tool = TOOL_MAP.get(id as VirtualSimToolId);
  if (!tool) throw new Error('未知的仿真工具。');
  return tool;
}

export function listVirtualSimTools() {
  return VIRTUAL_SIM_TOOLS;
}

export function isVirtualSimCapabilityId(value: unknown): value is VirtualSimCapabilityId {
  return typeof value === 'string' && CAPABILITY_MAP.has(value as VirtualSimCapabilityId);
}

export function getVirtualSimCapability(id: string): VirtualSimCapability {
  const capability = CAPABILITY_MAP.get(id as VirtualSimCapabilityId);
  if (!capability) throw new Error('未知的仿真能力。');
  return capability;
}

export function listVirtualSimCapabilities(groupId?: VirtualSimCapabilityGroupId) {
  return groupId
    ? VIRTUAL_SIM_CAPABILITIES.filter((item) => item.groupId === groupId)
    : VIRTUAL_SIM_CAPABILITIES;
}

export function defaultCapabilityForTool(toolId: VirtualSimToolId): VirtualSimCapabilityId {
  if (toolId === 'forecast') return 'pv';
  if (toolId === 'dispatch' || toolId === 'acopf' || toolId === 'loss' || toolId === 'modelica' || toolId === 'dcopf' || toolId === 'lp' || toolId === 'mip') {
    return toolId;
  }
  return 'pv';
}

export type VirtualSimRouting = {
  capabilityId: VirtualSimCapabilityId;
  toolId: VirtualSimToolId;
  confidence: 'high' | 'medium' | 'default';
  reason: string;
};

type RoutingScore = {
  score: number;
  reason: string;
};

const ROUTING_PRIORITY: VirtualSimCapabilityId[] = [
  'energy',
  'wind',
  'load',
  'pv',
  'loss',
  'modelica',
  'acopf',
  'dcopf',
  'mip',
  'lp',
  'dispatch'
];

/** Resolve a natural-language task and its attachment names to one executable experiment. */
export function inferVirtualSimRouting(
  prompt: string,
  fileNames: string[] = [],
  toolHint?: VirtualSimToolId
): VirtualSimRouting {
  if (toolHint && toolHint !== 'forecast') {
    const capabilityId = defaultCapabilityForTool(toolHint);
    return {
      capabilityId,
      toolId: toolHint,
      confidence: 'high',
      reason: '沿用已有任务的实际求解 Backend'
    };
  }

  const text = `${prompt} ${fileNames.join(' ')}`.toLowerCase().replace(/[_-]+/g, ' ');
  const scores = new Map<VirtualSimCapabilityId, RoutingScore>();

  const add = (id: VirtualSimCapabilityId, points: number, reason: string) => {
    const current = scores.get(id);
    if (!current || points > current.score) scores.set(id, { score: points, reason });
  };
  const match = (id: VirtualSimCapabilityId, pattern: RegExp, points: number, reason: string) => {
    if (pattern.test(text)) add(id, points, reason);
  };

  match('energy', /ercot|texas|德州|电量预测|能源需求预测|双向\s*(lstm|gru)|simplernn/, 12, '识别到 ERCOT / 电量预测特征');
  match('wind', /风电预测|风功率预测|风机.*预测|wind\s*(power\s*)?forecast|gaf\s*cnn/, 11, '识别到风电预测特征');
  match('load', /负荷预测|用电负荷.*预测|load\s*forecast|\bv\s*[1-5]\b|季节.*日.*周.*月/, 11, '识别到负荷预测特征');
  match('pv', /光伏预测|光伏.*(lstm|预测)|pvdaq|solar\s*(power\s*)?forecast|辐照度.*预测/, 11, '识别到光伏预测特征');
  match('loss', /理论线损|线损|方法\s*0?4|dms\s*def\s*feeder|馈线.*(损耗|计算)/, 12, '识别到馈线线损计算特征');
  match('modelica', /modelica|openmodelica|checkmodel|动态仿真|rc\s*(串联)?电路|电容电压|物理系统.*仿真|荷电状态模型|恒功率放电.*小时|time.*soc.*曲线/, 12, '识别到 Modelica 动态仿真特征');
  match('acopf', /ac\s*opf|交流最优潮流|主配微|pypower|无功优化/, 12, '识别到 AC-OPF / 主配微特征');
  match('dcopf', /dc\s*opf|直流最优潮流|pglib/, 12, '识别到 DCOPF 特征');
  match('mip', /混合整数|整数规划|0\s*1\s*规划|mixed\s*integer|\bmip\b|背包|选址/, 11, '识别到整数决策特征');
  match('lp', /线性规划|linear\s*program|\.mps\b|\.lp\b|\bmps\b/, 10, '识别到 LP / MPS 特征');
  match('lp', /\besopt\b/, 5, '识别到 ESOPT 求解请求');
  match('dispatch', /优化调度|日前调度|日内调度|多时间尺度|p\s*\/\s*q\s*协同调度|储能.*调度|economic\s*dispatch|unit\s*commitment/, 10, '识别到优化调度特征');

  if (fileNames.some((name) => /\.mo$/i.test(name))) add('modelica', 20, '附件为 Modelica 模型');
  if (fileNames.some((name) => /\.(mps|lp)$/i.test(name))) {
    const integerIntent = /混合整数|整数规划|0\s*1|binary|mixed\s*integer|\bmip\b/.test(text);
    add(integerIntent ? 'mip' : 'lp', 20, `附件为 ${integerIntent ? 'MIP' : 'LP'} 模型`);
  }
  if (fileNames.some((name) => /(?:feeder|馈线|线损)/i.test(name) && /\.json$/i.test(name))) {
    add('loss', 20, '附件为馈线 JSON');
  }

  const ranked = ROUTING_PRIORITY
    .map((id) => ({ id, ...(scores.get(id) || { score: 0, reason: '' }) }))
    .sort((left, right) => right.score - left.score || ROUTING_PRIORITY.indexOf(left.id) - ROUTING_PRIORITY.indexOf(right.id));
  const winner = ranked[0];
  const capabilityId = winner.score > 0 ? winner.id : toolHint ? defaultCapabilityForTool(toolHint) : 'dispatch';
  const capability = getVirtualSimCapability(capabilityId);

  return {
    capabilityId,
    toolId: capability.toolId,
    confidence: winner.score >= 11 ? 'high' : winner.score > 0 ? 'medium' : 'default',
    reason: winner.reason || '未出现明确类型关键词，按通用优化调度处理'
  };
}
