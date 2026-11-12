# ADR-029：退役旧运行时与 SQLite 单一生产链

> Status: DECISION
> Date: 2026-11-06
> Baseline: a46137fe46b567271a7756be819361132625278c
> Decision: Owner 已授权内部旧运行时退役；公共 Core API 破坏亦获 Owner 单独批准，未来按主版本发布。

## 已批准范围

依据 Owner 本轮架构精简指令，删除无生产职责的 CLI Adapter/envelope/loader、GitWorktreeProvider 和对应专属测试。共享进程身份、app-server、Result、SQLite 安装兼容及离线 v13 升级保留。R1–R5 语义不变。

## 已批准的公共 Core 变更

src/core.ts 是 package.json 声明的公共入口。private=true 和未发布 npm 包不能撤销既有宿主/fork 的导出合同。

在独立候选中删除 TaskStore、JSON BridgeTaskManager 构造合同及 TaskManagerOptions、createWorkerSpawner、runWorkerTask/RunWorkerTaskOptions 和绑定 TaskStore 的 buildTaskObservation。SQLite Lifecycle Manager 直接作为唯一 Manager 提供给 Host/MCP；公开其 SQLite 创建入口，startBridge 继续保持调用合同。纯 observation/feedback/usage 函数和通用类型按实际消费者保留。

受影响者：调用旧 store/workspaceProvider/spawnWorker 构造参数、自定义 JSON Worker 或直接使用上述 Core 导出的 fork。本仓库之外的当前消费者尚未核实；不能宣称没有外部破坏。

版本策略：该候选标记为 Core breaking change，发布应采用下一主版本（建议 2.0.0），fork 锁定旧制品直至转到 startBridge/SQLite Manager。当前不提升版本、不发布、不修改其他仓库，不以兼容包装保留旧执行体系。Marketplace MCP 工具/schema 和既有 SQLite 数据格式不变；v13 用户仍显式离线升级。

## 验证与回滚

删除后保留共享进程/Adapter/Worker/SQLite 回归；JSON 专属测试退役需记录对应生产删除和 SQLite 接管证据。Windows 全量在最终冻结候选执行。数据库保持 v14；回滚只切换候选代码/制品，禁止通过回滚数据覆盖新事实。

## 测试门禁

JSON B3-05 随 TaskStore 退役。SQLite 功能性 CAS/并发/迁移继续包含在 npm test；资源压力矩阵由 test:stress 显式执行或 test:affected 命中 SQLite 边界时选择。完整功能回归与压力矩阵分别报告，FULL_SUITE 不重复压力矩阵。

## 理由与后果

生产已经切到 SQLite，保留旧 Manager/Store 仅增加双链理解与测试成本。直接复用现有 SQLite Manager，保留实际安装/历史 SQLite 的验证机制，比新增兼容包装更简单。代价是旧 Core 消费者需要主版本升级；Marketplace MCP 和现有数据库事实不受此退役改变。
