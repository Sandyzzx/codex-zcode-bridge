# G3/G4：失败分类与恢复

> Status: RESEARCH — ACCOUNT SYNTHETIC FAULTS STARTED / NEW HOST FAULTS NOT RUN
> Date: 2026-11-11
> Bridge baseline: `9710303397fe2d544c75698f783a8174404b2d51`
> Observed upstream: ZCode `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`，`3.18.0`
> Evidence level: 现有 Bridge 源码与回归；两个真实 Node 子进程的合成账户失败/崩溃/锁恢复已运行；官方 Host 失败注入、真实账户/模型请求均未运行。

## 1. 总原则

官方 Host 接入不得建立第二套 Task/Recovery 状态机。Bridge SQLite Authority 继续区分：

- Claim；
- Outcome/Result；
- Worker exit；
- Runtime/Job/Browser resource cleanup；
- Cleanup evidence；
- Release。

失败恢复只允许两类动作：

1. 在当前执行坐标内完成尚未完成的清理/验证；
2. 保持 Hold，等待显式人工或后续受控操作。

不可自动重发可能已接受的 Prompt，不可用一个新的 AppServer 静默续作原 Attempt，不可把 absent Result、root exit、`dispose()` resolved 或 helper 进程不见解释成“未知也能安全重试”。

## 2. 失败事实分类

| 失败点 | 已知事实 | 未知事实 | 持久处置 |
|---|---|---|---|
| Pre-adapter/Start Plan preflight 拒绝，未启动 | 明确 `adapter_not_started` 条件 | 是否有其它非执行资源 | 仅在 exact proof verifier 接受时允许 Cleanup |
| Host 组装失败，尚未 spawn AppServer | 当前 Worker 创建了什么 | 失败工厂是否留下监听器/目录/子进程 | 有完整 resource facts 才可 verified |
| AppServer spawn 失败 | spawn attempt、错误码 | root 是否瞬时创建、helper/Job 是否已存在 | 按已记录 child/helper 身份核验；无证据则 Hold |
| Setup RPC 失败，send 前 | 尚未写入可能已接受的 Prompt | 执行端是否已完成部分副作用 | 关闭当前 runtime；可形成 task failure |
| `session/send` 写入开始后 ACK 丢失 | Prompt acceptance **unknown** | 官方是否收到/开始执行 | 当前 Attempt unknown/failed；禁止重发 |
| Turn/event 协议错误 | transport/event 契约失效 | 远端是否继续运行 | 当前 Attempt fail closed，执行一次有界关闭 |
| Root 异常退出 | root exit | 后代、Job、helper、Browser 是否清空 | claimant/Job 验证；不自动重新 dispatch |
| Helper 异常退出 | helper exit/错误 | Job 是否为空、旧 Job 是否可重新打开 | close recovery probe；失败保留 ownership/Hold |
| Cleanup 超时 | cleanup 未在预算完成 | 是延迟完成还是永久残留 | 发布 unverified 快照；迟到成功不能改写 |
| Result 已提交但 Worker exit 未知 | Result 可用 | 原 Worker 身份/resource 是否退出 | Capacity 占用，禁止 Release |
| Worker 已退出但 Result 缺失 | Worker exit | Prompt 是否执行、远端副作用是否完成 | Operation 保持 running/Hold，不重派 |
| Credential delivery/ACK 丢失 | lease 已消耗 | 凭据是否被使用 | 永不重传；当前 Attempt fail closed |
| SQLite commit outcome unknown | 本地 commit 结果未知 | 是否已有 durable Event | poison/Recovery fence，禁止猜写 fallback |

## 3. 当前 Preview.3 的恢复合同

### 3.1 Claim 后但 Result 缺失

`src/store/lifecycle-gate.ts:1476-1490` 明确：`running` 且无 Result 时，即使 fresh identity probe 显示 Worker 已退出，也保持占用，原因可分类为：

- `worker_still_alive_managed_elsewhere`；
- `worker_exited_without_committed_result`；
- `worker_identity_unknown_managed_elsewhere`。

`recoverOperation()` 不把这种情况自动升级为新 Attempt，因为原 Worker 可能由另一个 Manager 持有，且 Prompt 可能已执行。

### 3.2 Result 已提交、Cleanup 未完成

只有 `result_committed`、`cleanup_pending`、`cleanup_unverified` 可在后续恢复中尝试完成 Cleanup。前置条件包括：

- 当前 Claim/Worker identity digest 可验证；
- 同一 generation、attempt、claim；
- exact PID/start fingerprint；
- 当前 Result binding 仍一致；
- exact identity 已退出；
- recorded-root/claimant scan clean；
- 完整 operation resource facts；
- CAS revision 未在 probe 期间变化。

依据：`src/store/lifecycle-gate.ts:1494-1735`。

### 3.3 Cleanup verified、Release 未完成

Cleanup verified 是持久阶段事实；Recovery 可用其 `cleanup_digest` 幂等执行 Release。它仍校验 operation revision、generation、claim、identity digest 和 projection，不重新执行模型。

### 3.4 失败写回竞态

Cleanup/Release 的 CAS 写入若在 probe 期间发现 revision、phase、Result 或 interaction/Hold 已变化，必须停止并保留新状态。一个普通 Hold 存在时，不能自动重验并释放；只有精确可解的 Cleanup-only Hold 才可继续。

## 4. 官方 Host 失败映射

### 4.1 ProcessManager failure retention

`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:875-1049` 在 cleanup 失败时不删除 `ownedProcesses`。后续主动请求可重试/重核验。Binding 必须保持此语义：

- 不把 cleanup rejection 转成可重连；
- 不在同一 workspace 启动新 generation 来绕过旧 ownership；
- 不丢弃旧 runtime generation/pid/helper 观察；
- 不因为 retry 成功覆盖之前已持久化的 unknown 快照，除非合同明确允许 append 新的 Cleanup observation。

### 4.2 Worker/Manager 断开

Manager 与 Worker 之间的结果/交互断开不等于 AppServer 已停止。因为 AppServer 可能在 Worker 子树内：

- Manager 应等待 Worker close/identity；
- 若 Result 已提交，进入 Cleanup，而不是重新 Task；
- 若 Result 未提交，保持 running/Hold；
- 不能仅凭 IPC EOF 终止无关 Desktop 或全局 Node 进程。

### 4.3 Helper/Job 断开

官方 helper 是 Job owner。helper exit 后：

- 控制管道 EOF 本身不证明 Job empty；
- 若已有 `empty` 且 root exit，则正常 close 可成功；
- 若缺少 `empty`，实现可在 helper exit 后用唯一 Job 名只读核验；
- 核验失败/Job 不存在语义不清楚/超出 deadline 时保持 unknown。

公开 `close(): Promise<void>` 的失败恢复不携带可持久 ID；因此生产 Recovery 需要 Cleanup proof ADR 批准的 observation 入口。

### 4.4 Account refresh failure

账户 refresh 失败需分层：

- 本地 CAS loser：重新读取 canonical revision；
- provider 明确拒绝：不得继续用旧 token；
- 网络 unknown：不得并发重试一次性 refresh token；
- account switch/logout：迟到结果拒绝；
- file lock timeout/transport failure：保持 unknown，不能假定可以安全写。

单个 Worker 的刷新失败不能自动撤销另一个 Worker 的有效在途请求，也不能将全局账户置为已验证。真实账户行为本轮 `NOT_RUN`。

固定上游 `3.18.0` 的双进程合成运行补充了以下事实：

- 一个 Worker 的 adapter 在共同 barrier 后失败时，返回明确错误，profile revision 不变；
- 同时启动的健康 reader 成功读取原 revision，未被失败 Worker 阻断；
- 两个 Worker 同时 refresh 时都会到达同一 loopback endpoint，第二个请求以
  `409 rotation_reuse_rejected` 失败；
- CAS 竞争者恰好一个成功，loser 没有覆盖 winner；
- 锁持有进程被终止后，下一进程在 `17 ms` 内取得同一 case-local credential lock。

这证明失败隔离和锁回收的窄路径，也证明每 Worker 独立 `OAuthService` 的 refresh
事务仍需要跨进程 coordination。它没有覆盖 network unknown、account switch/logout、
迟到响应、真实 provider 或真实账户。原始证据见
`.run/lifecycle-account-evidence/ACCOUNT_MULTIWORKER_EVIDENCE.md`。

### 4.5 Private auth failure

当前 lease 在 delivery 开始前清空内部 secret，任何 delivery reject、取消、ACK loss 或 parent channel 消失都使该 lease unavailable。恢复动作只能是当前 Attempt 失败/等待明确外部处置，不能重新获取同一 entitlement verdict 后再偷偷交付第二份 token。

## 5. 恢复矩阵

| 持久阶段 | Fresh identity | Tree/Job fact | 允许动作 | 最终状态 |
|---|---|---|---|---|
| running | alive | 任意 | 不重派；保留原 owner/显式 cancel | held/running |
| running | exited | 任意 | 不因“进程没了”合成 Result | held |
| result_committed | alive | 任意 | 保留 Capacity；必要时显式停止后证明 exit | held |
| result_committed | exited | clean 且 evidence complete | 记录 Cleanup、CAS Release | released |
| cleanup_pending | exited | clean 且 evidence complete | 记录 Cleanup、CAS Release | released |
| cleanup_unverified | exited | clean 且 evidence complete | cleanup reverify、Release | released |
| cleanup_unverified | unknown | 任意 | 保留 Hold | held |
| cleanup_verified | n/a | 已有 verified digest | 幂等 CAS Release | released |
| any cleanup phase | any | non-clean timeout/reject | 保留资源占用 | held |
| released | n/a | n/a | 幂等 complete | complete |

“clean”必须符合当前 accepted proof 范围；新官方 Job proof 在对应 ADR 接受前不能满足这一列。

## 6. 必须保留的禁止项

- 不自动重派不确定是否已接受的 `session/send`；
- 不把 retry 设计成第二次 Prompt；
- 不把 Runtime restart generation 当当前 Attempt continuation；
- 不用 absent Result 或 root PID 消失授权 Release；
- 不用 free-text log replay 重建 Cleanup；
- 不 monkey-patch ProcessManager 导出内部状态；
- 不让 recovery 启动新的执行 worker；
- 不在 unknown SQLite commit 后猜写；
- 不批量终止 Node/Desktop/PID-name 匹配进程；
- 不为恢复增加第二 Task DB/第二状态机；
- 不降低 Worker slots 或引入 task-long account lock。

## 7. 官方 Host POC 必须加入的反例

1. spawn 后、ready 前取消；
2. `started` 前 helper/process 失败；
3. root exit 但 synthetic descendant 保留；
4. close grace 到期后 Job 终止；
5. helper 未发 `empty` 就退出，且 Job 名可查；
6. helper 未发 `empty` 就退出，且 Job 核验失败；
7. Worker 在 Result 写完后、close 前崩溃；
8. Manager 在 Cleanup 期间重启；
9. root-exited claimant scan 看到 live child；
10. Browser 与 Job 分离，Browser 清理失败；
11. 两 Worker 同 profile、旧 revision/refresh 迟到；
12. credential ACK loss 和 parent channel close；
13. Result/Release 写 commit outcome unknown；
14. 同一 line 中 late helper completion 不得把已发布 unverified 快照偷偷升级。

每项都需保留原始进程/实例身份、时间、命令退出码、event/revision、清理范围与未解决项。不能只截一张“进程列表为空”的截图。

## 8. 验证状态

现有 Lifecycle/Cleanup：

```text
139 tests, 139 pass
```

覆盖 Result-only 不 Release、identity unknown/Hold、cleanup reverify、exact CAS Release、PID reuse、interrupted cleanup、unknown commit poison 和真实 claimant scan。

现有 Start Plan/private auth：

```text
33 tests, 33 pass
```

覆盖 ACK loss、竞争 redeem、错误身份、取消、expired/unknown entitlement 和跨 Task 不串用。

官方 `credential-recovery-fence`、`auth`、`credential-security` 套件通过 `55/55`。MCP OAuth 双进程文件中，refresh single-flight、authorization leader 和 leader-kill lease reclaim 用例通过；caller-budget/authorization snapshot 用例两次以同一 missing `authorizationUrl` 断言失败，所以完整文件为 `3/4`，不能写成整套 PASS。

```text
OFFICIAL_CREDENTIAL_SUITES: PASS
OFFICIAL_MCP_OAUTH_REFRESH_RACE: PASS_SYNTHETIC
OFFICIAL_MCP_OAUTH_CROSS_PROCESS_FILE: PARTIAL
GENERAL_ACCOUNT_FAILURE_RECOVERY: NOT_RUN
OFFICIAL_HOST_HELPER_FAULT_INJECTION: NOT_RUN
```

```text
EXISTING_FAILURE_RECOVERY: PASS
OFFICIAL_HOST_FAILURE_MATRIX: NOT_RUN
GENERAL_ACCOUNT_FAILURE_ISOLATION: PASS_SYNTHETIC
GENERAL_ACCOUNT_REFRESH_RACE: FAIL_SYNTHETIC
GENERAL_ACCOUNT_CRASH_LOCK_RELEASE: PASS_SYNTHETIC
GENERAL_ACCOUNT_UNKNOWN_OUTCOME_RECOVERY: NOT_RUN
CLEANUP_PROOF_MAPPING: PARTIAL
PRODUCTION_RECOVERY_SWITCH_AUTHORIZED: NO
```

实现阶段的 Recovery 通过条件是“只完成可证明的 Cleanup，永不自动猜作 Result 或重发 Prompt”，而不是把每个 unknown 状态强行恢复为 released。
