# 合并版修复后的部署约定

现有服务器应先备份 PostgreSQL、storage、环境和实际数据，再部署新版本。不要用 bootstrap 重建或重置既有数据库角色；bootstrap 仅在角色不存在时要求显式强密码。API 默认仅监听127.0.0.1，所有用户包括 localhost 都必须通过真实会话登录。

首次建库须配置至少12位 DEFAULT_ADMIN_PASSWORD。缺失时启动明确失败，不生成默认弱密码。已有用户和密码保持不变。

Linux 以 scripts/linux/intranet-start.sh prod 管理 Web/API/Worker；Windows 用 scripts/intranet-start.ps1。PM2是另选的部署策略，并非本项目必装依赖；不得同时启动两套管理器争抢同一端口。

生产构建包含网页、healthz和DataV数据路由；API由Hono独立运行。大屏通过全局DatavScreenHost显示，不能仅依据screen/page.tsx是空容器断言缺少大屏组件。

DataV地图资源通过public/datav/geo缓存，使用当前访问源的绝对URL返回给DataV重定向处理器，避免局域网浏览器直接访问外部地图API的403。来源清单在该目录README。其他组件脚本仍依赖公开CDN，不是完整离线部署。

后台/api/jobs接口是管理员管理入口；普通用户仍使用各业务模块的项目状态接口。未知任务返回404。

## 数据与非Git资源

dataRootDir由storage/settings.json优先决定，DATA_ROOT_DIR仅作未设置时的后备。Linux不能沿用Windows磁盘路径。现有服务器实际数据在/data/ai4es/数据；迁移时还需检查数据库内的文件路径映射。

Git未包含商业求解器二进制、许可证、Mapbox token、预测权重和部分案例。可以从可信旧部署执行scripts/restore-runtime-assets.py恢复模型/案例/二进制并生成SHA256清单；该脚本不复制密钥、环境或数据库。Windows exe/dll不能直接视为Linux原生求解能力。Linux ESOPT原生SDK可通过 tools/esopt/native/install-linux.sh 安装，已在Ubuntu22.04验证LP/MIP/DCOPF及PSLP；未授权限300变量/约束，大模型可使用highspy。详见 tools/esopt/README.md，完整ESOPT许可证与Gurobi许可证分别申请。

SQLite迁移入口已补回：默认只检查来源表和目标兼容性，--apply仅允许目标为空且列均匹配。未知旧版结构须先做显式映射，不能静默丢弃列或覆盖生产库。当前服务器已使用PostgreSQL，无需重新做SQLite迁移。

## 工具和许可证

标准工具环境以Python3.12为基准；TDMG使用固定NumPy/SciPy/PYPOWER版本。MGPlan解析器同时支持Linux bin/python和Windows Scripts/python.exe。

用户提供的gurobipy GPU轮子是CPython3.11 Linux x86_64 CUDA12.9版本，安装到单独的Python3.11环境，避免覆盖原Python3.12。完整许可证由用户重新注册后配置GRB_LICENSE_FILE或WLS。安装库或轮子不等于获得完整许可证，不使用来源不明的旧ISV授权参数。

PPT配音的baseURL与工作空间配置现已贯通客户端，显式空值不会回退旧账号工作空间。服务器已通过用户提供的CSV在私有配置中更新key、Workspace ID与专属域名；短音频合成、系统上传一页PPT、配音嵌入和MP4导出均成功。未将CSV或key提交到Git。CosyVoice v3.5系列须使用该模型专属设计/复刻音色，不能假定v3系统音色能跨模型使用。

两种PPT技能使用仓库tools/ppt-native构建原生可编辑对象，保留用户提供的参考模板与提示词。MathJax公式离线生成并保留LaTeX；公式修改入口跨平台，不依赖PowerPoint COM。严格模板继承和复杂布局仍须按实际论文设计并渲染检查。artifact-tool专用版本是可选的外部环境入口。

## 验证入口

可执行npm run typecheck、lint、bundle:server、build、test:api-routes、portable:audit。test:recovery和test:patent:core使用独立测试数据库，禁止指向生产库。npm中的35个过时缺失入口已移除并记在scripts/retired-commands.json；不是把未执行测试伪造为通过。

共享storage通过symlink连接到旧部署数据，预览校验比较实际物理路径，允许共享资源，同时拒绝通过子目录symlink越出授权根。验证入口：`node --import tsx scripts/test-storage-paths.ts`。

本次服务器发布目录 `/data/ai4es-recovery-20261002`，systemd user服务 `ai4es.service` 通过drop-in切换工作目录；原 `/data/ai4es` 保留。数据库、storage、环境和旧systemd配置备份位于 `/data/ai4es-backup-20261002`。路径映射修改了PostgreSQL，不应只回退程序就宣称数据库也回退；需要数据库回退时先停止写入并明确选择备份，避免覆盖发布后的新记录。
