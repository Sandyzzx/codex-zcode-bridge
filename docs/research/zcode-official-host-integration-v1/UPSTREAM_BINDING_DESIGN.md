# G5：Upstream Binding 设计与现有 Worker 接线

> Status: RESEARCH — G5 DESIGN / NOT IMPLEMENTED
> Date: 2026-11-11
> Bridge baseline: `9710303397fe2d544c75698f783a8174404b2d51` / tree `a9ec733ac02a22b6d27b7cb150abeaae3020569c`
> Observed upstream: ZCode `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`，`3.18.0`
> Architecture authority: [ADR-032 Accepted](../../decisions/ADR-032-existing-worker-official-host-integration.md)
> Evidence level: 本轮只读源码映射。未构建 3.18.0 制品、未启动 Official Host/AppServer、未运行模型/账户/Billing/Start Plan、未改生产源码。

## 1. 结论

G5 的最小可行方向是新增一个实现现有 `CodingAgentAdapter` 的官方 Host Adapter，在其内部使用官方 `3.18.0` 导出的 `ZCodeAgentProcessManager` 与 `ZCodeProtocolClient`。该 Adapter 保持现有 Worker 的任务输入、结果、交互、取消和 proof 边界；官方 ProcessManager 独占其创建的 AppServer/helper 正常生命周期。

推荐拓扑如下：

```text
worker-main.ts
  → OfficialHostAdapter implements CodingAgentAdapter
    → one ZCodeAgentProcessManager per Worker/Attempt
      → one Official AppServer + optional Windows runtime-host helper
    → OfficialHostAdapter maps:
        Task prompt / continuation
        Session create / resume / mode / model
        Provider registration
        Subscribe / events / replay
        Reverse RPC: private runtime auth, permission, user input, browser
        Turn terminal / result / usage / errors
        Cancel and normal shutdown
```

不新增 `RuntimeAdapter`。`OfficialHostAdapter` 是 `CodingAgentAdapter` 的具体实现，不是公开接口层；Bridge Core、Manager、SQLite 和 MCP 不导入官方私有类型或 RPC。

本设计不建议直接替换成高层 `createZCodeAgentService()`、完整 `runZCodeProtocolAgent()` 或完整 `createServerHostServices()`。源码确认这些入口带有额外 ProcessManager、Automation/TaskIndex 存储、插件、MCP、Provider、遥测、凭据和设备身份装配。它们可以作为能力对照，但不能被当作“无副作用的最小 Host 启动器”。

## 2. 不可改变的外部合同

| 合同 | 本轮源码核对 | G5 处理 |
|---|---|---|
| `CodingAgentAdapter` | `startTask`、`continueTask`、`getStatus`、`getResult`、`cancelTask`，见 `src/interfaces.ts:181-199` | 方法签名不增加、不改名；官方类型不得出现在参数或返回值 |
| Worker 一次 Attempt | Worker 在 Claim 后解析私有 execution envelope，创建一次 Adapter 并只执行当前 Attempt，见 `src/worker/worker-main.ts:231-293`、`318-587` | Worker 继续拥有 Attempt、交互管道、私有认证和最终 Result frame |
| Adapter mode | 当前严格值只有 `zcode_app_server` 与 `test_fake`，见 `src/worker/worker-main.ts:240-267` 和 `src/manager/spawn-worker.ts:24` | 第一阶段不新增持久化 `official_host` 值；`zcode_app_server` 保持“执行真实 ZCode app-server”的语义，内部实现可演进 |
| Prompt | `buildTaskPrompt` / `buildContinuePrompt` 保持任务和 continuation 语义，见 `src/prompts/task-prompt.ts:18-100` | Binding 直接复用；不重写官方 Prompt Composer，也不改变任务报告契约 |
| Result | `ZCodeRunOutcome`、`buildTaskResult`、严格候选 Result frame 和 SQLite Authority 保持不变 | Binding 必须返回现有 `ZCodeRunOutcome`，不能把官方 snapshot/event 直接作为 TaskResult |
| Cleanup | 现有 proof 只接受三类明确事实，见 `src/worker/worker-main.ts:589-639` 和 `src/store/lifecycle-gate.ts:2898-2980` | `dispose()`/`disposeAllAndWait()` 成功不等于 cleanup proof；在新 ADR 前只能 fail closed 为未验证 |
| ADR-030 | 每 Issuer/Task 一次权威 entitlement verdict，Private Lease/HANDLE/ACK 和同任务绑定保持 | Binding 复用现有 Worker 私有认证回调，不由官方账户刷新替换权益权威 |
| 并发 | Capacity、路径 admission、Claim、Hold、Recovery、Release 在 Bridge | 官方 ProcessManager 不得把新路径改成“每账户一个 Worker” |

关键约束是保持两个独立的“完成”判据：

1. 官方 turn 只有在事件 session/turn/seq 绑定且 `resultType` 明确后才可形成模型执行结果。
2. Bridge Outcome 只有在 Worker 正常收尾、官方资源关闭事实可转换、现有 Cleanup verifier 接受后，才允许 Release。

## 3. 官方模块复用选择

### 3.1 选择：ProcessManager + ProtocolClient

`packages/services/src/node.ts:180-200` 导出 `ZCodeAgentProcessManager`、`ZCodeProtocolClient`、transport 和相关 options。该组合适合 G5，因为：

- ProcessManager 拥有 command resolve、spawn、Windows Job helper、runtime generation、协议关闭、超时回收、workspace dispose 和 shutdown 等待。
- Client 暴露 `request`、`notify`、`respond`、`respondError`、`onNotification`、`onRequest`、`onClose` 与 bounded dispose，见 `zcodeProtocolClient.ts:86-225`、`328-368`。
- Binding 能在 Worker 内控制 Session、事件和反向 RPC，而无需把官方私有 schema 泄漏到 Bridge Core。
- 官方正常关闭和 Bridge 异常兜底可有明确所有权分工。

### 3.2 不选择：完整 `createZCodeAgentService`

`createZCodeAgentService()` 自身创建主 ProcessManager，同时创建 plugin 与 mcp-status ProcessManager，并实例化 Automation/TaskIndex repo，见 `packages/services/src/zcode-agent/zcodeAgentService.ts:1401-1444`。这会违反“一个 Worker 初始一个执行 AppServer”和“不建无关 lane/进程”的范围。除非 G1/G2 证明某一官方能力无法从窄导出接入，否则 G5 不实例化该完整 service。

### 3.3 不选择：完整 `runZCodeProtocolAgent`

该入口在 `zcode-protocol-entrypoint.ts:140-209` 先准备 Session SQLite、插件 discovery/prewarm、Provider Registry、凭据桥和其他启动资源，之后才建立协议 Host。它可作为官方 AppServer 行为来源，但不是 Worker 内最小 Host 装配边界。直接嵌入会把 Desktop/Server host 的全局启动职责带进每个 Attempt。

### 3.4 暂不选择：直接嵌入 `ZCodeApp`

`ZCodeApp.submitPrompt()` 是更有语义的官方执行 facade，见 `apps/zcode-cli/packages/bootstrap/src/app/types.ts:875`。但 G5 同时要求 Attempt 级进程所有权、稳定取消、事件关联、反向 RPC 和资源证明。目前没有证据表明只构造 `ZCodeApp` 就能避开完整 bootstrap。只有 G1/G2 找到窄的官方 app factory、并证明其副作用与 ProcessManager 相当或更少时，才替换本设计的 transport 选择。

## 4. 组件与文件边界

建议的代码所有权如下；最终路径可随现有目录风格调整，但职责不能再拆成通用运行时框架。

| 逻辑单元 | 建议位置 | 职责 | 禁止 |
|---|---|---|---|
| `OfficialHostAdapter` | `src/adapters/official-host-adapter.ts` | 实现现有 `CodingAgentAdapter`；持有 Attempt 内存态和唯一 ProcessManager | 不调度 Task、不写 SQLite、不建第二套恢复状态机 |
| Host composition | 同一目录内的 factory module | 固定官方制品命令、workspace 参数、env、ProcessManager options；提供一个 execution runtime | 不创建 plugin/MCP status lane，不调用完整 `createZCodeAgentService` |
| Session/turn mapper | 同一目录内纯函数或小型 helper | Session create/resume、mode/model/provider、subscribe/send/replay、事件和 terminal 映射 | 不实现 Agent loop、Prompt Composer、Tools 或 Provider |
| Interaction mapper | 同一 Adapter 内的 per-run handler | 校验 session/turn/workspace scope，调用现有 Worker 私有 auth 或 interaction 回调，并向官方 client 回复 | 不发布凭据，不跨 Attempt 复用旧回复 |
| Browser adapter | 复用现有 `src/adapters/browser-host-adapter.ts` 与 `browser-host.ts` | 继续处理 browserList/browserExecute 和资源清理 | 不假设官方 Desktop Browser Main 可用 |
| Cleanup mapping | 暂不进入生产 proof | 收集官方关闭事实并保持 unverified；等待 Cleanup Proposed ADR 被正式接受后接 verifier | 不伪造旧 receipt，不把 Job empty log 当现有 proof |

不新增通用 `OfficialRuntimePort`、`SessionProvider`、`IpcClient`、`TaskRecovery` 或 service registry。ProcessManager 和 ProtocolClient 已是上游边界；再包一层只会重复其职责。

## 5. ProcessManager 装配

### 5.1 单 Attempt、单执行 Runtime

Worker 每次只执行一个 Attempt。Adapter 实例内只创建一个 ProcessManager，并且每个 Adapter 实例只允许使用一个 workspace/lineage：

```text
one Worker
  → one CodingAgentAdapter instance
    → one ProcessManager instance
      → one active execution AppServer
```

ProcessManager options 必须不配置 `useSharedTaskRuntime`，或在注入 callback 时恒为 `false`。虽然 manager 支持 shared runtime，见 `zcodeAgentProcessManager.ts:77-80`、`644-691`，ADR-032 当前明确排除 Shared AppServer Pool。Binding 还应在启动后核对 `isSharedRuntime(params) === false`，不把上游共享模式留作隐式配置。

不启用 plugin/mcp-status lane。若 Bridge 当前支持范围的 MCP 需要官方 AppServer 内执行，由官方 runtime 正常配置完成；额外控制面进程必须另有能力需求和证据。

### 5.2 Workspace 身份

现有 Adapter 区分：

- `workspace.sourcePath ?? canonicalPath`：项目身份；
- `workspace.canonicalPath`：当前执行目录，可能是 Host-selected worktree。

ProcessManager 的隔离 key 是 `workspaceIdentity?.trim() || workspacePath`，见 `zcodeAgentProcessManager.ts:1269-1271`。因此 G5 初始映射应为：

```text
ProcessManager.workspacePath       = workspace.canonicalPath
ProcessManager.workspaceIdentity   = workspace.sourcePath ?? workspace.canonicalPath
session workspace.workspacePath    = workspace.canonicalPath
session workspace.workspaceIdentity= workspace.sourcePath ?? workspace.canonicalPath
session workspace.workspaceKey     = workspace.sourcePath ?? workspace.canonicalPath
```

该映射防止 managed worktree 被误认成独立项目，同时让工具 cwd 保持 worktree。它是源码推断，必须在 G2 用 create/resume、Browser scope、MCP/project instruction 和同路径不同 identity fixture 验证。若官方 3.18.0 对 `workspaceIdentity` 有不同约束，应修改 Binding 的输入映射；不得退回“每个 Attempt 都是新项目”。

### 5.3 启动与取消竞态

ProcessManager 已用 starting promise、restart generation 和 admission signal 防止同 workspace 重复启动，见 `zcodeAgentProcessManager.ts:1051-1127`、`1188-1281`。Binding 仍需：

- 每次 Attempt 首次 `getClient()` 只发生一次；创建成功后不因 setup RPC 失败而透明第二次创建。
- `cancelTask()` 只 abort 当前 Attempt，并等待 Adapter 的唯一关闭路径完成；不得再直接 kill 同一个 AppServer，避免双管理器常规收尾。
- 若官方 client 在 turn 进行中关闭，当前 Attempt 立即失败为 unknown/failed；不得通过下一次 `getClient()` 在新 generation 上自动重发 Prompt。
- Runtime 重启事件只能用于识别当前 Attempt 失效。跨 Attempt 的 continuation 由 Bridge 新 Worker 正常发起，不能在同一进程内静默续作。

## 6. CodingAgentAdapter 方法映射

### 6.1 `startTask` / `continueTask`

保留现有异步启动形态：方法构建 run entry，启动一个内部 promise，返回 `AgentHandle`；`getResult` 等待该 promise。

执行顺序固定为：

1. 复用 `buildTaskPrompt` 或 `buildContinuePrompt`。
2. 解析 runtime environment、timeout、mode、model/reasoning、Provider registration payload。
3. 对 Start Plan 完成现有 fail-closed preflight；未通过时不启动 AppServer。
4. `ZCodeAgentProcessManager.getClient()` 获取唯一 execution AppServer。
5. 发送 `provider/updateAccountConfig`（仅当现有 provider payload 需要）。
6. 新建时调用 `session/create`；续作时调用 `session/resume` 并严格核对返回 session ID。
7. 应用 mode；应用显式 model/reasoning，并校验 runtime 回报的 provider/model。
8. 记录 runtime 初始 event seq。
9. `session/subscribe` 后再执行一次且仅一次 `session/send`。
10. 等待严格绑定或现有可见 compat 路径的 terminal。

`startTask` 不应把 Task 状态变成“已成功”；它仅代表 Attempt 已开始。Session ID 由 `getResult` 返回的 `ZCodeRunOutcome.sessionId` 持久化。

### 6.2 `getStatus`

返回值仍是 `AgentProcessStatus`：

- `starting`：Adapter 有 handle，但官方 client 尚未可用；
- `running`：当前 Attempt 尚未结束；
- `exited`：run promise 已 settled；
- `zcodePid`：可从已启动 managed process 的 official runtime PID 读取；不得为未启动进程合成 PID；
- `exitCode` / `signal`：只映射官方 root/transport 明确事实。

`getStatus` 不得为观察而调用会隐式 spawn 的 `getClient()`。ProcessManager 提供 `getExistingClient`、`getRuntimeIdentity`、`listManagedProcesses` 和 lifecycle events，见 `zcodeAgentProcessManager.ts:1051-1186`。实现应使用只读观察面。

### 6.3 `getResult`

`getResult` 继续负责等待 turn、保存 outcome checkpoint、执行一次受控关闭并返回 `ZCodeRunOutcome`。必须保持现有顺序：

1. 先建立完整模型结果和 AgentReport 解析结果。
2. 在 cleanup 前调用 `onOutcomeCheckpoint`，让已产生的结果不会因晚到的清理失败丢失。
3. 只调用一次 ProcessManager 的正常关闭入口。
4. 把官方关闭事实映射为当前 outcome 能接受的 proof；不能映射时返回 `cleanupVerified: false`，保持 workspace/Release 占用。
5. 不把官方 stdout/log 文本直接写入公开 outcome 或事件。

### 6.4 `cancelTask`

保持现有语义：

- 已结束 run 幂等返回；
- 设置取消标志并 abort；
- 结束当前 turn promise；
- 由 `getResult` 的单一路径完成关闭；
- 取消与 Result CAS 的竞争继续由 Bridge Manager 处理。

`cancelTask()` 不重复调用 ProcessManager 的多个 dispose 方法，也不等待下一次 `getResult()` 以外的永久后台 promise。

## 7. Session、Model 与 Provider 映射

固定上游仍提供这些协议词，见 `packages/shared/src/zcode-protocol/index.ts:4339-4400`：

| 当前行为 | 官方调用 | G5 要求 |
|---|---|---|
| 新建 Session | `session/create` | 传入 execution path、project identity、mode 和 immediate persistence；严格取得 session ID |
| 继续 Session | `session/resume` | 不把“创建了新 session”伪装成 resume；返回 ID 不一致立即失败 |
| mode | `session/create.mode` / `session/setMode` | 复用 `resolveSessionPreferences`；不改变 trusted local profile 的 yolo 约束 |
| model | `session/setModel` | 保留 `persistAsWorkspaceLastUsed: false`；核对 runtime 回报的 provider/model |
| reasoning | model options `reasoningLevel` | 原样请求；runtime 未报告时保持 null/not_reported，不按目录默认值伪造 |
| Provider | `provider/updateAccountConfig` | 在 Session 创建前完成；Start Plan 注册失败时不得越过 send |
| Event subscription | `session/subscribe` | 在 send 前完成；保留 includeSnapshot/afterSeq 语义 |
| Send | `session/send` | 只提交一次可能已接受的 Prompt；ACK 缺失不自动重发 |
| Replay | `session/events` | 对 live event 空闲时补拉；unsupported/连续失败发出可见 degradation |

`session/send` 在 3.18.0 已标注部分 deprecated，主 Desktop 路径转向 v4。G5 仍应把该版本绑定细节留在 Upstream Binding，并固定 commit；不能为了追桌面最新命令面而改变 Bridge 行为。升级时以 binding contract tests 检验，而不是由 Core 分支同时理解 v3/v4。

## 8. Turn 终态与结果

事件必须继续按下列事实判断，不能以事件名称代替 `resultType`：

| 事实 | 映射 |
|---|---|
| 本 attempt 的 `turn.started` | 建立 turn ID、start timestamp，进入 strict binding |
| `turn.completed` 出现在绑定前 | 保持 bounded pending；超时后仅走现有可见 compat 路径 |
| `turn.completed.resultType === "success"` | 可解析 AgentReport；报告无效仍为 failure |
| 其他明确 resultType | `zcode_nonzero_exit`，若为 cancelled 则映射取消 |
| resultType 缺失 | `unknown_turn_terminal`，绝不是 success |
| duplicate seq/turn completion | 幂等忽略；只 settle 一次 |
| foreign session/turn | 忽略并保留可见诊断，不得完成当前 Attempt |
| `turn.failed` | 只依据结构化 evidence 分类；429/5xx/网络不证明未接受 |
| usage | 复用现有 normalization；未知/冲突/null 不估算、不合成 |
| model | 返回 runtime-confirmed `ExecutionProfile`；请求值不冒充 effective 值 |

`ZCodeProtocolClient` 在 request timeout 时默认会触发 manager 淘汰 stale client，见 `zcodeProtocolClient.ts:243-256`。现有 Adapter 的 session RPC 预算为 30 秒，且普通 RPC timeout 不自动授权重派。G5 应对 session 操作显式使用相同有界 timeout 并关闭该自动 retry/reconnect 含义；超时后结束当前 Attempt、执行一次关闭，绝不重新 send。

## 9. Reverse RPC 映射

官方 Client 的 `onRequest` 提供 request emitter，Binding 必须处理当前支持的方法，而不把未知官方请求静默当成功。

### 9.1 Private Runtime Auth

`interaction/requestProviderRuntimeHeaders` 只能用于当前 Attempt：

- 校验 session、turn、provider、model 与当前 entry；
- 校验请求发生在 send/turn 的允许窗口；
- 通过现有 Worker `resolveStartPlanRuntimeAuth` 取得 one-shot credential；
- 复用 `StartPlanSecretRedactor`，日志和事件不发布 key；
- 请求、凭据、ACK 或父端存活通道任一失效时 fail closed；
- 不缓存到其它 Task，不把 official client 当第二套 entitlement authority。

现有 `PrivateCredentialLease` 已绑定 account/provider/model/task/attempt/operation/generation/claim/session/turn/pid/creation，见 `src/runtime/start-plan-private-lease.ts:3-99`。Binding 不得简化这组绑定。

### 9.2 Permission / User Input

`interaction/requestPermission` 与 `interaction/requestUserInput` 继续走 Worker 的 SQLite interaction channel。Binding 负责验证 request scope 后回复官方 client；回复 intent、ACK 和迟到答复规则保持现有实现。不能把审批状态放回官方 Session DB 作为 Bridge Attention 权威。

### 9.3 Browser

`interaction/browserList` 与 `interaction/browserExecute` 继续使用现有可选 Bridge browser host。Binding 必须：

- 校验当前 session、workspace、task attempt、browser generation；
- 拒绝跨 workspace/session 或过期 generation；
- 在 Browser cleanup 未验证时阻止最终 proof；
- 不在默认路径启动 Desktop Browser Main 或假设官方 headless browser 可用。

Browser 是 ProcessManager Job 之外的独立资源，不能因为 AppServer Job empty 就自动标记完整 Cleanup。

## 10. Error 与 Acceptance 映射

保留以下差异：

| 情况 | 结果 |
|---|---|
| pre-send setup/model/session 失败 | 可归因为配置/启动 failure；没有 accepted Prompt |
| send 写入开始但 ACK 丢失 | acceptance unknown；禁止自动重发 |
| send ACK 已收到后 turn failed | accepted yes；按结构 facts 分类 |
| transport/JSON protocol guard 失败 | 终止 Attempt，保留 unknown acceptance；执行一次关闭 |
| official client request timeout | 不从 manager 透明重连后重试当前 send |
| runtime text 含 quota 结构 | 可映射 `zcode_usage_exhausted`；普通 429 不自动等同 exhausted |
| AgentReport invalid | 保留 candidate 和 repair path；不因 `resultType=success` 判 Task pass |

## 11. Cleanup 与 Release 映射

官方 ProcessManager 正常清理链是：

1. `client.disposeAndWait()`；
2. 等待 root/exit diagnostics；
3. Windows Job close 路径等待 helper `empty` 与 helper exit；
4. cleanup 未完成时保留 `ownedProcesses`，后续主动请求再次核验。

关键源码：

- `zcodeAgentProcessManager.ts:875-1049`：3.25 秒 Windows cleanup 预算、一次重试、失败保留 ownership；
- `zcodeAgentProcessManager.ts:1695-1794`：workspace/all dispose；
- `windows-runtime-host/index.ts:69-250`：ready/started/root/empty、控制管道和 `--check-empty`；
- `windows-runtime-host/CONTRACT.md`：EOF、1800ms 宽限、TerminateJobObject、ActiveProcesses=0、helper exit。

这些是较强的官方关闭事实，但当前 Bridge 合同不接受它们的 schema。当前 `buildExecutionCleanupProof` 需要 adapter root fingerprint/receipt 或 adapter-not-started 事实，见 `src/worker/worker-main.ts:589-639`；Manager 还会校验 exact-key/source/method，见 `src/store/lifecycle-gate.ts:2898-2980`。

因此 G5 的强制行为是：

- 正常调用官方 ProcessManager；
- 将官方 close 失败、Job empty 未确认、helper exit 未确认、Browser 未验证都保留为 unverified；
- 在 Cleanup Proposed ADR 正式 Accepted 前，不生成 `candidate-execution-cleanup-proof-v1`；
- Result 可以持久化，workspace 因没有 accepted proof 暂不 Release；
- Worker 自己的 exact identity exit 仍是另一个独立门槛。

G3 需要交付的桥接事实至少包括：official runtime generation、root PID、Job identity/ownership、Job empty、helper exit、关闭时间、错误分类和 digest。若官方 API 不暴露足以形成持久 proof 的字段，可增加 Bridge 侧只读 verifier，但必须保留 Job 归属或现有身份绑定之一，不能退化为进程名/PID 猜测。

## 12. 发现的硬兼容缺口

### 12.1 原始协议帧上限

现有 Bridge 要求 app-server stdout 单帧最大 16 MiB UTF-8，含空白；超限或非法顶层对象会终止传输，见 `src/adapters/zcode-app-server-adapter.ts:343-350`、`1430-1466`。

官方 3.18.0 `ZCodeStdioTransport` 只按 LF 分帧、逐段保存并在完整帧后 `join`/JSON parse，见 `zcodeStdioTransport.ts:203-263`；当前源码中没有 Bridge 的 16 MiB raw-byte 上限。Binding 在已解析消息上重新计算 JSON 大小，不能阻止官方 transport 已接收并占用超过上限的内存，因此不能宣称原合同完全保留。

这是正式实现前必须解决的兼容项。可接受方案按优先级为：

1. 官方提供一个窄的 `createTransport`/最大帧字节 option，并继续由 ProcessManager 拥有 process lifecycle；
2. 官方导出 bounded stdio transport，由固定 3.18.0 配套小 patch 或上游兼容版本启用；
3. 若只能解析后检查，明确记录为合同弱化并提交 Owner/架构决策，不得在报告中写 PASS。

不能复制整个 transport 形成长期维护的平行协议栈，除非 G1 证明上游扩展不可行且 Owner 接受维护成本。

### 12.2 Request timeout 的自动回收语义

ProcessManager 将默认 request timeout 视为 connection stale 并回收整个 workspace，见 `zcodeAgentProcessManager.ts:1557-1591`。对于可能在途的 Prompt，Binding 必须避免重连后重发，并区分“当前 Attempt 失败”与“下一 Attempt 可重新启动”。这是可适配项，但不是零配置替换。

### 12.3 Runtime restart 语义

官方 manager 会保留 generation 并在下一次 `getClient()` 时启动新 client。该能力适合 Desktop 长期 Host，不适合 Bridge 在同一个已知尝试中透明恢复。Binding 必须把 generation 改变视为当前 Attempt 绑定失效，恢复由 Bridge 的下一 Attempt/continuation 决定。

### 12.4 Account service 范围

官方账户/Provider/凭据装配没有一个已确认的“只执行本任务”窄入口。直接用完整 Service 会扩大副作用或创建额外管理器。G4 必须给出可注入账户 context；在它完成前，G5 只能保留现有 ADR-030 路径并以 Mock/无账户用例验证 Binding 结构。

## 13. 迁移阶段

### Stage A：内部新实现，契约不变

- 新增 `OfficialHostAdapter implements CodingAgentAdapter`；
- 复用原 prompt、outcome、normalization、browser 和交互语义；
- Worker 仍使用现有 `adapter_mode`；
- 用 test-only injection/loopback fixture 选择新实现，不把新 mode 写入 SQLite；
- 旧 Adapter 保留，用于对照和回退。

### Stage B：行为 parity

- 将现有 Adapter 历史回归映射到同一个 fixture matrix；
- 新实现只有在 session、event、terminal、cancel、auth、browser、timeout、frame 和 cleanup 正反例均等价后才可成为默认；
- 官方 transport frame guard 缺口未解决时 G5 只能 `PARTIAL`。

### Stage C：Worker 内部切换

- Worker 仍发送 `adapter_mode: "zcode_app_server"`；
- binding factory 在该语义下创建官方 Host Adapter；
- 不新增 IPC、数据库、公开 MCP 工具或 schema；
- 旧 Adapter 暂时保留为本地回退，直到全部门和独立审查通过。

### Stage D：清理

只有以下条件全部成立才删除旧直接 AppServer Adapter：

- 官方 3.18.0 固定制品可构建；
- Mock Agent/Tool/resume/cancel E2E 通过；
- 现有 Windows/Linux 清理合同映射明确；
- 账户并发和 G4 结论不要求改变 Worker 架构；
- G6 全回归与 Astra 审查通过。

## 14. 必须保留的回归矩阵

实现阶段应把这些现有测试迁移为“旧/新实现共同行为契约”，不能降低断言：

| 行为组 | 现有证据入口 |
|---|---|
| 帧大小/JSON/protocol fatal | `test/session-frames.test.ts`、`test/zcode-app-server-adapter.test.ts` |
| foreign/replay/duplicate terminal | `test/runtime-remediation.test.ts`、`test/batch2-evidence.test.ts` |
| 缺失 resultType、failure facts、ACK unknown | `test/failure-facts-integration.test.ts`、`test/batch2-evidence.test.ts` |
| usage/model/timing | `test/batch2-evidence.test.ts`、`test/zcode-app-server-adapter.test.ts` |
| permission/user-input | `test/zcode-app-server-adapter.test.ts`、`test/failure-facts-integration.test.ts` |
| Browser scope/generation/cleanup | `test/browser-host-adapter.test.ts` |
| Start Plan private lease/ACK | `test/start-plan-private-*.test.ts`、`test/start-plan-production-auth.test.ts` |
| timeout/cancel/cleanup | `test/zcode-app-server-adapter.test.ts`、`test/runtime-remediation.test.ts` |
| SQLite Hold/Recovery/Release | `test/sqlite-candidate/wp6c/` 与 lifecycle-port 测试 |

新增官方 Host 测试最少还要覆盖：

- `useSharedTaskRuntime` 未启用；
- 一个 Adapter 只能有一个 execution workspace；
- `getStatus` 不触发 spawn；
- runtime close/restart 使当前 Attempt 失败而不重发；
- official client request timeout 不导致第二次 `session/send`；
- normal dispose 成功仍不能生成未被批准 schema 的 Bridge cleanup proof；
- 16 MiB raw-frame guard 的保持或显式 BLOCKED 结论。

## 15. G5 进入和通过门槛

G5 编码开始前需要：

- G1 固定 3.18.0 可运行 Host/AppServer/helper 制品及 import closure；
- G2 证明 ProcessManager 能启动官方 AgentRuntime，loopback Mock 完成 Read 工具二次推理、resume 和 cancel；
- G3 至少给出 Cleanup 事实采集能力和明确的 `PARTIAL/BLOCKED` 边界；
- G4 明确账户 context，不能让真实账户成为静态 Binding 编译前提；
- frame guard 与 timeout 的窄适配方案已选。

G5 通过需要：

```text
WORKER_HOST_INTEGRATION: PASS
CODING_AGENT_ADAPTER_COMPATIBILITY: PASS
TASK_ATTEMPT_SEMANTICS: PASS
SESSION_EVENT_MAPPING: PASS
MODEL_ROUTING: PASS
TOOL_EXECUTION: PASS
CANCELLATION: PASS
ERROR_MAPPING: PASS
TERMINAL_STATE_MAPPING: PASS
SQLITE_AUTHORITY: PASS
WORKER_CONCURRENCY: PASS
LEGACY_IMPLEMENTATION_CLEANUP: PASS or DEFERRED
```

任何一项只有源码映射、没有实际行为证据时必须写 `NOT_RUN`，不能转成 PASS。

## 16. 当前决定与未决事项

已决定：

- 继续使用现有 `CodingAgentAdapter` 接口；
- Upstream Binding 作为 Worker 内普通模块；
- 单一官方 ProcessManager 管理单一执行 AppServer；
- 不新增 persisted adapter mode、IPC、任务数据库或平行 RuntimeAdapter；
- 官方私有类型/RPC 不进入 Bridge Core；
- 保持 ADR-030 和现有 Result/SQLite/Recovery/Release 合同；
- Cleanup draft 仍为 Proposed，不能用 dispose 成功替代 proof。

仍未决：

- 官方 ProcessManager 的 transport 是否有上游窄扩展可保留 16 MiB raw-frame guard；
- 最小 Provider/Account context 的精确官方导出与副作用；
- official Job/helper 事实如何转换为 Bridge Accepted proof；
- project identity 与 execution worktree 的 mapping 在 3.18.0 实测结果；
- Browser/MCP 在最小官方 Host 下的实际支持范围；
- 真实账户与同 profile 多 Worker 行为，按 Goal 继续标 `NOT_RUN`。
