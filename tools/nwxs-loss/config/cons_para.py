# 定义常量参数
# 线路长度，单位km
linelength_default = 0.1
linelength_unitfactor = 1

# 10kV线电压基准值，单位kV
Volbase = 10

# 基准容量，单位kVA
Sbase = 100

# 计算基准相电压，单位V
Ubase_low = 10.5 * 1000

# 中压侧阻抗基准值
Zbase = 5.77

# 单位kW，当馈线总负荷超过这个边界时，将负荷功率除以1000带入计算，损耗返回时对应乘1e6(此处表述有误，损耗不该乘1e6而应该是1e3)
load_boundary = 10000

# 线路电阻/Ω
Ra_disline = 0.01
Ra_disline_boundary = 7.39

# 线路电抗/Ω
Xa_disline = 0.012
Xa_disline_boundary = 12

# 变压器电阻/Ω
Ra_distrfm = 15
Ra_distrfm_boundary = 30

# 变压器电抗/Ω
Xa_distrfm = 0.5
Xa_distrfm_boundary = 10

# 变压器MVA
Mva_distrfm = 630
Mva_distrfm_boundary = 1500

# 表计损耗/kW，查标准得到，三相四线每月表计损耗约0.003MWh
loss_meter_3ph = 0.003 * 1000 / 30 / 24
loss_meter_1ph = 0.001 * 1000 / 30 / 24

p0 = 0.28
p0_boundary = 10

pk = 0.3
pk_boundary = 10

voltage_input_factor = 1000
voltage_output_factor = 1000
power_factor = 1000
current_factor = 1
loss_factor = 0.001

sensor_power_sigma = 40

sensor_branch_power_sigma = 1000

time_resolution_factor = 1  # 24点数据时为1，96点数据时为0.25，分钟级数据时为1/60
