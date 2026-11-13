# G4：账户并发、刷新与 revision 收敛

> Status: RESEARCH — SYNTHETIC COORDINATION PASS / REAL ACCOUNT E2E NOT RUN
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对 patch `0002`/`0003`、ADR-033、12 项固定上游合成测试和当前 Bridge 完整回归
> Verified against: Bridge candidate `ba25f837` + documentation changes；upstream `b95ebaff` / 3.18.0

## 结论

固定官方源码原先在 credential file lock 之外执行网络 refresh；两个 Worker 可同时使用同一一次性 refresh token。候选通过 patch `0002-oauth-refresh-coordination.patch` 和 `0003-account-runtime-header-coordination.patch` 引入了 profile-scoped refresh transaction。目录锁仍保护文件，但不再被当作远端 refresh 的 cross-process single-flight。

合成矩阵已经通过，证明实现覆盖设计要求。真实 OAuth、真实 token rotation、真实账户 A→B→A 切换和服务端对并发刷新的一致性仍为 `NOT_RUN`。

## 事务顺序

```text
acquire profile-scoped independent refresh lock
  -> reread credential snapshot, revision, generation, and active profile
  -> if a usable newer token set is published, reuse it without network
  -> otherwise write a durable dispatch marker
  -> perform exactly one bounded network refresh
  -> persist with expected-snapshot/CAS and atomic publication
  -> refresh live runtime-header/account context
release lock
```

锁 identity 绑定规范化 credential path、provider、profile/account identity 和 lock schema version。不同 profile 可并行；同一 profile 只串行 refresh 事务，不锁 Task、Attempt、Session、模型流或整个 Worker。

## 失败与迟到响应

- 网络请求前写入 dispatch marker，区分“尚未开始”和“可能已消费一次性 token”。
- timeout 或 crash 后不自动向 Provider 再发一次 refresh；可能已消费的 token 必须视为 unknown。
- lock-time reread 与 CAS 拒绝 stale writer。较旧 revision 不能覆盖新 token set。
- 迟到响应只能产生受控错误/诊断，不能恢复旧 JWT、旧 refresh token 或旧 revision。
- live runtime-header 在下一次 auth material 生成前读取最新 revision/generation。
- A→B→A 回到 A 时重新验证当前 active profile，不复用绑定到旧 generation 的响应。

## 验证

固定上游 12/12 合成测试覆盖：

- 同 profile 只有一个网络 refresh
- different-profile parallelism
- lock crash/stale recovery
- timeout 与 late response
- atomic publish 与 CAS
- stale writer
- live header revision propagation
- account A→B→A 隔离
- 不重试可能已消费 token

最终 Bridge 完整隔离回归的 936 项还覆盖 private lease 在 cancel、Worker exit、ACK loss、EOF、重复 consumer 和账户切换时不重放。真实网络/账户行为不属于这些结果。

## 保持不变

[ADR-030](../../decisions/ADR-030-start-plan-provider-preflight.md) 未修改：每 Issuer/Task 一次权威 Billing verdict、Private Lease/HANDLE/ACK、完全相同绑定复用、fail-closed 和不跨任务缓存继续有效。Refresh lock 不是 Billing authority，也不能把 refresh 成功当作 Start Plan 权益。

## 缺口

真实 OAuth refresh、token rotation、账户切换、Billing、Start Plan/Coding Plan 模型请求、跨平台文件锁行为、provider 特定 refresh 语义和生产 profile 迁移均未运行。
