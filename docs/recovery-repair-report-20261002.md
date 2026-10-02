# 能元合并版修复与部署结果

日期：2026-10-02。修复分支 `fix/recovery-20261002`，起点 `5f62b0b`。修复版已切换到10.1.4.166服务器，Web/API/Worker均从 `/data/ai4es-recovery-20261002` 运行。原部署目录保留，完整PostgreSQL/storage/环境备份位于 `/data/ai4es-backup-20261002`，pg_restore目录读取验证通过。

## 原23项问题逐项处理

|序号|问题|修复状态与验证|
|---|---|---|
|1|Linux脚本CRLF|修复：LF归档与.gitattributes；全部Shell语法检查通过|
|2|伪造Host触发管理员免登录|修复：取消旁路，含登录页面自动跳转；真实API和Web伪造Host不能认证|
|3|bootstrap重置数据库密码/API暴露|修复：保留现有角色密码，新角色须强密码；API实际仅监听127.0.0.1:4000|
|4|默认弱管理员口令|修复：移除弱默认，新管理员首次创建强制至少12位；原账号登录200|
|5|专利任务领取COALESCE类型冲突|修复：明确timestamp转换为text；PostgreSQL专利核心测试通过|
|6|专利错误更新参数类型不明|修复：参数显式text类型；同上|
|7|后台任务查询缺少await|修复：查询正确序列化，未知任务404；实际PostgreSQL回归通过|
|8|普通用户可查询所有后台任务|修复：管理接口requireAdmin；未登录401、普通用户403、管理员200|
|9|数据根目录和数据库Windows路径|修复：实际数据根/data/ai4es/数据，6个数据库路径列Windows值均为0；论文PDF和导师预览200|
|10|Linux TDMG内置算例路径|修复：平台包目录解析并与MGPlan GPU环境隔离；工具engine/vendor均true|
|11|MGPlan Linux Python选择错误|修复：支持bin/python并指定独立Python3.11 GPU环境；engine/gurobi均true|
|12|完整Gurobi许可证|待用户：已装gurobipy13.0.2+cu129和依赖，pip check通过，仍restricted；用户正在重新注册授权，未使用旧ISV参数|
|13|百炼拒绝PPT配音|修复：用户新CSV的key、Workspace ID、域名写入私有配置；短音频与真实系统PPTX/MP4流程成功|
|14|baseURL未生效/空空间回退|修复：TS到Python真实客户端贯通；显式空值回归通过；旧个人空间默认已移除|
|15|DataV生产路由遗漏|修复：三个路由构建并保护，登录后均200；地图JSON改为本地缓存、重定向使用当前访问源的绝对URL，南海图片使用已有静态资源，真实浏览器资源失败数0。更正原审计：screen空容器由全局DatavScreenHost显示大屏，不是组件缺失|
|16|原生求解资源/案例/Mapbox|部分修复：从可信旧部署恢复97项模型/案例/二进制资源，并私下恢复Mapbox token，实际服务验证200；Linux高级ESOPT仍缺供应商Linux SDK，Windows EXE不能充当Linux能力|
|17|预测预训练权重|恢复旧部署现存hdf5/keras资源并记录哈希；未做真实验证集精度验收，不声称预测结果与原版相同|
|18|两页PPT依赖外部Codex运行时|修复：接入用户两种技能及4个真实论文参考PPT；PptxGenJS/MathJax离线构建与跨平台公式修改、LibreOffice渲染通过|
|19|38个缺失npm脚本|修复：补回路由审计、可移植审计、SQLite迁移；移除35个过时入口并记录清单，不伪造未执行测试|
|20|lint与回归失败|修复：lint/typecheck、专利核心、DOCX数学专项均通过；同步更新测试适配实际异步数据库和OMML样式|
|21|依赖未声明/PM2策略|修复：直接声明jszip/esbuild/mathjax-full等；实际使用systemd启动器，移除未安装的PM2命令，PM2配置仅保留可选|
|22|npm公告漏洞|修复：适配更新Next/Hono/csv-parse及传递依赖；官方registry npm audit为0|
|23|OpenAlex内置免费key误导|修复：说明须提供自己的key；现有配置未改写或提交|

## 补充修复和恢复

- 数据库路径映射核对后发现181个物理文件缺失。从用户先前授权的F:\数据找回全部181个文件，SHA1与数据库记录一致。111个超Linux文件名长度限制的导师文件改为短文件名并保留映射，其余70个为PDF。最终迁移前缺失数0，没有覆盖原有数据文件。
- 共享storage的实际路径与发布目录别名不同，导致转换PDF预览被拒绝。修复为比较物理路径；回归同时证明共享路径可访问，子目录symlink越出授权根被拒绝。
- 两个PPT运行技能目录切换到修复版，保留旧技能备份，其余用户自定义技能保留；脚本从AI4ES_PROJECT_ROOT/cwd/祖先目录寻找运行时，避免materialize后的相对路径错误。
- 原12个Python环境及新增GPU环境依赖版本快照在runtime/python-locks；这些是已验证环境快照，不是跨平台重装承诺。

## 实际验证

Windows源码：npm ci、typecheck、lint、bundle:server、build、API注册107模块、可移植审计、npm漏洞审计通过。Linux源码生产构建、Shell语法、独立PostgreSQL专利/鉴权/任务/配音设置回归通过。SQLite迁移在专用空库实际验证dry-run不保留schema、apply迁移成功、再次向非空目标apply拒绝。

生产服务器：现有管理员登录成功，伪造Host不再认证；Web3000/API4000健康。真实浏览器进入指南、技能、方案、配音、设置、大屏6个页面均200，页面脚本错误0；DataV显示存量数据计数。实际PDF/导师预览成功，文件路径列无Windows值。小模型、大模型、Storm均完成一次极短文本生成，Mapbox样式接口200；这不证明长流程、额度或所有模型任务均完成。

配音通过系统自己的上传→备注解析→配音构建→下载流程验收，不是绕开业务系统手工拼装：一页测试输出PPTX 113648字节、MP4 93823字节；ffprobe确认H264视频8秒及AAC音轨约5.44秒。测试项目已删除，验收文件保存在发布目录storage.repair-tests-20261002，key/CSV未入库。

全部科研业务未做耗时完整验收：未运行完整多阶段专利/指南/综述生成、所有预测模型精度、OpenModelica全部仿真及GPU完整MGPlan。剩余必要输入是合法完整Gurobi许可证；如果需要Linux高级ESOPT原生能力，还需供应商Linux SDK。复杂MGPlan选项的专用extraData仍应由具体业务算例提供。

## 密钥与回退

本次没有把key、密码、环境、数据库、wheel或业务数据提交Git。新百炼配置仅写服务器受限文件，旧配置有私有备份。暂存文件扫描未发现本次CSV中的key或私有测试文件。完整回退不能仅切换程序就宣称数据库也已回退；数据库路径已经迁移，恢复dump必须先停写并明确处理发布后新增记录。具体部署约定见recovery-deployment.md。
