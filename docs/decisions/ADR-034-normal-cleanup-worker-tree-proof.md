# ADR-034：正常官方 Host 清理复用 Worker-tree Proof

> Status: DECISION
> Date: 2026-11-11
> Decision: Accepted — Owner 在 Official Host Integration v1 恢复任务中批准 Existing Bridge Worker-root Recorded-tree Proof。
> Applicability: 正常官方 Host 关闭后的 Bridge Cleanup/Release；异常 Recovery 继续使用既有精确身份与 claimant scan。
> Verified against: Bridge candidate `8e8966d5ec7539a2d8575fc748871a9641fe0a2d` and current fixed-upstream patch; Observed upstream `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`。

## Context

官方 ProcessManager 负责 Executing AppServer、Windows runtime-host helper 及其正常关闭。
现有 Bridge Manager 已保存 Worker exact identity、recorded process tree、resource facts、
Cleanup Digest、SQLite Authority、Hold/Recovery 和 Release CAS。

当前缺口是正常官方 Host 路径还没有把官方 close 事实交给现有 Bridge Cleanup 路径。不能把
`close()` resolved、根 PID 退出或 lifecycle reporter 事件直接映射成 `cleanup_verified`。
也不为本合同新增持久 Job identity、Cleanup Receipt、SQLite 字段或 verifier service。

## Decision

### 1. 正常关闭职责

官方 ProcessManager 独占正常 close。Bridge 保留并记录 close outcome、timeout、错误分类和
关闭时间；Bridge Manager 不并行执行第二个常规 Runtime manager。

### 2. Bridge 独立验证

Bridge 在 close 后独立执行以下门槛：

1. 核对 Operation/Task/Attempt/generation/Claim 与持久 Launch/Worker identity；
2. 确认精确 Worker identity 已退出；
3. 使用现有 Worker-root recorded-tree scan 检查 helper、AppServer 和全部后代；
4. 使用既有 Browser 等 resource facts 检查 Job/Worker tree 外的资源；
5. 生成现有 Cleanup proof 和 digest；
6. 通过现有 SQLite Authority 写 Cleanup 事实；
7. 用返回 revision 和 digest 执行现有 Release CAS；
8. 重读终态，确认释放坐标与 Claim/identity 绑定。

记录树为空、resource facts 完整且 Release CAS 成功之前，不得释放 Capacity 或执行路径。

### 3. Close 结果与清理证据分离

官方 close failure 必须保留，不能隐藏或改写成成功。若 close 返回失败，但精确 Worker 已退出，
且现有 recorded-tree scan 与 resource facts 能证明 helper、AppServer、后代和外部资源均不再
存活，则按既有 Recovery 规则记录清理事实；原始 close failure 作为独立诊断保留。

若 Worker identity 不精确、进程树非空/未知、resource facts 不完整、scan 超时或存在未解决交互，
当前 Operation 保持 Hold/occupied。迟到证据不会自动越过已经发布的 unverified 状态。

### 4. 正常路径与 Recovery

| 路径 | 正常关闭 evidence | 独立验证 | Release |
|---|---|---|---|
| 正常 Result 后关闭 | ProcessManager close result；Worker normal exit | exact Worker identity、recorded-tree empty、resource facts、digest | 既有 Cleanup Verified + CAS |
| Explicit cancel | binding stop/close result；原始 Result 不变 | 既有 cancel intent、exact claimant scan、resource facts、CAS | 既有取消恢复路径 |
| Manager restart / crash Recovery | 已持久 close/exit/resource 事实 | 重新扫描同一 Worker generation/root tree 与资源 | 仅在完整证据 + CAS 后 |
| Close timeout/failure | 保留错误；不得推定为 success | 仅接受可重验的 exact tree/resource facts | 不足即 Hold |

Normal close 与 Recovery 分开收集证据；两者共用既有身份、树扫描、resource facts、SQLite
Cleanup 与 Release CAS，不建立第二套状态机。

### 5. 明确排除

- `close()` 或 `dispose()` resolved 直接生成 `cleanup_verified`。
- 仅检查 Worker/AppServer 根 PID。
- 新 Job identity schema、Cleanup Receipt type、SQLite table/field。
- 新 verifier service 或第二套 Job Manager。
- 降低 Hold、Recovery、Cleanup Digest 或 Release CAS 门槛。
- 将 Browser 等 Job 外资源默认视为官方 Job 已清理。

## Relationship To Existing Decisions

[ADR-009](ADR-009-windows-identity-bound-tree-termination.md) 的精确 Windows identity 与
recorded-tree claimant scan 继续有效。[ADR-018](ADR-018-administrative-abandonment-of-cleanup-incomplete-hold.md)
与 [ADR-024](ADR-024-scoped-sqlite-hold-and-local-cleanup-recovery.md) 的 Hold/Recovery
语义不变。[ADR-032](ADR-032-existing-worker-official-host-integration.md) 的单一官方
ProcessManager 正常生命周期所有权与 Bridge 独立 SQLite Authority 分工不变。

旧研究草案中的持久 Job receipt/verifier service 方向不作为当前目标。历史正文可保留用于追溯，
但不再指导当前 Implementation。

## Verification Contract

生产 Release 接线前至少需要以下合成验证：

```text
OFFICIAL_CLOSE_RESULT_PRESERVED
EXACT_WORKER_IDENTITY
RECORDED_TREE_EMPTY
HELPER_EXIT
APPSERVER_EXIT
BROWSER_RESOURCE_FACTS
PID_REUSE_PROTECTION
MANAGER_RESTART_RECOVERY
CLEANUP_DIGEST
EXISTING_RELEASE_CAS
HOLD_ON_UNVERIFIED_CLEANUP
```

测试至少包括 Worker crash、Worker 退出但 helper/AppServer 存活、AppServer crash、
Browser/外部资源、PID 重用、父进程退出但后代存活、Manager 重启、close timeout/failure 和
cleanup incomplete。活动后代必须保持 Hold；证据不完整时禁止 Release。

## Consequences

正常官方 Host Cleanup 复用现有进程树和 SQLite 证明，不新增持久 artifact 或组件。代价是 Manager
必须可靠保存 close failure，且只能把 recorded-tree/resource facts 当作独立证据；官方 close
成功本身始终不是 Release 授权。
