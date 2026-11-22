# ADR-049：Task CLI 作为 Executor 控制客户端

> Status: DECISION
> Date: 2026-11-22
> Decision: Accepted for the Async Executor Preview candidate
> Baseline: `origin/preview` `1bf039fda2ccfd17a992458a871bddd7b48b38c1`
> Related architecture: [BRIDGE_ASYNC_EXECUTION_V1.md](../architecture/BRIDGE_ASYNC_EXECUTION_V1.md)

## 决定

Task CLI 是独立 Executor 的管理与只读客户端，不持有第二套任务管理
Authority。所有 Task 写入、Task 读取、Executor 状态、模型设置和 Doctor
操作都通过既有 Executor Named Pipe 与 `ExecutorControlClient` 完成。

首版命令面固定为：

```text
executor start|status|stop
executor lease status|clear
task list|status|events|result|cancel|reply
```

`task list` 使用 SQLite v14 现有投影和 `after_task_id` cursor，limit 范围为
1..100；CLI 不直接打开 SQLite。`task result` 默认返回 ADR-047 摘要；完整
Result 超过 1 MiB stdout 预算时必须显式写入绝对路径，并以独占创建避免覆盖。

## 启动与退出

`executor start` 先连接现有 Control Pipe；已有活动 Executor 时只报告
`already_running`，不 Spawn 第二个进程。Spawn 后的启动仍受 Lifetime Lease
仲裁，Pipe 不是 Authority 证据。

无 Lease history 的既有 SQLite Root 只能通过显式
`--accept-unleased-transition` 完成一次停机切换。该标志不能绕过
`executor-lease.json` 中精确存活的旧 owner；CLI 只在本次 Spawn 的环境副本中
传递它，不写入配置或持久化授权。

`executor stop` 只请求 Idle-only Shutdown。`not_idle` 返回非零并保留服务；
Pipe 关闭超时或无法确认关闭返回非零和 `UNKNOWN`，不得输出成功。

## 边界

- 不新增 Task 数据库、调度器、Recovery Engine、Worker 路径或 Task 状态机。
- CLI 不取消 MCP 请求以外的任务；客户端断连只结束请求等待。
- SQLite v14、Task/Attempt/Operation、Result/Cleanup/Release、Attention、
  Official Runtime 和公共 MCP API 保持不变。
- 插件分发同时包含 `dist/task-cli.mjs` 与 `dist/executor.mjs`，二者通过同一
  Control 合同通信。

## 验证

定向验证至少覆盖：已有 Executor 不重复 Spawn、过渡标志、Shutdown unknown
非零、Task/MCP 并发读取同一 Authority、bounded list、Result 摘要与文件输出，
以及 Thin MCP/Task CLI 静态边界。真实 Desktop 关闭仍由 ADR-045 Validation
Gate 单独约束，不能用 CLI 单元测试替代。
