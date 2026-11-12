# G3：Cleanup Proof 与 Bridge Release 映射

> Status: RESEARCH — ADR-034 IMPLEMENTED IN CANDIDATE / FULL RESOURCE MATRIX PARTIAL
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对 `OfficialHostAdapter`、Worker/lifecycle cleanup proof、Windows tree tests 和当前完整回归
> Verified against: Bridge candidate `8e8966d5` + documentation changes；upstream `b95ebaff` / 3.18.0

## 结论

正常官方 Host 关闭后，Bridge 复用现有 Worker-tree Cleanup 合同，没有增加持久 Job receipt、新的 verifier service 或 proof schema。官方 management 与 Bridge 独立验证共同工作：

```text
official ProcessManager close
  -> preserve close result/failure
  -> verify exact Worker identity exit
  -> recorded-tree claimant scan for helper/AppServer/descendants
  -> existing Browser/other resource facts
  -> Cleanup Digest
  -> SQLite cleanup event
  -> existing Release CAS
```

`close()`、`dispose()` 或根 PID 退出都不是单独的 Release 授权。

## 独立验证

Cleanup proof 绑定 Operation、Task、Attempt、generation、Claim 和 Worker identity。当前接受的 proof methods 包括：

- `adapter_not_started`：Start Plan preflight 等路径在 Adapter 启动前拒绝，并保留可查询原因。
- `verified_recorded_tree_scan`：Adapter 已启动、原 root generation 已退出或已按身份终止，recorded-tree scan 未发现存活 claimant。
- 既有 Windows identity-bound termination receipt：live tree 在同一原生句柄内验证身份后终止，再由 claimant scan 补齐已退出根/后代事实。

close failure 作为独立诊断保留。若 close 报错，但 exact Worker identity、recorded-tree scan、resource facts 均能证明关闭，现有 Recovery 规则可记录 verified Cleanup；这不表示 close 成功。

## 失败语义

以下情况必须保持 `cleanup_unverified` / Hold，不释放 Capacity 或 Workspace：

- Worker identity 缺失、错误或无法精确取指纹
- 原根仍在运行，或 recorded-tree 中存在存活 claimant
- scan timeout/error、observed PID 不完整、PID reuse 无法排除
- resource facts 缺失
- 未解决 interaction 或 Operation/Claim/generation 不匹配
- late evidence 试图越过已持久化的 unverified 状态

Manager restart 和无 Result Recovery 继续读持久事实并保留占用。不会仅因为官方 ProcessManager 已经不管理目标而重建 Result、重派任务或释放路径。

## 已运行证据

- `official-host-adapter.test.ts` 覆盖 clean scan、live tree、missing/incomplete evidence、helper/AppServer entrypoint、runtime identity、shipped assets 和 16 MiB frame。
- 当前 official-host/plugin/platform suite 为 32/32 `PASS`；focused contract 复跑为 64/64 `PASS`。
- Windows cleanup tests 覆盖 root-exited race、PID reuse、real descendant claimant 和 identity wait。
- 最终完整隔离回归的 936 项覆盖正常 close、Worker crash、late cleanup、manager restart、resource facts 缺失与 Release CAS。

## 缺口

6 个 BOM keyring 文件已纳入候选；提交后的 clean-checkout 加载和资源闭包验证仍待执行。完整 native helper/后代/第三方工具/Browser 组合的资源闭包、所有 crash timing、长时间 soak 和全部 Windows Terminal/Job 边界仍为 `PARTIAL`。没有执行真实任务的 Cleanup 性能/容量验证。

Official Host 制品升级与回滚演练为 `NOT_RUN`，不能借 SQLite v13→v14 测试替代。

## 关联决定

[ADR-034](../../decisions/ADR-034-normal-cleanup-worker-tree-proof.md)、[ADR-009](../../decisions/ADR-009-windows-identity-bound-tree-termination.md)、[ADR-018](../../decisions/ADR-018-administrative-abandonment-of-cleanup-incomplete-hold.md)、[ADR-024](../../decisions/ADR-024-scoped-sqlite-hold-and-local-cleanup-recovery.md)。历史旧草案中的持久 Job receipt 与独立 verifier 方向不进入当前实现。
