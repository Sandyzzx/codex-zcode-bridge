# G3：Cleanup Proof 与 Bridge Release 映射

> Status: RESEARCH — R7/R9 NORMAL RUNTIME CONFIRMED / MAPPING PROPOSED / NOT ACCEPTED
> Date: 2026-11-11
> Bridge baseline: `9710303397fe2d544c75698f783a8174404b2d51`
> Observed upstream: ZCode `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`，`3.18.0`
> Related draft: [ADR_PROPOSALS.md](../zcode-companion-owner-architecture-convergence-2026-11-11/ADR_PROPOSALS.md)
> Evidence level: 只读源码核对、现有 Bridge 合成回归、固定 helper acceptance，以及 r7/r9 官方 ProcessManager localhost Mock。未创建真实 Task、真实账户请求或生产 Release。

## 1. 结论

官方正常关闭链在语义上强于“root PID 退出”，但它当前不能直接满足 Bridge 已验证的持久 Cleanup Proof：

- `WindowsRuntimeHost.close(deadlineAtMs)` 成功等待 Job empty 和 helper exit，但公开返回 `Promise<void>`；
- Job 名在 Host 内部生成，没有 typed、可持久、可恢复的 identity/receipt；
- ProcessManager cleanup Promise 和 lifecycle callbacks 不携带完整 Job closure；
- 现有 Bridge 验证器只接受 recorded-tree receipt/claimant scan、特定 `adapter_not_started` 或 test fake；
- 现有 SQLite Release 要求 Result 坐标、Worker exact identity exit、完整 process/resource evidence、verified Cleanup digest 和 CAS Release。

因此不能把 `disposeAndWait()` resolved 或 `WindowsRuntimeHost.close()` resolved 直接转换成 `cleanup_verified`。当前映射状态为 `PARTIAL`，新 proof 合同仍为 Proposed。

```text
OFFICIAL_RUNTIME_CLEANUP_RUNTIME: PASS_FOR_ISOLATED_MOCK
BRIDGE_CLEANUP_MAPPING_AND_CONTRACT: PARTIAL / PROPOSED
CLEANUP_PROOF_CONTRACT: PROPOSED
PERSISTENT_JOB_PROOF_EXPORT: MISSING
PRODUCTION_RELEASE_SWITCH: BLOCKED
```

## 2. 必须分开的事实

| 层级 | 事实 | 当前证据 | 能否单独 Release |
|---|---|---|---|
| 1 | Agent turn 产生 outcome | 官方 turn/event/result | 否 |
| 2 | Bridge Result 已提交 | SQLite Result CAS | 否 |
| 3 | AppServer root 已退出 | root event/PID probe | 否 |
| 4 | 官方 Job 内 `ActiveProcesses == 0` | 当前只在 helper/internal close 中可见 | 否，尚缺持久 proof |
| 5 | helper 已退出 | internal close/exited promise | 否，尚缺持久 proof |
| 6 | Browser/外部资源已关闭或未创建 | owner-specific facts | 否，须与 4/5 合并 |
| 7 | Worker exact identity 已退出 | Manager process probe | 否，只是前置条件之一 |
| 8 | Bridge 接受完整 Cleanup evidence | exact-key verifier + SQLite event | 可进入 Release 步骤 |
| 9 | Capacity 已释放 | CAS Release projection | 是最终 Release 结果 |

## 3. 官方可观察到什么

### 3.1 正常关闭

`packages/services/src/windows-runtime-host/contract.ts:3-15` 明确：

- `onRootExit` 只报告 root；
- `close(deadlineAtMs)` 成功条件包括 Job empty 与 helper exit；
- 失败可以重新等待。

`packages/services/src/windows-runtime-host/index.ts:218-248` 的实现等待内部 `empty.promise`，并在 helper 异常退出时以唯一 Job 名执行 `--check-empty`。该名称只存在于当前 Host closure，公开对象没有 getter。

### 3.2 Job 与 native helper

`scripts/windows-runtime-host/main.cpp` 证明：

- Job 使用 `KILL_ON_JOB_CLOSE`；
- CLI 在 suspended 时通过 Job-list creation attribute 归组；
- root exit 触发 Job termination；
- `empty` 只在 `ActiveProcesses == 0` 且 root exited 后发送；
- `--check-empty` 可在 helper exit 后按 Job 名只读核验。

这些是可复用的关闭机制，不等于公开的 Bridge evidence API。

### 3.3 ProcessManager

`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:875-1049`：

- 正常调用 `disposeAndWait`；
- 等待 exit diagnostics；
- Windows cleanup 与一次 retry 共用约 3.25 秒；
- cleanup 真正完成才从 `ownedProcesses` 删除；
- 失败保留 ownership，供后续主动请求重新处理。

这满足正常生命周期 ownership，但没有输出 Bridge 所需的结构化 Job receipt。

### 3.4 r7/r9 正常关闭与恢复实测

r7 与当前最新的 r9 各 12 个结构化断言全部通过，覆盖官方 ProcessManager start、官方 `Read` 后第二次模型请求、220 tokens usage、normal close、同一 session resume、cancel ack/terminal 和 final close。

两代 runtime identity 和精确目标 PID：

| 代次 | runtime identity | AppServer PID | Helper PID | 关闭后观察 |
|---|---|---:|---:|---|
| generation 1 | `<workspace>:1:23176` | `23176` | `23820` | target set `[23176, 23820] -> []` |
| generation 2 | `<workspace>:2:6428` | `6428` | `2548` | target set `[6428, 2548] -> []` |

最终目标集合 `[23176, 23820, 6428, 2548]` 也为空。lifecycle reporter 记录 2 次 spawn 和 2 次 expected exit（exit code 0、reason `workspace-dispose`）。`managedProcessesAfterClose` 与 `managedProcessesFinal` 都是空数组。

这证明正常 Mock 路径的目标进程清理和 generation 切换可观察。它仍没有导出可持久 Job handle、kernel `ActiveProcesses=0` receipt 或 helper-exit receipt，所以不能把 r7/r9 的 `PASS` 直接升级成 Bridge `cleanup_verified`。

## 4. 现有 Bridge Proof Contract

现有 Worker 只构造以下 source/method：

- `zcode_app_server_adapter` + `verified_windows_tree_receipt`；
- `zcode_app_server_adapter` + `verified_recorded_tree_scan`；
- `zcode_app_server_adapter` + `adapter_not_started`，且 reason 必须为 `start_plan_preflight_rejected`；
- explicit test fake。

依据：

- `src/worker/worker-main.ts:589-639`
- `src/store/lifecycle-gate.ts:2898-2980`

正常 Cleanup 的要求位于 `src/store/lifecycle-gate.ts:2569-2721`：

1. 校验持久 Claim/launch/identity 坐标；
2. 写 `cleanup_pending`；
3. 要求 Worker exit code 0；
4. 要求 proof 被现有 exact-key verifier 接受；
5. 用 Manager 进程探针确认同一 Worker PID/start fingerprint 已退出；
6. 写入完整 process/resource facts 与 digest；
7. `recordCleanupEvidence({ outcome: "verified" })`；
8. 用返回 revision 与 cleanup digest 执行 CAS `releaseCapacity`；
9. 重读投影，确认 `released`、generation、Claim 与 identity digest。

缺少任一步都只能记录 unverified/Hold。Result、Worker exit 或 PID absence 都不能替代 execution proof。

## 5. 推荐的最小证明形状

目标 proof 仍应先作为 Proposed 合同审查。最小 typed fact set 应至少包含：

```text
official_runtime_generation
official_runtime_root_pid
official_runtime_root_start_fingerprint
helper_pid
helper_start_fingerprint
job_scope_or_opaque_id_digest
job_owner_generation
root_exit_observed_at
job_empty_observed_at
helper_exit_observed_at
cleanup_deadline
cleanup_outcome
managed_browser_cleanup_verified
additional_resource_scope
sanitized_failure_class
canonical_digest
```

持久化要求：

- Job identity 可跨 Manager 重启重新查询，或由一个可信 verifier 对现存事实重新采样；
- proof 绑定 Operation/Task/Attempt/Generation/Claim/Worker identity/runtime generation；
- root exit、Job empty、helper exit 三个时间/状态不可互相替代；
- close 超时和 helper 异常退出必须有明确 unknown/unverified 分类；
- Browser 和其它 Job 外资源分别声明 `verified` 或 `not_created`；
- proof 不得包含 credential、prompt、tool payload、cookie、device secret 或原始进程命令行；
- Manager 必须保留 exact-key/source/method 验证和 CAS，不接受“自由 JSON + 自证 true”。

## 6. 两种实现路线

### 6.1 窄的官方 observation 出口（优先）

扩展固定上游的最小导出，使 WindowsRuntimeHost/ProcessManager可以返回或重新查询：

- opaque Job observation handle；
- root runtime identity；
- root exit、Job empty、helper exit；
- helper retry/probe 结果；
- deadline/error classification。

要求通过普通 typed API 暴露，不解析文本日志、不 monkey-patch、不复制官方核心。

### 6.2 Bridge 独立 verifier（条件备选）

若无窄出口，可保留 Bridge 自己创建/拥有的 Windows Job 或等价闭包，并对官方 runtime 提供原子归组。该路线必须先证明：

- 不形成第二套常规 ProcessManager；
- 能覆盖 Host/AppServer 和所有创建期间的后代；
- root exit、PID reuse、spawn/assign 竞争、Worker/Host 崩溃都可恢复验证；
- Browser/Job 外资源不被错误并入；
- Recovery 后可重新建立同一归属或明确永久 Hold。

普通 recorded PID scan 只有在证明其闭包覆盖与 Job 等价、且所有后代在创建时无逃逸窗口时才可作为候选；仅“扫描时没看到孩子”不够。

## 7. 不接受的捷径

- `dispose()` 返回即 `cleanup_verified`；
- `close()` 返回即把 void 包装成 receipt；
- 把 Job 名写进自由文本日志再解析；
- 只检查 AppServer root PID；
- 用进程名、命令行 grep 或 `Get-Process` 批量清理；
- 把 Browser cleanup 默认视为 Job 内；
- 在现有旧 proof union 中塞入不兼容字段并放宽 verifier；
- Close 超时后直接 Release；
- 为了让单实例 POC 通过而减少 Capacity 或增加 task-long 账户锁；
- Worker exit code 0 代表整个进程树已退出。

## 8. 失败与恢复映射

| 场景 | 持久结果 | Release |
|---|---|---|
| Result committed；close 成功但无 accepted proof | `cleanup_pending`/`cleanup_unverified` | 否 |
| Root exit；Job 仍非空 | `cleanup_unverified`，保留实际占用 | 否 |
| Job empty；helper 尚未退出 | close 未完成，保留 ownership | 否 |
| Helper 异常退出；Job 名可查且为空 | 仅在证据持久合同接受后转 verified | 条件通过 |
| Helper 异常退出；核验失败 | unknown/Hold | 否 |
| Browser cleanup 失败 | 即使 Job empty 也 unverified | 否 |
| Worker exact identity 未退出/未知 | Hold | 否 |
| Cleanup verified 后 Release 未知 | 保留 poison/Recovery fence，不猜 fallback | 否 |
| Recovery 重验 exact identity + 完整 closure 成功 | CAS 记录 verified 后 Release | 是 |

## 9. Proposed ADR 边界

Cleanup 草案继续为 **Proposed only**。ADR-032 Accepted 只冻结“不得降低现有门槛”和“必须形成新映射”，不批准：

- 新 proof method/schema；
- 新 SQLite migration；
- 新 Recovery 分支；
- 上游源码 patch；
- Bridge 自建常规 Job manager；
- 生产切换或 POC 运行。

任何在上述方向中影响持久 Cleanup/Release 的行为，须先接受专门 Cleanup ADR。

## 10. 验证状态

现有 Preview.3 Cleanup/Release 回归：

```text
139 tests, 139 pass
```

覆盖包括 exact Operation/Claim/Worker binding、Result-only 不释放、unknown probe/Hold、Cleanup reverify、CAS Release、PID reuse、真实 recorded-tree claimant scan。

官方 Host/helper runtime 与 Job proof export：

```text
OFFICIAL_HELPER_ARTIFACT: PASS
OFFICIAL_HELPER_ACCEPTANCE: PASS
OFFICIAL_PROCESS_MANAGER_NORMAL_RUNTIME: PASS_FOR_ISOLATED_MOCK
PERSISTENT_JOB_PROOF_EXPORT: MISSING
CLEANUP_PROOF_MAPPING: PARTIAL
CLEANUP_PROOF_CONTRACT: PROPOSED
PRODUCTION_CREDENTIALS_READ: NOT_OBSERVED_NON_INSTRUMENTED
DESKTOP_PROCESS_STARTED: NOT_DETECTED_BY_EXPLICIT_LAUNCH
DESKTOP_MAIN_INDEPENDENCE: NOT_RUN
PRODUCTION_RELEASE_SWITCH: BLOCKED
```

现有 139 项回归证明旧合同仍成立；helper acceptance 和 r7/r9 证明隔离 Mock 下正常官方路径执行与目标 PID 清理。二者都不能替代持久 Job proof、真实账户证据或生产 Release 合同。
