# ADR-025：SQLite Attention 统一等待与 Thin Waiter

> Status: DECISION
> Decision: ACCEPTED — OWNER DIRECTIVE 2026-11-04
> Date: 2026-11-04
> Baseline: 77dd5f14ee61701ac15872192429ecd4f53e1323 (v1.5.0)

## Context

SQLite 已是生产 Task Authority，`tasks`、`attempts`、`manager_operations`、
`manager_interaction_payloads` 和 `manager_operation_events` 已在既有 schema v13
中持有当前状态与回复历史。PR #49 的等待器曾重复扫描 JSONL、配对 Request ID
并维护终态状态机。1.5.0 的 Authority 配置已进一步简化为 SQLite-only；缺库或
损坏库必须 fail closed，不存在业务 JSON 回退。

## Decision

1. 在不改变 schema v13、Task/Attempt 生命周期、Reply 合同、Worker、Result、
   Cleanup、Feedback 或 Observation 的前提下，新增 `readTaskAttention()` 单事务
   只读投影：`{task_id, attempt, status, pending_requests}`。
2. 终态优先于历史 Pending；只读取 current Attempt；按事件序返回多个 Pending；
   reply intent 未收到最终 ACK 时返回既有 `interaction_reply_outcome_unknown`
   错误，不伪造空数组。
3. 不发布独立 `zcode_attention` MCP 工具。`zcode_events` 增加严格可选
   `wait_for: "attention"` 和可选嵌套 `attention`；默认事件输入、输出、cursor
   和长轮询保持不变。
4. Attention 等待只在当前 Attempt Pending、终态、Attempt 变化或超时时返回；
   普通事件不唤醒等待，也不推进原始事件 cursor。结束后用原始 cursor 读取一次
   事件页，再取最终 Attention 权威 snapshot。
5. 插件分发的 `dist/wait-task.mjs` 为只读 Thin Waiter。它复用同一 snapshot
   validator 和等待谓词，不启动 MCP Server、TaskManager Recovery、Worker，也不
   读取 JSONL。它使用 SQLite 正常只读连接和 `query_only`，不使用 `immutable=1`。
   业务数据库与 WAL 内容不得由 Waiter 写入；SQLite 一致读所需的 SHM 变化/空
   sidecar 属于已接受的原生副作用。
6. JSON 内存测试 Authority 显式 unsupported。生产 SQLite-only 配置没有业务 JSON
   Authority；旧 `authority: "json"` 只能作为升级提示解析，缺 SQLite 数据库时
   Waiter 显式失败。

## Rationale

单事务 SQLite 投影消除 PR #49 的终态覆盖、Request ID 前缀配对和 EventTail
UTF-8 跨块解码问题。统一 Events 出口避免重复公共工具，让模型用同一接口获取
决策事实与事件详情；独立 CLI 只解决后台进程不能共享 Host stdio MCP 连接的
生命周期问题。

## Consequences

- MCP 工具数保持 13；`zcode_events` 是向后兼容的 additive 扩展。
- Codex 前台可继续使用 MCP Attention 模式；Claude Code 后台可运行同一 Waiter。
- Waiter 完成通知依赖 Host 后台命令生命周期；Attention 自身不主动唤醒模型，
  也不承诺 Token 降低比例。
- 真实 Claude Code 唤醒与完整 Marketplace Host E2E 必须单独验证；本地合成和
  分发布局启动不能替代真实 Host 认证。
