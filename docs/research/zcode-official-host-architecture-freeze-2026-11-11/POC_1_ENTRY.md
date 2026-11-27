# POC-1：最小官方 Host 组合验证计划

> Status: RESEARCH — PLAN ONLY / NOT AUTHORIZED TO EXECUTE
> Date: 2026-11-11
> Architecture: [ADR-032 Accepted](../../decisions/ADR-032-existing-worker-official-host-integration.md)。本页只定义后续实验，不授予构建、下载、Runtime 或账户操作权限。

## 进入条件与输入

1. Owner 单独明确授权受限 POC-1、隔离根、依赖下载/构建及资源/进程实验范围；本轮冻结任务不是该授权。
2. 当时重新核实最新 origin/preview/远端与 ADR-032，按双分支流程新建独立工作区；不复用生产数据或覆盖本次文档工作。
3. 输入官方源码 `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`、对应 lockfile，以及 [制品边界研究](../zcode-companion-owner-architecture-convergence-2026-11-11/SOURCE_ARTIFACT_BOUNDARY.md)。不是已安装 0.17.1 bundle 的重新包装。
4. 在实验前列明准确服务导出/options、所有可能文件/网络/设备/CA/后台初始化副作用及释放路径。不得先运行完整 createServerHostServices 再观察是否碰到真实用户数据。
5. 固定构建工具候选与实际运行 Node。Bridge 要求 >=24.16.0 <25，先评估共同 24.16.0；官方 mise 24.14.0/pnpm10.33.2、Server staging22.16.0 与历史实验pnpm11.25.0须分别记录，不混为兼容证明。
6. 确认独立配置/home、Session、storage、log/tmp、Provider资源路径及不继承真实 auth/代理/设备材料。所有模型endpoint只允许本地Mock，账户端口使用合成材料或完全关闭。
7. 明确 Job观测的可用程度和验证口：拿不到完整持久Job事实时只验Runtime关闭，不将Bridge Cleanup/Release标为PASS；不得为实验伪造receipt或弱化当前验证器。

## 最小范围

在研究 Worker 中装配官方导出的 Agent Service、必要Provider配置及其内置ProcessManager，构建匹配的3.18.0 AppServer和Windows helper。保持现有Worker/Adapter接口方向，不新增Companion或生产接线。

每次一个实验Worker、一个执行AppServer和一个合成Task lineage，验证：

| 场景 | 最少观察 |
|---|---|
| 导入/初始化 | 实际源码制品可装载；native/资源定位明确；无真实Desktop/Main或用户数据依赖 |
| create/model/submit | 创建合成Session，选择Mock模型，只提交一次已关联输入；不自行实现Agent loop |
| stream/官方工具 | 收到事件、官方Read读取项目内fixture，Mock确认第二次请求包含工具结果 |
| outcome | success/failed/cancelled按真实resultType和绑定判断；不以turn.completed名称直接判成功 |
| cancel/迟到应答 | 取消后停止接收新输入，拒绝旧请求答复；不超时重发Prompt |
| 正常关闭 | 官方dispose、root exit、Job empty/helper exit分别观测；额外Repo/监听器/端口有释放记录 |
| restart/resume | 正常关闭后顺序重新装配，恢复同一实验lineage/Session；不跨任务串库 |
| 一项失败反例 | 自身Runtime退出或控制链失效，保留unknown/failed与清理范围；不自动重发/释放 |

POC-1 的单实例是实验定位范围，不是每账户单Worker产品限制。现有并发合同保持；同profile多Worker的Mock/真实语义、全后代硬崩溃、Manager恢复和生产proof验证属于后续独立门槛。

## 成功标准与证据

- 完成真正3.18.0制品构建及选定能力运行，记录commit/tree/lockfile、Node/工具版本、二进制/native/resource hash、启动参数和隔离路径。
- 通过官方Agent Service调用，而非复用旧直接RPC驱动后改名；不改写官方账户/Session/工具核心。
- 上表场景有可复查的原始本地Mock记录和进程同代身份；Tool/模型请求、结果和关闭事实分开。
- 所有实验自建资源的归属/关闭范围明确。若Job证据入口缺失，标明对应项PARTIAL/NOT_VERIFIED，不宣称完整Bridge Cleanup/Release。
- 不将Mock成功推广为真实Provider、账户供给、同profile并发、完整依赖闭包或生产验收。

POC-1可形成“最小Host运行PASS，完整Cleanup映射PARTIAL”的诚实结果；不能为了全绿伪造证据。若最小Host构建/基础执行未成立，就不能把POC-1总体写为PASS。

## 停止/升级条件

出现真实账户/设备/生产目录访问需求、意外外网模型请求、必须绕过verification/权益、无法控制副作用、需要复制大段官方核心、ABI冲突、失去进程归属或资源残留时，停止对应实验并保留证据。清理只处理身份已证明的自建资源，不误杀Desktop；不能以停止实验名义放弃资源归属。

不能在失败后自动加Companion、Broker、RuntimeAdapter、Pool、业务数据库、Recovery框架，或改生产认证/Proof合同。具体证据提交Owner；确有必要改变ADR-032时另立ADR。

## 本阶段不实现

真实OAuth/Billing/Start Plan、profile供给/透明刷新、同profile生产并发、账户Broker、Shared AppServer、Browser/MCP/Memory/Subagent/CUA全能力、生产SQLite迁移、proof接入及自动升级/发布均不在POC-1内。它们仍须后续授权和验收。

```text
POC_1_PLAN: DEFINED
POC_1_AUTHORIZATION: REQUIRED_SEPARATELY
POC_1_EXECUTED: NO
PRODUCTION_ENTRY_AUTHORIZED: NO
EXISTING_WORKER_CONCURRENCY_CONTRACT: PRESERVED
```
