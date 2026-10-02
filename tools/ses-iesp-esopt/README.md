# openTEPES ESOPT 规划算例（ses_iesp_esopt）

用 ESOPT C++ API 调用 Gurobi，复现 `ses_iesp/` 中 Python openTEPES 的模块划分。数据按算例分目录存放，每个算例内部仍用 `sSEP` 作为 CSV 后缀。

## 算例一览

| 编号 | 名称 | 目录 | 说明 |
|------|------|------|------|
| case1 | 湖南微电网 | `case1/sSEP/` | 微电网规划，含热负荷与气象数据 |
| case2 | 河北微电网-变电站 | `case2/sSEP/` | 变电站尺度源网荷储 |
| case3 | 河北微电网-馈线 | `case3/sSEP/` | 馈线尺度，含最小出力曲线 |
| case4 | 河北微电网-台区 | `case4/sSEP/` | 台区尺度源网荷储 |
| case5 | 冀北-电热耦合 | `case5/sSEP/` | 电热耦合园区 |
| case6 | 电算热耦合 | `case6/sSEP/` | 电-算-热，打开 EV / 热 / 数据中心规划 |

`--case` 可写 `case1`…`case6`、`1`…`6`，或中文名称。默认 `case1`。

模块对应：

| Python | C++ |
|--------|-----|
| `openTEPES_Main.py` | `openTEPES_Main.cpp` |
| `openTEPES.py` | `openTEPES.cpp` |
| `openTEPES_InputData.py` | `openTEPES_InputData.cpp` |
| `openTEPES_ModelFormulation.py` | `openTEPES_ModelFormulation.cpp` |
| `openTEPES_ProblemSolving.py` | `openTEPES_ProblemSolving.cpp` |
| `openTEPES_OutputResults.py` | `openTEPES_OutputResults.cpp` |

输入输出读写该算例目录：`caseN/sSEP/oT_Data_*.csv` → `oT_Result_*.csv`。

## 编译

所有源码和 ESOPT SDK 都在项目目录中。以下命令从项目根运行；编译器和 CMake 仍属于系统级开发工具。

```powershell
$solver = Join-Path (Get-Location) 'tools\ses-iesp-esopt'
cmake -S $solver -B (Join-Path $solver 'build-local') -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=Release
cmake --build (Join-Path $solver 'build-local') -j
```

仓库已经包含经验证的 Windows x64 运行文件，通常不需要重新编译：

```powershell
tools\ses-iesp-esopt\run.cmd --case case1
```

可执行文件：`tools\ses-iesp-esopt\build\openTEPES_esopt.exe`。`run.cmd` 会根据自身位置传入算例根目录，项目移动到其他盘符后无需修改。

## 运行

```powershell
tools\ses-iesp-esopt\run.cmd --help

# 湖南微电网（默认）
tools\ses-iesp-esopt\run.cmd --case case1

# 河北：变电站 / 馈线 / 台区
tools\ses-iesp-esopt\run.cmd --case case2
tools\ses-iesp-esopt\run.cmd --case case3
tools\ses-iesp-esopt\run.cmd --case case4

# 冀北电热耦合
tools\ses-iesp-esopt\run.cmd --case case5

# 电算热耦合
tools\ses-iesp-esopt\run.cmd --case case6
```

也可用 `--case 1` … `--case 6`。`--dir` 指向 `ses_iesp_esopt` 根目录（默认已编译进程序，一般不用改）。

启动器默认从项目内 `tools\mgplan-venv` 寻找 Gurobi DLL；也可用环境变量 `SES_IESP_GUROBI_DLL` 显式覆盖。DLL 可随 Python 环境安装，但真实求解仍需要合法的 Gurobi 许可证。

求解参数：Method=2，MIPFocus=1，RINS=100，Crossover=-1，MIPGap=0.001，TimeLimit=36000。

查看参数：

```powershell
tools\ses-iesp-esopt\run.cmd --help
```
