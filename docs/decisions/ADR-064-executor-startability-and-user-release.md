# ADR-064：Executor 启动能力与用户授权释放

> Status: DECISION
> Date: 2026-11-26
> Decision: Accepted（Owner 在 Preview.18 任务中明确批准）
> Baseline: `origin/preview` `57e0a70b041fe79a18cd0b92f425374a6ae7cfb4`
> Related: [ADR-039](ADR-039-host-authorized-cancellation.md)、[ADR-045](ADR-045-async-executor-ownership.md)、[ADR-051](ADR-051-executor-wake-delivery.md)、[ADR-056](ADR-056-result-readback-contract.md)、[ADR-059](ADR-059-owner-binding-and-installed-auto-wake.md)、[ADR-060](ADR-060-executor-crash-recovery-and-release-fact-continue.md)

## Context

Preview.17 中，一个历史 `launch_intent` 缺少 Launch Receipt，或一个 Worker
身份无法立刻证明退出，都会触发
`EXECUTOR_RECOVERY_WORKER_ACTIVE` 并阻断整个 Executor。这把 Operation 级
不确定性放大成了 Authority Root 级停摆；其他 Task 与 Workspace 无法继续。

同时，普通取消不能释放带着不可验证 Spawn 证据的异常 Attempt；用户缺少
保留全部事实并解除 Bridge 占用的最终决定权。跨进程锁用 PID 存在性判断
死亡，存在 PID 复用风险。分页 Result 的内容摘要与 Result 信封摘要曾被
文档混用。

## Decision

### 1. Worker 不确定性按 Operation 隔离

- 历史 Worker 全局启动门禁退役。缺 Receipt 的 `launch_intent`、活动或身份
  未知 Worker 只保留在对应 Operation，输出
  `EXECUTOR_WORKER_OPERATIONS_RETAINED`。
- SQLite 的 Workspace fence、permanent Claim、generation/revision CAS 和
  capacity 继续阻止同一 Workspace 双执行；不新增调度锁。
- 不自动重派不确定 Attempt；Lease 只有在旧 Executor 被精确身份证明退出后
  才安全归档。
- `executor-recovery.lock` 使用平台 exact startup fingerprint。只有平台明确
  `absent` 才能回收；查询失败、legacy 记录、PID 复用或指纹不匹配继续
  fail closed。
- `WRITER_INTENT` v2 记录 PID、平台、身份版本和 exact startup fingerprint。
  Store 重新打开时，只有该进程被平台证明 absent 才把 intent 原名归档；
  SQLite 随后的 schema、integrity 与投影校验决定事务是否可用。legacy、
  损坏、跨平台、live、复用 PID 或未知身份继续 fail closed。SQLite
  `BEGIN IMMEDIATE` 仍是事务互斥权威；intent 只保留崩溃后“不能猜测
  COMMIT 结果”的证据价值。

### 2. 用户最终放弃权走 SQLite

- WebUI Task 详情提供“授权清理”，不新增管理页面或第二状态机。
- HTTP 请求必须显式提供
  `release_mode=user_authorized_unverified_release` 与
  `accept_worker_risk=true`；操作只作用于选中的当前 Task/Attempt。
- Manager 调用同一 SQLite Authority 的 forced preclaim release，绑定持久
  `launch_receipt_digest`，写入 `worker_risk_accepted=true`，并把 Operation
  原子推进为 `released`。
- 历史 Task、Attempt、Launch Intent、Receipt、Result、Cleanup、Recovery 与
  Wake Event 全部保留；不伪造 `cleanup_verified`、Worker 退出或执行成功。
  Projection 显示 `administrative_release` / unverified。
- 若 Worker 可能仍存活，UI 确认文本必须明确 Workspace 并发写入风险；拒绝
  或缺少风险确认时后端不改动状态。禁止一次批量释放所有 Task。

### 3. 可靠性与证据边界

- Worker spawn 的异步 OS `error` 事件必须被观察，避免 Manager 崩溃。
- Executor Lease 使用 `wx` 原子创建、完整写读回校验；失败不得自动重试。
- `result_digest` 是 Result envelope 摘要；`result_content_digest` 是分页
  拼接后的 canonical Result 内容摘要。两者不相等是正常合同，不是错误。
- Release 后 Wake 恢复复用现有 Executor Wake Observation：没有
  `executor_wake` fact 的已发布非取消 Result 会在 Authority 启动恢复路径
  中重新进入同一 coordinator。ADR-059 的 Late Wake Compensation 不再有生产
  创建者；历史事实继续只读保留。
- Result Worker identity、Wake evidence 和 JSON projection 读取都有字节
  上限；MCP 页面不得超过显式预算。

## Non-Changes

- 不改变单 Executor / Authority Root、SQLite v14、Worker、官方 AppServer、
  Host 连接和 WebUI 架构。
- 不新增 Supervisor、第二 Authority、管理服务或任务状态机。
- 不自动放弃不可信任务，不删除执行历史，不把未知改写成成功。
- 已有健康 Executor 时 Host 只连接复用；一个 Root 仍不允许两个 Executor。

## Verification Status

- Executor recovery 真实进程套件：13/13 PASS，包含 live Worker 保留、无
  Receipt 保留、Thin MCP 恢复且不二次 Spawn。
- SQLite writer intent：35/35 PASS，包含 legacy fail closed 和 exact-absent
  身份归档。
- Forced cleanup、Result paging、process lock PID reuse 有定向故障注入
  测试。
- 本机完整 `npm run test:full`、Windows/Ubuntu Release Gate、真实 Host 重连
  与真实 Worker 放弃场景以 Preview.18 最终报告为准；未运行项必须标记
  `NOT_RUN`。
