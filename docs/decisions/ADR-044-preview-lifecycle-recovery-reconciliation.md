# ADR-044：Preview Host Recovery 与 Stable 编号对账

> Status: DECISION
> Date: 2026-11-21
> Decision: Accepted for the Preview.10 release branch

## Context

Stable 与 Preview 在分叉期间各自形成了一套 Host 存活期 Recovery 语义，并各自使用了
`ADR-037` 编号：

- Preview 的 [ADR-037](ADR-037-official-zcode-authentication-reuse.md) 定义官方认证所有权。
- Stable 的 `ADR-037-stable-host-native-recovery.md` 定义 Host 内重复 Recovery 与
  Adapter Cleanup 证据边界。

两边的文件名、主题和实现历史不同。直接把任一分支的 ADR 或生命周期实现机械覆盖到另一
分支，会同时破坏编号可追溯性和 Recovery 的安全边界。

## Decision

1. Preview 的 `ADR-037` 继续专指“复用官方 ZCode 认证”。本发布分支不创建同号文件。
2. Stable 的 `ADR-037-stable-host-native-recovery.md` 在未来 Stable/Preview 对账时使用
   `ADR-044` 编号；本决定只冻结 Preview.10 的编号映射，不修改 Stable 当前历史。
3. Preview.10 以现有同一 Manager 的可重复 `recoverTasks()` 为准：并发调用共享进行中的
   Promise；本 Host 已持有的 active run 延后；一个 Operation 的 Hold 只限制其执行路径；
   Result-less 自动重派发仍受既有安全条件限制。
4. 不对 Preview 机械 cherry-pick Stable `d9e24a0f2`。对账证据必须来自当前 Preview 的
   Recovery/Cleanup/Release 测试和实现，而不是把 Stable 提交是否存在祖先关系当作语义
   证明。
5. 未预期 Pump 异常不再永久冻结 Host 会话。Manager 安排一次有界延后的自动
   `recoverTasks()`；成功时从持久 queued Attempt 恢复派发，失败时保持闩锁并停止后台
   重试，不伪造“已恢复”状态。

## Consequences

Preview.10 具有单一、可测试的 Host 存活期 Recovery 语义，并消除了发布分支内的 ADR 编号
歧义。Stable 历史保持原样；未来把 Stable 生命周期修复带入 Preview 时，必须按本编号映射
和现有测试逐项对账，不得依赖整文件覆盖或提交祖先关系。
