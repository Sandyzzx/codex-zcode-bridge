# ADR-002 — Manager 独占任务生命周期，worker 通过 attempt claim 入场

Status: Accepted
Date: 2026-10-07（记录日期，决策早于此）

## Context

同一个 data root 可能被多个 Bridge MCP 进程共享。任务以 detached worker 执行，进程身份基于 PID，调度与执行不在同一进程内。

## Decision

- Manager 用进程内 promise 队列加同一 data root 下的 `.tasks/.manager.lock` 串行化调度；活 owner 不因时间超限被驱逐，死 owner 由串行 reclaim guard 回收。
- worker 在进入 adapter 前，必须在 attempt 目录写入永久 `execution.claim` 抢占执行权；重复、旧 attempt 与终态入场被拒绝。
- `state.lock` 保护状态更新与结果提交；worker 提交还要校验当前 attempt 与非终态。
- 未启动的 worker 可重拉一次；抢占过的 attempt 不重复执行；已开始的 worker 不自动重跑。

## Rationale

跨进程并发下，"谁有权执行这一次 attempt"必须由持久化声明决定，而不是由内存状态或时间推断。否则会出现重复执行、旧 attempt 覆盖新结果、以及丢失的结果被重放。

## Consequences

- 进程身份依赖 PID；操作系统重用 PID、以及自行脱离进程组的后代进程属于未充分验证的边界。
- worker 丢失但记录的 ZCode PID 仍存活时保留占用，要求 `zcode_cancel` 验证清理。
- 清理未验证的终态任务保留目录与 slot，续跑被拒绝，再次 cancel 成功后才释放。
- 不同 data root 不共享调度锁，调用宿主必须避免向重叠目录提交冲突任务。

## Evidence

- `docs/ARCHITECTURE.md`：Manager 锁、attempt claim、`state.lock`、重拉与不重跑规则、清理占用与 PID 边界均在该文档"当前架构"一节中描述。
- `docs/INTERFACES.md`：任务状态与终态语义、续跑只接受 `completed` / `failed` / `waiting_for_master` 且清理必须已验证。
