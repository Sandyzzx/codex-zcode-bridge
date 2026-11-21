# ADR-048：默认 Event 页的有界读取

> Status: DECISION
> Date: 2026-11-22
> Decision: Accepted for the 2.0.0 Preview integration
> Baseline: `450c18afc0c8af2700734399c5aebd87a36df795`

## 决定

`zcode_events` 在调用方省略 `max_bytes` 时使用 **32 KiB canonical JSON 页预算**。
显式传入 `max_bytes` 时仍是原来的硬预算，不自动返回超限事件。

默认预算只限制单次 MCP 响应，不删除、过滤或改写 SQLite 中的持久 Event。预算在
summary 合并和 `include_attempt` 投影之后计算。`scan_incomplete: true` 时调用方使用
`scan_cursor` 从同一扫描位置继续；没有 `scan_incomplete` 时继续使用既有
`next_seq`。`has_more` 和 `scan_incomplete` 任一为真都必须继续读取。

为避免首个 Event 本身超过默认预算导致 cursor 永久不前进，默认模式允许返回一个
超限 Event，并把 `next_seq` 推进到该 Event。显式 `max_bytes` 保留原行为：返回空页、
`scan_incomplete: true` 和未推进的 cursor。Permission、Interaction、错误、Hold、
Cleanup、取消与终态 Event 都适用同一 cursor 合同，不因默认预算被去重或隐藏。

## 兼容性

工具名、输入 Schema 字段和注册顺序不变。Event 响应字段不变；变化仅是省略
`max_bytes` 时的默认分页大小。只读取一次且假设默认调用返回全部 Event 的消费者必须
改为持续读取到 `has_more` 与 `scan_incomplete` 均为假。

该决定不放宽 16 MiB 的已安装 Host MCP 行上限，也不改变 Result 容量、SQLite
Authority、Attempt 归属、Attention 唤醒、Task 状态或生命周期语义。

## 验证

离线覆盖普通多页、单条超限、interaction/error/Hold/terminal 完整续读、cursor 不
回退和 Attention/终态即时返回。集成到 Preview 后还需通过 MCP、SQLite、Windows、
Ubuntu 与生命周期回归；真实 Host 长等和真实计费不在本决定内。
