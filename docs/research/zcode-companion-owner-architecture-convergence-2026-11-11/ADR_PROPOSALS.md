# 两项架构决策建议草案

> Applicability (2026-11-12): HISTORICAL / SUPERSEDED FOR THE CURRENT TARGET. 独立 Companion 方向已由 [ADR-032](../../decisions/ADR-032-existing-worker-official-host-integration.md) 排除，当前源码候选改为在现有 Worker 内装配官方 Host。正文保留为冻结前研究；其中关于“尚未实现/未构建/未验证”的旧状态只适用于该研究时点，不能覆盖 [当前架构](../../ARCHITECTURE.md)、ADR-033/034 或本仓库的当前证据。

> Status: RESEARCH — HISTORICAL / SUPERSEDED FOR THE CURRENT TARGET；不是当前 DECISION。
> Date: 2026-11-12（历史研究截止 2026-11-11）。
> Bridge baseline：`0b70edbbfb1888666d8d3b97f891a0f943fa3a9e`。
> Observed upstream：`b95ebaffeab641907b38652f45c1502bd762972d` / 3.18.0。
> 本文件只含两个草案。未修改 docs/decisions，ADR-030 及其 Preview.3 适用性修订继续有效。

## 草案一：官方 Runtime Cleanup Proof 与 Bridge Release 的映射

### Context

现有 Worker 的 `buildExecutionCleanupProof()` 返回旧 proof union；Manager 的 exact-key/source/method 校验拒绝其它形态。正常路径在绑定 Result 持久化之后等待 Worker close，要求 exit code 0、精确 Worker 身份已退出和 execution proof，再记录 Cleanup 并经 CAS Release。显式 cancel/Recovery 的证据路径独立存在。

官方 `ZCodeAgentProcessManager` 通过 `ZCodeStdioTransport`/protocol client 清理其所属 Runtime；Windows 原生 helper 在创建时将 suspended CLI 归入唯一 Job，持有 KILL_ON_JOB_CLOSE，并在关闭时检查根退出、ActiveProcesses=0。正常控制链报告 `ready / started / root / empty`。helper 失联时，官方 close 可在确认旧 helper 退出后按唯一 Job 名 `--check-empty` 复核。

**关键缺口：**`WindowsRuntimeHost.close()` 只返回 `Promise<void>`，Job 名称留在内部闭包；公开 `ZCodeAgentRuntimeIdentity` 和 `RuntimeProcessLifecycleReporter` 不提供完整 Job 归属/empty 证据，reporter 回调异常还会被隔离为日志。因此不能靠现有 reporter、PID 或 dispose 成功直接构造可持久恢复的 Job 收据。

源码依据：[旧 proof 构造](D:/codex-zcode-bridge/.run/preview-integration/src/worker/worker-main.ts:589)、[Manager 验证器](D:/codex-zcode-bridge/.run/preview-integration/src/store/lifecycle-gate.ts:2918)、[Manager 正常 Cleanup](D:/codex-zcode-bridge/.run/preview-integration/src/store/lifecycle-gate.ts:2570)、[官方 runtime-host 接口](D:/codex-zcode-bridge/.run/companion-runtime-validation-20261111/source/packages/services/src/windows-runtime-host/contract.ts:3)、[官方控制实现](D:/codex-zcode-bridge/.run/companion-runtime-validation-20261111/source/packages/services/src/windows-runtime-host/index.ts:218)、[native Job 实现](D:/codex-zcode-bridge/.run/companion-runtime-validation-20261111/source/scripts/windows-runtime-host/main.cpp:61)。

### Proposed Decision

1. 官方 ProcessManager 独占 AppServer/helper 的正常启动、停止和回收；Bridge Manager 只正常管理 Worker。取消先通过绑定实例执行官方 stop/dispose；超时或关闭失败进入 unverified，禁止自动重发输入或常规启动第二个 Runtime 替代原执行。
2. 在 Worker binding 与 Manager 验证器之间，新增**有明确版本的官方 Job 证明变体**；不伪装成旧 identity-bound receipt，不修改旧历史证据含义，不接受仅有 `complete: true` 的自报。
3. 证明需绑定 Task/Attempt/Operation/generation、Claim/Worker identity、制品 identity、Runtime instance/generation、helper 精确身份和唯一 Job identity。分别包含 Job 覆盖的资源范围、root exit、empty 或 helper 已退出后同一 Job 的内核复核事实，以及所有 Job 外资源清单的关闭结果。
4. 启动归属记录必须先于允许工具执行的 start/resume 边界进入可恢复记录，或采用等价的可证明原子归属发布路径；不能等 Worker 临死前才记录一个 PID。无记录或发布竞争一律保留 unknown，不凭进程名补认。
5. Manager 验证同一坐标/版本/资源范围后才可接受 execution proof；它仍独立确认 Worker 已关闭、当前 Claim/Result 坐标及没有阻止释放的交互/Hold，再记录 Cleanup 和 CAS Release。正常 exit code 0 要求及异常 Recovery 围栏不因新 proof 自动取消。
6. 异常清理保持当前身份绑定的 scoped fallback；不同时启动两套常规进程监督。证据不足时 Hold 保留，允许后续显式 evidence-only Recovery，但不覆盖 Result 或制造新 Attempt。

### 官方事实→Bridge 事实映射

| 官方事实 | 如何获取 | Bridge 对应事实 | 是否足够 |
|---|---|---|---|
| AppServer 根关闭 | Runtime root exit / client 失效；绑定 Runtime instance，再做必要 OS identity 核验 | Runtime 根生命周期结束 | 否；既不证明后代，也不证明 Worker 退出 |
| Job 归属 | native 创建属性 + IsProcessInJob；通过需补齐的非秘密 typed observation 获取并绑定唯一 Job/helper/Runtime | execution resource ownership | 必要但不充分；当前公开导出不足 |
| ActiveProcesses=0 | `empty` 控制事件；或旧 helper 确认退出后官方 `--check-empty` 检查同一 Job | 该 Job 覆盖范围已空 | 只对已记录的同一个 Job 足够；不覆盖其它服务资源 |
| helper 退出 | 官方 ChildProcess/OS 同代身份；不能与 runtimePid 混用 | 原生 owner 已结束 | 单独不足；KILL_ON_JOB_CLOSE 是机制，不是“已观察全部退出”的事实 |
| Browser 退出 | 实际 owner 的有界关闭与进程/profile 资源检查；默认未创建时有显式 not-created 记录 | browser resource closed/not-created | 必须与 Job 事实合并；不能默认已在 Job 内 |
| Worker 其它资源关闭 | binding 记录官方 Repo/监视器/Host helper/临时端口等创建和释放；Worker exit 后由 Manager核验必要 OS 事实 | operation_resources_complete 的输入 | 资源范围完整且可验证才足够；promise settle 不足 |
| Worker 退出 | Manager 绑定 launch/claim identity，close + 新鲜 OS probe；异常走原 Recovery | Worker owner lifecycle 结束 | 必要但不代替其曾创建的后代清理 |
| 完整 Cleanup | 全部 execution 资源事实 + Worker 事实 + 当前 Claim/Result/交互/Hold 校验 | recordCleanupEvidence(verified) | 记录并核实持久状态后才成立 |
| Release | 持久 cleanup_digest/revision/Claim 绑定的 releaseCapacity CAS | Capacity/路径正式释放 | 独立最后一步，不能从 Outcome/Job empty 推出 |

### 证明载荷建议（非最终 schema）

最小类别为 `official-runtime-job-proof-v1`，包含 coordinates、artifact、runtime identity、helper identity、job identity、ownership/start fact、closure observation、outside-job resources 和 evidence digest。字段名和 frame/proof 版本须在实现前冻结；不能为了沿用旧 exact-key frame 随意加字段。

PID/start fingerprint 只是进程同代绑定；hash 只用于完整性和去重，不是内核证明。正常路径可使用可信私有控制链的 typed facts，但 Recovery 必须能重新核验同一资源，不能依赖已退出 Worker 的内存。

初期不需要通用资源图数据库或新表。先评估现有绑定事件/证据字段是否能承载所有事实与正确时序；若不能，单独设计最小 schema/协议变更并取得批准。本草案不承诺零数据库迁移。

### 观测端口缺口的处理

首选寻找或向上游提交一个窄、只含非秘密生命周期事实的导出/observer，使官方实现继续负责 Job 和进程清理；不要截获 stdout、解析 debug 日志、猴子补丁或复制 ProcessManager。

本轮没有证明现有公开入口已满足该端口。若后续 POC 只能调用官方 dispose 并观察根退出，结论只能是“官方 Runtime 关闭，Bridge 完整 Cleanup 未验证”，不得接生产 Release。若无法取得端口，可另审查 Bridge 独立 OS Job/资源核验路径；必须证明其完整性和可恢复性，而不是用一份普通 recorded PID 扫描冒充未观察到的 Job 闭包。

Worker 硬崩溃、helper 硬崩溃、启动未 start、root 先退出但后代存活、控制 EOF、Job query 拒绝/超时、Browser 位于 Job 外和 PID 复用均需反例测试。验证必须基于构建出的 3.18.0 helper/Host，不能借前轮 0.17.1 单文件 close 宣称通过。

### 保留和不变的合同

MCP 名称/schema、Task/Attempt 权威、未知执行不重派、Result/Cleanup/Release 分离、Workspace retention 和旧历史 receipt 校验全部保留。旧正常路径仍由旧验证器解释；没有批准和验证之前不启用新 proof。

```text
CLEANUP_PROOF_MAPPING: PARTIAL
REASON: 语义映射明确；官方可持久 Job 事实导出、Bridge 新 proof 及 Recovery 适配尚未实现/验证
```

## 草案二：官方账户所有权与权益事实来源

### Context

Preview.3 当前 Start Plan 使用父端 Issuer→私有 Lease/HANDLE/ACK→Worker 的链。**ADR-030 顶部修订为每 Issuer/Task 一次权威 Billing verdict，同一 account/provider/model/device/credential 绑定复用；历史正文第 5 条第二次 Billing 已被替代。** 此合同在本草案批准、实施和验证前继续有效。

新目标是复用官方 Account/Credential/Request Auth，不让 Bridge 重新开发 OAuth、token refresh 或权益算法。官方有独立系统凭据后端；然而 credential file lock、OAuth snapshot CAS、进程内刷新单飞、远端 token rotation 是不同机制，不能混为已验证并发安全。

### 已由源码确认的事实

| 事实 | 具体证据 | 限制 |
|---|---|---|
| 凭据整文件写入有跨进程锁、原子替换 | credentialService.ts:389；privateFilePersistence.ts:73/128 | 不包住远端换证全过程 |
| recovery generation 跨异步操作检查 | privateFilePersistence.ts:17/49 | captureCredentialFileGuard 是前后代次围栏，不是持锁执行整个网络刷新 |
| OAuth token 写入有 expected snapshot 和新 session revision | oauthCredentialRepo.ts:570；credentialService.updateMany | CAS 可拒绝旧写入，不保证另一个进程的远端 rotation 已撤销的 token 仍有效 |
| OAuth refresh 先网络后 mutation | oauthService.ts:1172–1217 | sessionMutationQueue 进程内；不能据此宣称网络刷新跨进程单飞；saveTokenSet 的冲突处理也需专测 |
| 公开 BigModel/Zai adapter 未提供 refreshToken 实现 | providerAdapter.ts 的可选方法；两个具体 adapter 源码 | 不应承诺已有透明 OAuth refresh；须区分 OAuth、profile refresh、Project Token 换证 |
| Project Token 去重与缓存为实例内 | accountProviderCredentialService.ts 的 pending Map；project-access-token-client.ts 的 sessions/cache | 多 Worker 可重复签发；远端政策是否允许以及失效传播未验证 |
| Account Snapshot 是本地投影，显式/config 变化驱动刷新 | account-provider-service.ts:45/61/104 | 非每次模型请求都做实时 Billing；onDidMutate 也是本进程回调，不能视作跨 Worker 广播 |
| 请求 auth 能解析身份/scope，Coding 分支换证前后检查 | accountProviderRequestAuthService.ts:81/110/122 | Start 分支直接取 JWT，不具有完全相同的 Coding scope 流程；新接线要保持外层身份/取消绑定，不能一概宣称所有套餐相同 |

源码都是 Observed 3.18.0；本轮没有真实刷新或读取凭据。账户并发状态为 UNVERIFIED。

### Proposed Decision

1. **账户 profile 是显式供给的持久身份，不是每 Attempt 克隆的临时目录。** Worker 内官方服务是执行期间的消费者和授权范围内的修改者；Task/Session/临时根按 lineage/Attempt 隔离，profile 与 Desktop 数据独立。多个 Worker 可绑定同一逻辑 profile 的设计目标必须保留。
2. 初始不增加账户进程或 Credential Broker，不把账号所有权放进 Bridge Core；使用官方服务的文件锁、snapshot CAS 和请求级身份检查。路径分离必须经实际导出/官方配置验证；不得给 createCredentialService 虚构 filePath 参数。
3. **不采用整轮 Task/Worker 的账户级互斥。** 必要互斥仅限真实发生的登录/登出/凭据替换/换证事务，执行任务和模型流不因此全局串行。若官方真实旋转流程需要跨进程串行化而现有 API 不提供，该项是待解决门槛，不以降低并发“通过”。
4. entitlement 的目标事实源是官方 Account/Availability Resolver，其发布的配置/身份/revision 与本次请求保持一致；unknown/false 一律不能授权。须明确数据时效、查询失败、last-known-good、登出/变更与模型准入规则后，才能替代现行 verdict。
5. Request Auth 仍由官方服务实现，Bridge 仅绑定不透明 profile/account/project scope 与执行坐标、处理取消/失效；不在 Core/普通事件/Result/SQLite 中保存 JWT、headers、cookie、device identity 或加密主密钥。
6. 若同 profile 多 Worker 的事实传播/refresh 不能通过官方现有路径安全实现，优先寻求上游窄能力或现有官方供给；再审查一个**仅账户职责**的 owner。它不拥有 Task、Session、AppServer 或 Worker，不借此恢复完整 Companion 架构。

### A/B/C 比较与明确推荐

| 方案 | 最简单的适用形式 | 并发与官方语义 | 决定 |
|---|---|---|---|
| A Worker 服务 + 独立 profile | 用户独立供给一个或多个 profile；每 Worker 绑定其指定 profile，禁止复制会话材料造 profile | 不同 profile 可并行；同账号多 profile 是否被远端允许未知。共享同一个 profile 时有磁盘原子保护，但刷新/失效投影仍需多进程验证 | **推荐基础路径**，同时将“同 profile 多 Worker”列为生产门槛；不是冻结每 Worker 必须独立登录 |
| B 共享账户 owner | 优先普通 Worker 内官方服务/窄锁，而非新 daemon | Manager 进程可做普通协调，但其重启不能成为所有 detached Worker 的必需认证生命周期；同时存在多个 Manager 时进程内锁无效 | 独立 owner/Broker **DEFER**；只有复现冲突且无法由官方机制解决才加入 |
| C 官方其它供给 | 支持的 Personal/API-key；官方独立 CLI/Server/Provisioning | Personal/API-key 不等于 Start/Team；Provisioning 有身份/代次和认证端点要求，不是复制 Desktop DB | 支持的 Provider 可采用，不能用它绕过账户套餐语义 |

最简单方案是复用官方 Worker 内账户服务，不提前加 Broker；最符合官方语义的是复用同一套 profile/revision/请求材料解析与真实供给流程，而非每 Worker 复制 JWT。是否需要额外短账户锁仍是条件项；禁止把当前文件写锁当完整网络事务锁。

当前 Bridge Capacity/路径调度并发保持，未来新路径不得通过减少 slots 或引入 task-long account lock 改变它。**新路径的同账户并发仍 UNKNOWN，不能宣布已保留生产能力。** POC 临时单活只限第一轮定位环境，不是产品合同；必须有两 Worker/同 profile 的多进程 Mock 反例作为后续进入生产的门槛。

### 验证矩阵与生产切换

POC 必须区分：两独立 profile、同 profile 两个服务进程、同 account 的两次独立供给；不能只用前者证明后两者。Mock 覆盖文件并发更新、rotation 仅一次有效、CAS loser、Worker/Manager 重启、account A→B→A、旧 revision 迟到、登出与缓存 snapshot、权益 unknown/拒绝、取消与 late auth response、两独立任务 continued Session 不串用。

不能用 Mock 证明远端支持多登录/rotation；真实账户阶段需另行明确授权并按套餐验收。公开 request verification 缺口若阻止 Start 能力，该 Provider 必须保持 unavailable/BLOCKED，不能删验证或伪造设备身份。

本草案最终替代哪些 ADR-030 条款，需在真实官方事实源和时效规则验证后逐条决定；现在不批准具体删除 Billing、HANDLE/ACK 或 Lease，不同时保留两条认证链并自动择优。新执行模式采用唯一明确配置的认证所有者，失败不自动回退旧路径或其它 Provider。

```text
ACCOUNT_OWNERSHIP_DESIGN: PARTIAL
ACCOUNT_CONCURRENT_REFRESH: UNVERIFIED
EXISTING_WORKER_CONCURRENCY: UNKNOWN — 新路径端到端能力；现有生产调度本轮未改
CREDENTIAL_BROKER: DEFER
ADR_030_EFFECTIVE: YES — 当前单次任务权威 verdict 修订
```
