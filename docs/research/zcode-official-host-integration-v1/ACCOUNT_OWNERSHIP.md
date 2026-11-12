# G4：账户所有权与权益事实

> Status: RESEARCH — ACCOUNT PATH IMPLEMENTED / REAL ACCOUNT E2E NOT RUN
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对 ADR-030、Worker issuer、private pipe、fixed OAuth patches 和当前完整回归
> Verified against: Bridge candidate `8e8966d5` + documentation changes；upstream `b95ebaff` / 3.18.0

## 所有权分层

| 事实 | 所有者 |
|---|---|
| Task/Attempt/Claim、Billing verdict 生命周期、Private Lease/HANDLE/ACK | Bridge SQLite Authority 与 Manager |
| 官方 credential/profile/token set、refresh lock、refresh dispatch marker | 固定官方源码的 account/OAuth service |
| 单任务 credential 交付和撤销 | Worker 私有 pipe，绑定 Task/Attempt/Claim/account/provider/model |
| 模型请求和 runtime auth header | 官方 AppServer |
| task 终态、Cleanup 与 Release | Bridge，独立于账户状态 |

Bridge 不新增 Credential Broker、账户数据库、Companion 服务或第二套任务状态机。Officia Host 在现有 Worker 内运行，并复用官方账户实现。

## Start Plan

[ADR-030](../../decisions/ADR-030-start-plan-provider-preflight.md) 原样有效：

- 每个 Issuer/Task 执行一次权威 Billing verdict。
- prepare 与 issue 在 account/provider/model/device/credential digest/expiry 完全匹配时复用该 verdict。
- 身份或绑定变化必须重新授权。
- Private Lease 只进入匹配的 turn；HANDLE/ACK 有明确期限，不跨任务缓存。
- Billing reject、unknown、账户变化或交付失败均 fail closed，不伪造 successful Result，也不静默 fallback。

Coding Plan 保持官方账户/API Key 路径，不经过 Start Plan Billing。

## Refresh 与并发

ADR-033 的 refresh coordination 已实现为两个固定上游 patch：

- profile-scoped independent lock
- lock-time credential reread
- network dispatch marker
- exactly one refresh network transaction
- expected-snapshot/CAS publish
- stale writer 与迟到响应隔离
- timeout/crash recovery
- 不重试可能已消费的一次性 token
- live runtime-header refresh
- A→B→A account isolation

不同 profile 可以并行，并保持现有 Worker 并发。相同 profile 只在 refresh 事务上串行，不把 Task、Attempt、Session 或整个 Worker 串行化。

## 合成验证

固定上游 12/12 账户测试通过；最终 Bridge 完整隔离回归的 936 项也覆盖同一 lease 的重放、ACK loss/EOF、迟到 issuer、cancel、Worker exit、duplicate consumer 和账户切换。

这些测试使用合成 credential 和 Mock provider。它们不读取生产凭据，不访问真实 OAuth/Billing/Model 服务。

## 未运行

- 真实登录账户和真实 refresh token rotation
- 365/网络超时或服务端已消费但客户端未知的真实响应
- Start Plan/Coding Plan 真实模型请求
- 真实 Billing verdict、拒绝、CAPTCHA 或 unusual activity
- 生产 profile 的升级/迁移
- 跨平台 refresh lock 行为

## 结论

账户职责与并发合同已在源码和合成测试中闭合；生产账户能力和远端服务语义仍为 `NOT_RUN`。不能用历史 Preview.3 单模型成功替代 Preview.4 固定 Host E2E。
