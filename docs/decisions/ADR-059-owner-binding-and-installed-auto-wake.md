# ADR-059：Owner Binding 与安装即生效的 Auto Wake

> Status: DECISION
> Date: 2026-11-24
> Decision: Accepted（Owner 于 2026-11-24 明确批准 Preview.16 实现决策）
> Baseline: `origin/preview` `fa44b901fe3bb7b403905e7fead791733c69fa60`
> Related: [ADR-045](ADR-045-async-executor-ownership.md)、[ADR-049](ADR-049-task-cli-control-surface.md)、[ADR-050](ADR-050-local-task-web-console.md)、[ADR-051](ADR-051-executor-wake-delivery.md)、[ADR-052](ADR-052-async-master-handoff.md)

## Context

R10 调查确认 Wake 没有恢复原 Codex Thread：直接触发条件是
`wake-policy.json` 缺失（`policy_missing`），但更根本的缺陷是 Bridge 从未
持久化可信的原 Codex Thread Owner Binding。Wake Observation 的
`thread_id=null`，App Server Preflight、Wake Intent 和 Codex Queue 均未
执行；`web_notify` 只是 fallback observation，不等于通知送达。原 Thread
后来出现的人工 Composer Turn 不属于 Bridge Wake。

同时，Wake 专用授权文件把“安装并启用插件”之外的逐任务授权变成了新的
失败点，与单用户本机 Trusted Local 合同不一致。

隔离真实 stdio MCP 探针已证明：真实 `tools/call` 的
`params._meta.threadId` 携带当前 Codex Thread，SDK 可通过
`ctx.mcpReq._meta.threadId` 读取；A/B/C 三个 Thread 交叉绑定通过；
`ctx.sessionId` 为 null。SessionStart Hook 不作为身份来源。

## Decision

### 1. 可信 Thread 身份来源

- 唯一身份来源是 `zcode_task` MCP handler 的
  `ctx.mcpReq._meta.threadId`。
- 该值必须是规范 UUID；缺失或非法分别记录
  `mcp_meta_missing` / `mcp_meta_invalid`。
- Thread ID 不是模型可控的 TaskPackage 字段。`zcode_task` 输入中出现
  `thread_id`、`codex_thread_id`、`owner_thread_id`、`owner_thread` 或
  `owner_binding` 一律以 `TASK_INVALID` 拒绝。
- ZCode Runtime Session ID 永远不得作为 Codex Thread ID。

### 2. Owner Binding 属于受理合同

- Task 可靠受理、Attempt 创建和 Worker Spawn 之前必须完成 Owner Binding
  持久化；Task、首个 Attempt 与 Binding 在同一 SQLite 事务内写入。
- Binding 存在同一 Authority 的 additive 表 `task_owner_bindings`，不新建
  JSON 文件、独立授权文件或第二数据库。SQLite Schema 版本仍为 v14。
- 每个 Task 一条 Binding；Continue 保持 Task 级归属，不重新猜测 Thread。
- Executor 重启后 Binding 仍可读取；缺失的历史 Task 在打开 Authority 时
  回填为 `legacy_unavailable`。
- 可信身份不可得时正常受理 Worker，但 Binding 明确记录
  `owner_thread_unavailable`，不得宣称自动 Wake 可用。

### 3. 退役 Wake 专用授权

- 完全移除 `wake-policy.json`、Owner Grant、`not_granted`、模型/Provider/
  Effort 匹配、App Server Control Socket 存在性以及 Thread loaded/idle
  状态作为 Queue 的前置授权门禁。
- 不新增替代授权机制。
- 安装并启用插件即接受本机 Auto Wake 合同；Auto Wake 默认开启，用户可在
  WebUI Settings 关闭。关闭时只记录 `web_notify`（`auto_wake_disabled`）。
- Queue 投递仍保留幂等、`submission_unknown` 未知提交保护和完整 Wake 事实
  记录。

### 4. Wake 事实与语义

交付顺序固定为：

```text
Result committed -> Cleanup verified -> Operation released
                 -> Wake intent -> official Codex Queue -> Turn observation
```

必须分别记录并可独立查询：

- fallback observation persisted（`web_notify`）
- WebUI status visible
- actual notification delivered
- Queue submitted（`queued`，含 `queue_message_id`）
- Queue acknowledged
- original Turn started（`turn_started`）
- Master accepted

`web_notify` 不等于送达；Queue ACK 不等于 `turn_started`；Task
`completed` 不等于 Master 验收。历史 Wake Observation 不得改写；同一
Operation 的 delivery 不得用另一个 `delivery_id` 覆盖。

### 5. Late Wake Compensation

- 历史未投递 Operation 的补偿使用独立、可审计的
  `executor_late_wake_compensation` 事实，不修改原 `web_notify`。
- 补偿不重跑 Worker，不改变 Result、Cleanup、Release、Attempt 或容量。
- 只允许原 Wake 历史仅含 `web_notify`、且从未出现 `queued` /
  `submission_unknown` / `turn_started` 的已释放 Operation。
- 每个补偿使用独立 `delivery_id`，幂等重放同一状态；不自动批量唤醒历史
  任务。

### 6. Task Console 链接

- `zcode_task` / `zcode_continue` 的 MCP receipt 增加 additive
  `console_link`，在可靠受理后由 Host 侧经同一 Executor Lease 和 live
  `/api/session` 验证生成。
- 链接失败不得把已受理 Task 变成错误；receipt 保持成功，并记录稳定的
  `reason_code`，Master 使用 `task status` 作为安全替代。
- 链接只携带 `task_id`，不包含 CSRF 或凭据。

## Non-Changes

- 不改变 Task/Result/Cleanup/Release/Recovery 状态机。
- 不改变 SQLite v14 版本号；`task_owner_bindings` 是同一 Authority 的
  additive 扩展。
- 不恢复 JSON Authority、全局 `current_thread_id` 或独立 Session
  Registration 服务。
- 不把 Queue ACK、`web_notify` 或 Task `completed` 当作 Turn Started 或
  Master 验收。

## Verification Status

- 隔离 MCP 身份探针：`PASS`（真实 stdio `params._meta.threadId`，A/B/C
  交叉绑定）。
- 定向实现测试：`PASS`（Owner Binding 持久化/隔离/Continue/重开、
  Auto Wake 默认开启与关闭、无 `wake-policy.json` 的 Queue、ACK 与 Turn
  Started 分离、Late Wake 不改写历史）。
- 完整 `npm test`：`PASS`（1131 tests / 1129 pass / 2 platform skip /
  0 fail，2026-11-24；含 schema-integrity 并发写锁与真实 Chromium
  Web Console）。
- Preview.15 库隔离副本无感升级：`PASS`（39 Tasks / 42 Attempts / 482
  Operation Events / 4341 Runtime Events 保持不变，Binding 回填为
  `legacy_unavailable`，连续 open 与并发写者下 open 零写入）。
- 正式安装制品 + 真实 Codex Host + 真实 ZCode Runtime 的非空工程
  Completion Wake E2E：`PASS — REAL`（Thread
  `01a20dfc-c2c0-77f0-9b38-5bf4caed941d`；Result/Cleanup/Release 后
  1 次 Intent、1 次官方 Queue、原 Thread 新 Turn
  `01a20e01-495a-7d43-98cc-e9febbc75966`；Master 在新 Turn 用原生 MCP
  回读同一 Attempt 并独立复跑验收命令）。证据见
  [preview16-real-host-e2e-20261124](../reports/preview16-real-host-e2e-20261124.md)。
- 未验证：Desktop fully exited、notLoaded、严格 Wake C/D、Official Runtime
  provenance。
