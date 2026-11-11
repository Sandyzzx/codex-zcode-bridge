# G3：进程所有权

> Status: RESEARCH — SOURCE CONFIRMED / R7-R9 NORMAL RUNTIME CONFIRMED / BRIDGE PROOF PROPOSED
> Date: 2026-11-11
> Bridge baseline: `9710303397fe2d544c75698f783a8174404b2d51`
> Observed upstream: ZCode `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`，`3.18.0`
> Architecture authority: [ADR-032 Accepted](../../decisions/ADR-032-existing-worker-official-host-integration.md)
> Evidence level: 固定官方源码核对、现有 Bridge Cleanup/Release 回归、固定 runtime-host helper acceptance，以及 r7/r9 官方 ProcessManager 的 localhost Mock 运行。未执行真实模型、账户、Start Plan 或 Billing 请求。

## 1. 结论

目标路径只有一个正常生命周期所有者链：

```text
Bridge Host / Core / SQLite Authority
  owns Task / Attempt / Claim / Result / Hold / Recovery / Cleanup / Release

Existing Worker
  owns one Attempt execution context

Upstream Binding
  owns protocol/event/result mapping inside that Worker

Official ZCodeAgentProcessManager
  owns normal AppServer and helper lifecycle

Official Windows runtime-host helper
  owns the Windows Job and its member processes

Official AppServer
  owns AgentRuntime, prompt, tools and provider execution
```

Bridge 仍保留异常清理和最终证据审核责任，但异常兜底不能变成第二个常规 ProcessManager。根 PID 退出、官方 `dispose()` resolved、Job 内有临时变化、Result 已提交或 Worker 已退出，任何一项都不能单独授权 Bridge Release。

现有 r7/r9 已验证正常路径：官方 ProcessManager 启动和关闭两代 AppServer/helper，目标 PID 在每次关闭后消失，lifecycle reporter 产生成对的 spawn/exit。它仍不能产生 Bridge 可跨崩溃持久接受的 Cleanup Proof。

```text
PROCESS_OWNERSHIP_SOURCE: PASS
OFFICIAL_HELPER_ACCEPTANCE: PASS
OFFICIAL_PROCESS_MANAGER_NORMAL_RUNTIME: PASS_FOR_ISOLATED_MOCK
DESKTOP_MAIN_INDEPENDENCE: NOT_RUN
BRIDGE_CLEANUP_MAPPING: PARTIAL
CLEANUP_PROOF_CONTRACT: PROPOSED
BRIDGE_CLEANUP_MAPPING_AND_CONTRACT: PARTIAL / PROPOSED
```

## 2. 所有权表

| 对象 | 正常责任 | 可观察事实 | 不能据此声称 |
|---|---|---|---|
| Bridge Manager | Spawn Worker、保存 Claim、等待 Result/Worker exit、执行最终 Cleanup 审核和 CAS Release | Worker PID/start fingerprint、Claim、Result、清理阶段 | Worker 或 AppServer 进程树已经清空 |
| Existing Worker | 执行一个已 Claim Attempt，持有 Binding 与当前执行坐标 | Worker 退出码、Result frame、adapter cleanup facts | 官方 Job 为空或跨 Attempt 所有权已消失 |
| Upstream Binding | 只做官方 client/event/result 与 Bridge 内部接口转换 | 当前 session/turn/runtime generation | 成为 Task/Cleanup 权威，或另建状态机 |
| Official ProcessManager | Resolve command、spawn、正常 dispose、失败保留 ownership、必要时重核验 | runtime PID、root exit、lifecycle reporter、close Promise | `dispose()` 成功就是 Bridge `cleanup_verified` |
| Windows runtime-host helper | 创建唯一 Job、suspended spawn、归组、root-exit 触发终止、等待 `ActiveProcesses=0` | 内部 `ready`、`root`、`empty`、helper exit；内部保留唯一 Job 名 | 公开 API 已暴露可持久 Job identity/proof |
| Official AppServer | 运行 AgentRuntime 和工具 | 官方 turn/event/result facts | 决定 Bridge Task 验收、Cleanup 或 Release |
| Browser 等额外资源 | 由实际创建者的 owner 关闭 | 独立资源关闭事实 | 默认包含在 AppServer Job 内 |

## 3. 官方 Windows 关闭合同

固定上游的 `WindowsRuntimeHost.close(deadlineAtMs)` 合同明确区分：

1. AppServer root exit；
2. Job 全部成员退出；
3. helper exit。

`close()` 只有在 EOF 后的收尾窗口结束、Job 清空且 helper 退出后才成功。`onRootExit()` 只报告 root 生命周期，不能代替 Job empty。依据：

- `packages/services/src/windows-runtime-host/contract.ts:3-15`
- `packages/services/src/windows-runtime-host/CONTRACT.md`

实现中：

- Host 为每次 spawn 生成内部唯一名 `Local\zcode-runtime-${randomUUID()}`。
- helper 创建带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job。
- CLI 通过 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 以 suspended 状态在创建时直接归组，没有“先 spawn、后 attach”的窗口。
- root exit、parent abandonment、close grace 到期或启动失败会调用 `TerminateJobObject`。
- helper 仅在 `ActiveProcesses == 0` 且 root 已退出时发送 `empty`。
- helper 异常退出且未发送 `empty` 时，Host 可在 helper exit 后用唯一 Job 名执行 `--check-empty` 只读恢复探测。

依据：

- `packages/services/src/windows-runtime-host/index.ts:69-250`
- `scripts/windows-runtime-host/main.cpp:43-49,61-65,80-90,148-172`

源码确认的设计质量较高：身份在创建时归组、根退出不冒充全树退出、内核计数为零才成功、失败保留后续核验机会。

## 4. 官方 ProcessManager 的正常所有权

`ZCodeAgentProcessManager` 将每个 managed process 放入 `ownedProcesses`，正常清理依序调用 `disposeAndWait()`、等待 exit diagnostics，并仅在清理真正完成后从 ownership 集合移除。Windows 下一次 cleanup 与 retry 共用约 3.25 秒预算；失败不会静默删除旧 managed process。依据：

- `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:569-578,875-1049`
- `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:1476-1611,1695-1794`

### 4.1 r7/r9 正常生命周期实测

r7 使用固定 `zcode.cjs`、固定 helper、localhost Mock 和项目内隔离 HOME/TMP/DB，12 个结构化断言全部通过。当前最新的 r9 在自包含 host module artifact 上重现同一结果。r7 两代身份如下：

| 代次 | runtime identity | AppServer PID | Helper PID | 后续动作 |
|---|---|---:|---:|---|
| generation 1 | `<workspace>:1:23176` | `23176` | `23820` | 官方正常 close 后两者均不可见 |
| generation 2 | `<workspace>:2:6428` | `6428` | `2548` | 同 session resume、cancel 和最终 close 后两者均不可见 |

精确目标 PID 观察为：

```text
generation 1: [23176, 23820] -> []
generation 2: [6428, 2548] -> []
final target set: [23176, 23820, 6428, 2548] -> []
```

生命周期 reporter 记录了 4 个事件：两代各有一次 `spawn` 和 `exit`。两次 exit 都是 `exitCode=0`、`terminationKind=expected`、`terminationReason=workspace-dispose`；没有 error/exception lifecycle event。这个观测是正常 Mock 路径的事实，但 callback 不是持久 Cleanup receipt。

因此目标实现不得同时调用官方 ProcessManager 与 Bridge 的身份绑定树终止作为“常规”关闭。正确顺序是：

1. Binding 请求官方单一路径正常关闭；
2. 等官方 close 完成或失败；
3. 只有正常 close 失败时，Bridge 才按已记录 Worker/runtime 身份启用异常兜底；
4. Manager 仍独立确认 Worker identity exit、资源证据完整性和当前 Claim/Result 坐标，再决定 Hold 或 Release。

如果 Worker 本身先异常退出，任何“另一个 Manager 重启后顺手清理”的行为都必须先重新证明原 PID 代次和 claimant tree，不能使用 PID、进程名或命令行批量终止。

## 5. 现有 Bridge 的异常所有权

现有 Windows Adapter 在 root 尚存活时使用 spawn-generation identity 与身份绑定树事务；root 已退出时只接受 ADR-009 recorded-tree claimant scan。当前 Worker/Manager 接受的事实是：

- 身份绑定进程树 receipt；
- 经 fingerprint/PID reuse 防护的 recorded-tree claimant scan；
- 仅限明确 pre-adapter 拒绝的 `adapter_not_started`。

依据：

- `src/adapters/zcode-app-server-adapter.ts:1147-1188,1245-1285,1570-1658`
- `src/worker/worker-main.ts:589-639`
- `src/store/lifecycle-gate.ts:2898-2980`

现有事实与新官方 Job 事实不是同一 schema。当前 claimant scan 能证明“记录树没有可见 claimant”，但没有证明官方 Job 名、内核 Job 成员计数或 helper 退出。它可作为：

- 现有 Preview.3 执行路径的允许证明；
- 新路径在取得新 Accepted proof 前的异常收口候选；
- 新路径正常 Cleanup 的独立补充事实。

它不能在没有新合同的情况下被改名为 official Job proof。

## 6. 关键边界

### 6.1 根退出

root exit 是 AppServer 生命周期事实，不是全树清空事实。官方 helper 和现有 Bridge 都显式保留这一区别。

### 6.2 `close()` resolved

官方 `close()` resolved 的语义是“调用当时，Job 已空且 helper 已退出”。但公开返回类型是 `Promise<void>`，Job identity 留在闭包里，调用者没有结构化收据可持久化。若 Bridge 在 Promise resolved 后、写入 SQLite 前崩溃，重启方无法仅凭已存数据重建这次关闭事实。

因此：

- 进程内正常决策可以使用官方 close 成功；
- 跨崩溃的 Bridge Cleanup/Release 不能只凭“日志里以前好像 close 成功”；
- 要跨重启证明，必须具备新的 typed observation/proof 或等价的可重建证据。

### 6.3 ProcessManager lifecycle reporter

r7/r9 已观察 lifecycle reporter 能携带 `runtimeGeneration`、`runtimeInstanceId`、AppServer PID、exit code 和 termination reason，形成 generation 1/2 的 2 次 spawn 与 2 次 expected exit。

该 reporter 仍只用于观察，异常被捕获和记录，不能作为 Bridge 安全事实的事务边界。Binding 不得为了拿到 Job 事实而 monkey-patch 官方实现、解析自由文本日志或把 callback 成功当成持久证明。

### 6.4 Browser 与工具后代

Job 只能证明由官方 helper 正确归组的成员。Browser、外部 MCP、Host 自建监听器/临时目录或主动脱离 Job 的工具进程必须有实际 owner 的独立关闭事实。未知时必须保留 unverified。

## 7. 目标实现要求

- 一个 Attempt 初始化一个执行 AppServer，不同无关 Task 不共享。
- 官方 ProcessManager 是正常启动、停止和重试的唯一 owner。
- Bridge Manager 是 Task 生命周期与最终 Release 的唯一 authority。
- Binding 记录局部 runtime generation，但不得持久化成第二套 Task 状态。
- 正常 close、异常树终止、Worker exit、Bridge Cleanup 和 Release 分阶段记录。
- 任何失败都保留实际资源占用；不得用减少 Worker slots、账户锁或自动重派掩盖。

## 8. 验证状态

现有 Bridge 的 Lifecycle/Cleanup 回归已运行：

```text
node scripts/test-isolated.mjs \
  dist-test/test/sqlite-candidate/wp6b-wiring/lifecycle-gate.test.js \
  dist-test/test/zcode-app-server-adapter.test.js \
  dist-test/test/windows-process-cleanup.test.js \
  dist-test/test/windows-cleanup-review-regressions.test.js \
  test/sqlite-candidate/wp6c/cleanup-release.test.mjs

139 tests, 139 pass
```

固定 helper 的 acceptance 已运行：

```text
helper: 04E1794F8325B3C46D4159420CDD04041E9AFC58516E03FC3DC8E78576EEFC24
acceptance: PASS
scenarios: graceful, tree, root-exit, control-loss, helper-loss, cancel,
           ownership failure rejects CLI execution
```

官方 ProcessManager 的 r7/r9 Mock 也已运行：

```text
assertions: 12/12 pass
realModelRequests: 0
productionCredentialsRead: NOT_OBSERVED_NON_INSTRUMENTED
desktopProcessStarted: NOT_DETECTED_BY_EXPLICIT_LAUNCH
```

139 项旧回归证明现有 Preview.3 的 Hold/Recovery/Release 和旧 Windows 清理合同仍通过；helper acceptance 和 r7/r9 证明固定 helper 与正常 ProcessManager 路径在隔离 Mock 下可运行。它们不证明真实账户路径、一般 Desktop Main 独立性或新 Bridge Cleanup 映射已经完成。

```text
PROCESS_OWNERSHIP_DESIGN: PASS
OFFICIAL_PROCESS_MANAGER_NORMAL_OWNERSHIP: SOURCE_CONFIRMED
OFFICIAL_HELPER_ARTIFACT: PASS
OFFICIAL_HELPER_ACCEPTANCE: PASS
OFFICIAL_PROCESS_MANAGER_NORMAL_RUNTIME: PASS_FOR_ISOLATED_MOCK
PROCESS_MANAGER_CRASH_FAULT_MATRIX: NOT_RUN
DESKTOP_MAIN_INDEPENDENCE: NOT_RUN
EXISTING_PREVIEW_CLEANUP_REGRESSION: PASS
OFFICIAL_JOB_PROOF_EXPORT: MISSING
BRIDGE_CLEANUP_MAPPING: PARTIAL
CLEANUP_PROOF_CONTRACT: PROPOSED
PRODUCTION_SWITCH_AUTHORIZED: NO
```

下一步必须由已接受的 Cleanup Proof 合同和实际官方 Host POC 决定，不能以本文件替代实现或验收。
