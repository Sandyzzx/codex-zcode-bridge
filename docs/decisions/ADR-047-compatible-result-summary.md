# ADR-047：可选 Result 摘要与 Attempt 归属

> Status: DECISION
> Date: 2026-11-21
> Decision: Accepted for the token-efficiency candidate
> Baseline: `1f9ff9ef37528205e76156e13fe06ed2b1fd3711`

## 决定

`zcode_result` 增加可选 `view: "summary" | "full"`。省略 `view` 或选择
`"full"` 时返回现有 TaskResult，保留结构化内容、文本和错误合同。`"summary"`
在同一次读取上投影已提交的 Result。JSON 体积在 2 KiB 以内时直接返回原结果。
较大结果保留 Task、Attempt、终态、错误码、决定请求及有限的报告字段，`projection`
列出省略或受限的字段，并统计全部测试声明的 `passed`、`failed` 和 `not_run`。
恢复原文使用 `"full"`。读取旧输入的 SDK 校验边界保持有效。

可选 `expected_attempt` 与读到的已提交 Result 一起判断。若已提交的是其他 Attempt，
返回 `TASK_STATE`。当前 Attempt 未提交 Result 时沿用 `TASK_NOT_FINISHED`。证据引用
绑定同一 Authority 的 `task_id` 和 `expected_attempt`。继续任务前核对并按需读取证据，
因为公共 `zcode_result` 选择当前 Attempt。

工具仍声明对象根 `outputSchema`。带 `zcode_output` 的完整对象和带 `projection`
的摘要对象互斥，服务端继续校验。SDK 旧协议客户端可以按原对象字段读取全量结果。

`zcode_events` 增加可选 `include_attempt: boolean`。设为 `true` 时，每条
SQLite Event 返回其持久归属的 `attempt`，用于选择当前 Attempt 的启动和
Release 证据。缺省或 `false` 返回原始 Event 形状。读取仍跨 Attempt，游标、
合并和分页仍处理全部事件。字节预算包含新增字段。`attention.attempt`
表示最新 Attention 所属 Attempt。

## 影响

摘要只呈现执行事实与 Agent 声明。Master 独立验证文件、测试与未决问题，并通过
Status 和 Events 核对 Cleanup、Hold、Release。`released` 及 `result_committed`
均需匹配所审 Attempt，并共享 `result_commit_ref`。工具名称、顺序及持久化合同保持
原样。原有 SQLite 容量及 MCP 客户端的传输上限仍各自适用。
