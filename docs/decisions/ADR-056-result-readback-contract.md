# ADR-056：Result 回读合同——Executor 侧摘要、有界文本通道与分页全量读取

> Status: DECISION
> Decision: Accepted（Master 执行 2026-11-24,依据 2026-11-24 Master 综合审计裁决 §3.4）
> Date: 2026-11-24
> Baseline: `codex/final-integration-20261124`
> Related: [ADR-026](ADR-026-sqlite-result-contract.md)、[ADR-047](ADR-047-compatible-result-summary.md)、[ADR-048](ADR-048-bounded-default-event-pages.md)

## Context

独立审计确认:Result 存储合同上限 32 MiB,而 MCP Host 单次传输约 16 MiB,大 Result 可能存储成功却无法完整回读;MCP/CLI/Web 均先经 IPC 搬运完整 Result 再各自生成摘要;`okResult` 对同一载荷做全量文本与 structuredContent 双重序列化;`zcode_result` 默认 full。

## Decision

1. **摘要下沉 Executor。** `view=summary` 的 ADR-047 投影改在 Executor 同一
   Attempt 快照上执行(`getResult(task_id, view)`);MCP、CLI、Web 摘要读取不再
   经 Control IPC 搬运完整 Result。省略 `view` 的调用保持冻结的 full 合同。
2. **MCP 文本通道有界。** `okResult` 载荷序列化超过 1 MiB 时,文本通道改为
   有界引用(大小 + SHA-256 + 使用提示),structuredContent 仍是权威载荷;
   小响应保持既有双通道行为。
3. **分页全量读取(additive)。** `zcode_result` 新增可选 `offset_bytes` 与
   `max_bytes`(必须成对,1,024–4,194,304 字节,不可与 `view=summary` 组合)。
   返回 `{core identity, result_digest, page:{offset_bytes,next_offset,total_bytes,data}}`;
   `next_offset` 始终落在 UTF-8 码点边界,调用方必须以其翻页。拼接全部 `data`
   可复现存储的 canonical JSON,其 SHA-256 等于 Operation 的 `result_digest`。
   16–32 MiB 的 Result 由此始终可完整恢复;不会静默截断。
4. **默认合同不变。** `zcode_result` 缺省仍为 full;摘要仍为 opt-in。本 ADR
   不改变存储上限、digest、Attempt 归属或摘要投影算法。

## Non-Changes

不新增第二份 Result 存储、缓存事实源或摘要持久化;不改变 Result 写入、
digest 计算、32 MiB 上限与 Worker Result Frame 合同。

## Consequences

- `zcode_result` 输入 schema 追加两个可选字段,输出 schema 追加 page 变体
  (`oneOf` 第三分支);已登记到 INTERFACES 与 Skill 文档。
- Control 协议新增只读方法 `getResultPage`;`getResult` 参数追加可选 `view`。
- 摘要读取的 IPC 字节数下降到摘要本身;大 Result 的 MCP 双通道不再重复
  序列化全量文本。
