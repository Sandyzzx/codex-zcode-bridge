# ADR-032：现有 Worker 内集成官方 ZCode Host

> Status: DECISION
> Date: 2026-11-11
> Decision: Accepted — Owner 在 Architecture Decision Freeze 任务中明确批准方案 5 的目标拓扑、职责、制品策略和禁令。
> Applicability: TARGET ARCHITECTURE ONLY；后续隔离 POC 已有组件证据，但生产实现未完成，不切换当前 Preview.3 执行/认证/清理合同；POC 结果不改变本决定。
> Verified against: Bridge `372e90622772b070357a278f1da3dea58fa42dee`；相对前轮 `0b70edbb` 仅新增分支工作流，生产源码未变。
> Observed upstream: ZCode source `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`，3.18.0；此元数据本身不是构建/运行证明，后续隔离证据另见本 ADR 末尾链接。

## Context

Bridge 需要长期复用官方 AgentRuntime、Prompt、Tools、Provider 和模型执行，保留自己的任务编排与权威状态。已有单 Attempt Worker 是执行隔离边界。再预建一个 Companion 服务会增加进程、IPC、状态与恢复维护，但目前没有 ABI、账户共享或资源效率的实证要求这一边界。

Owner 接受 [Astra 审查](../research/zcode-companion-independent-review-2026-11-11/REVIEW.md) 的方案 5，以及 [架构收敛报告](../research/zcode-companion-owner-architecture-convergence-2026-11-11/OWNER_ARCHITECTURE_DECISION_REVIEW.md) 的最小拓扑。本 ADR 记录这一正式取舍，不将研究中的能力假设升级为实现事实。

## Decision

### 1. 唯一目标拓扑

```text
Bridge Host / Core / Manager / SQLite Authority
  → Existing Worker（一个活动 Attempt）
    → 现有 CodingAgentAdapter 接口的具体实现
      → Upstream Binding（Worker 内普通模块）
        → Official Agent Service / 必要 Host 服务 / ProcessManager
          → Official AppServer（进程内 AgentRuntime / Prompt / Tools / Provider）
```

Windows 官方 runtime-host helper 是官方进程归属实现的一部分，不是被排除的 Companion。每 Worker 初始拥有一个执行 AppServer，不与无关 Task 共享；不为限制数量而复制或删改官方内部 ProcessManager 对象。实际插件/探测 lane 的启用必须有明确能力需求和验证。

### 2. 职责和所有权

| 组件 | 冻结职责 |
|---|---|
| Bridge Host/Core/Manager/SQLite | 保留 Task、Attempt、Workspace admission、调度并发、Claim、Result、Hold、Recovery、Cleanup 和 Release 权威 |
| Existing Worker | 保留现有 bootstrap/provenance/Claim 入场和一次 Attempt 执行壳；获准执行后才装配必要官方 Host 服务 |
| CodingAgentAdapter | 保留现有接口；具体实现完成任务/会话、事件、交互与结果语义转换，不新增平行 RuntimeAdapter |
| Upstream Binding | 普通内部模块，与执行制品配套维护，不单独发布 package；官方私有类型、RPC和版本差异不得泄漏进 Bridge Core |
| Official Agent Service / Host 组合 | 复用最小必要服务；不得直接调用完整 createServerHostServices 并假设其无凭据、设备、CA、存储或后台服务副作用 |
| Official ProcessManager | 独占 AppServer/helper 的正常启动、停止与清理；Bridge 不同时常规管理同一个 Runtime |
| Official AppServer | 执行 AgentRuntime、官方 Prompt/Tools/Provider；保存自己的 Session/事件事实，不决定 Bridge Task 的验收和 Release |

Bridge 保留 Worker 管理和有精确身份、有范围的异常清理兜底。Manager 重启、观察断开、Result 缺失、根 PID 退出或官方 dispose 成功，均不能单独授权重派或释放。Outcome、资源退出、Cleanup 和 Release 分开取证。

现有 Worker 并发合同保留：不静默减少 Capacity，不以整轮 Task/Worker 的账户锁使同 profile 任务串行化。新路径同 profile 并发尚未验证；实验单活不成为产品限制。不得因架构图中 Worker detached 而推导现有父端认证通道失联也可继续供给。

不新增业务 Task 数据库或状态机。官方 Session/必要辅助存储与 Bridge Authority 分工，Task lineage 持久数据须支持后续显式 continuation，不能每 Attempt 换空库后声称恢复成功。

### 3. 固定官方源码制品

固定官方 commit/tree、lockfile、匹配 Host/AppServer、构建工具、实际执行 Node、native/helper 和资源版本，构建配套制品及 manifest。制品边界不等于服务进程边界。长期运行不依赖用户 Desktop 安装目录或 Desktop Main，不伪造 Desktop 版本/build、凭据或 device identity。

初始源码研究输入为本页 Observed commit。Node/native/资源的最终支持组合待实际验证后固定；当前 Bridge SQLite gate 为 `>=24.16.0 <25`，官方 mise 的 24.14.0 或 Server staging 的 22.16.0 不能直接替代它。共同 Node 24.16.0 是 POC 候选，不是本 ADR 宣布通过的 ABI 组合。

不可变制品与可写数据分离；升级前验证能力、配置和数据兼容，活跃 Attempt 不静默换版。二进制回滚不等于数据回滚；不得覆盖新任务事实或恢复失效凭据。实际 BOM、许可、native/资源闭包和回滚均须后续验收。不要求维护完整 ZCode fork；需要大量核心补丁时停止并重新审查。

### 4. 当前明确排除

- 独立 Companion 服务进程及新增 Companion IPC。
- 新增 Companion 业务 SQLite、第二套 Task 状态机或 Recovery 系统。
- 平行 RuntimeAdapter、单独发布 Upstream Binding package。
- Shared AppServer Pool、无关 Task 共享执行实例。
- 自动重发可能已接受的 Prompt、自动切换认证链或 Provider 来掩盖失败。
- 凭据/设备身份复制、unknown entitlement 当 true、伪造旧 Cleanup Receipt、仅以根 PID 或 dispose 成功报告 cleanup_verified。

这些排除只针对当前目标。将来若具体 ABI、账户共享或性能证据显示确有必要，可用新的 ADR 重新审查；不得通过“预留框架”或内部兼容更新自行恢复被排除组件。

## 保持有效的合同与 Proposed 草案

[ADR-030](ADR-030-start-plan-provider-preflight.md) 顶部 Preview.3 修订继续有效：每个 Issuer/Task 一次权威 entitlement verdict，交付复用完全相同身份绑定的 verdict；Private Lease/HANDLE/ACK、fail-closed 和不跨任务缓存保留。原历史正文第二次 Billing 不恢复，本轮也不删除现行权益检查或切换账户所有者。

[账户与 Cleanup 两项草案](../research/zcode-companion-owner-architecture-convergence-2026-11-11/ADR_PROPOSALS.md) 继续为 **Proposed only**：

| 草案 | 本 ADR 不批准的部分 |
|---|---|
| 官方 Runtime Cleanup Proof 与 Bridge Release 映射 | Job 持久事实导出、新 proof 类型/验证器、Recovery/schema适配；不以 dispose 直接替代当前证明 |
| 官方账户所有权与权益事实来源 | profile 供给/刷新、同 profile 多 Worker 一致性、权益时效及替代 ADR-030 的具体条款 |

当前 Claim/Hold/Recovery/Cleanup/Release、并发、MCP/schema 和 SQLite Authority 合同不变。本 ADR Accepted 只冻结目标，不使这两个草案成为 Accepted，也不授权实现或生产切换。

## 未决能力与验证门槛

1. 官方 3.18.0 最小 Host 的实际构建和运行。
2. Node/native/helper/动态资源依赖闭包。
3. 官方 profile 的独立供给、刷新和同 profile 多 Worker 并发。
4. 官方 Job 事实的可持久观测，以及 Bridge Cleanup Proof/Recovery 映射。
5. 实际制品 BOM、许可和数据兼容/回滚。
6. 真实 Start Plan 的独立账户能力；0.17.1 安装版历史成功不构成此证明。

## Consequences 与下一步

相比原候选少一层额外服务进程、IPC协议和服务恢复，不复制 Task 状态。代价是官方 Host 与 Worker 共用 Node/故障边界，且不能预先享有共享常驻 Host 的资源收益；真实兼容性需验证。

该决定作出时，下一步仅可在单独授权后执行 [POC-1 计划](../research/zcode-official-host-architecture-freeze-2026-11-11/POC_1_ENTRY.md)。后续独立任务已授权完成隔离源码制品与最小 Host/Mock 执行；这不建设账户 Broker、Pool、额外服务或生产迁移，也不授权生产接入。POC-1 即便通过，也不解决全部六项未决能力。

后续获得的隔离证据见 [Official Host Integration v1 实施摘要](../research/zcode-official-host-integration-v1/IMPLEMENTATION_SUMMARY.md)。固定源码制品和官方 ProcessManager 的 loopback Mock 路径已有运行证据；same-profile 双 Worker refresh 合成测试失败，raw frame guard 与 Bridge Cleanup Proof 也尚未满足。这些结果只更新能力状态，不改变本 ADR 的目标拓扑、最低合同或现有 Proposed 状态。
