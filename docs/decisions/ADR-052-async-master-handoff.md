# ADR-052：Async Master Handoff

> Status: DECISION
> Date: 2026-11-22
> Decision: Accepted for the Async Executor Preview candidate
> Implementation status: IMPLEMENTED — PARTIAL / BLOCKED
> Acceptance implementation: `7f54531acba0844937bc134609dae840090294ec`
> Related: [ADR-015](ADR-015-master-skill-authorization-and-progressive-loading.md)、[ADR-045](ADR-045-async-executor-ownership.md)、[ADR-051](ADR-051-executor-wake-delivery.md)

## Context

PR 2-5 已把 Manager/Worker 生命周期移入独立 Executor，并提供 post-Release
Wake candidate。原 Master Skill 仍以当前 Turn 内的长等待为主要跟进方式，导致
已经可靠受理的 Task 继续占用模型 Turn；同时需要避免把“结束 Turn”误写成取消、
把 Queue ACK 误写成 Turn 或验收。

## Decision

1. **授权不变。** 只有当前目标已有明确 Bridge 授权，或仍在覆盖该目标的显式
   Goal/会话授权内，才可派发或恢复。Async Handoff、Wake、历史调用和既有 Goal
   本身都不扩大写入、审批、取消、推送、发布或凭据权限。
2. **Scope 与 Mechanism 正交。** `whole_task`、`staged` 和只读 `auto` 只决定
   交付范围；`async_wake` 与 `foreground` 只决定当前 Master Turn 是否结束。
   这些名称都不进入 MCP/TaskPackage 字段，也不形成新的 Task 状态。
3. **可靠受理才是交接点。** Master 必须取得可归属的原 `task_id` 和已受理事实，
   记录可核实的 Task/Attempt、Authority Root、Codex Thread 与交接方式，简洁报告
   后结束 Turn 并停止轮询。Executor/Thread/一次性 Wake 授权不能核实时，仍可
   使用 Web Notify 作为安全回退，但必须如实说明不会自动唤醒原 Thread。
4. **断连不是取消。** Turn end、MCP Stop、客户端断开、请求超时或 Queue
   `submission_unknown` 都不取消已受理 Task。只有用户明确授权具体取消时才调用
   `zcode_cancel`。回执未知必须以原 `task_id` 对账；不得以新 ID 或第二 Attempt
   重派。
5. **Wake 不是验收。** Wake 到达后先核对 Task/Attempt/Operation/Result digest，
   再读取 Result Summary、Status、Cleanup/Release 与实际执行目录证据。Master
   分别判断 Result committed、Cleanup verified、Operation released 和
   acceptance；`QUEUED`、`TURN_STARTED`、`TURN_COMPLETED`、
   `DESKTOP_VISIBLE`、`UNKNOWN` 不得合并。
6. **Pending Interaction 保留原审批边界。** Pending 是阻塞事实，不是完成。
   结束 Turn 前发现 Pending 必须先处理；只有用户明确授权具体操作才可 `allow`。
   Async Handoff 不新增 Pending Wake，后续仍经 Web/CLI 或下一次用户 Turn 进入。
7. **不新增运行时。** 不建第二 Task Manager、Handoff 数据库、Wake 状态机、
   Supervisor 或 Recovery Engine。Skill 只是现有 Executor、MCP、CLI、Web 和
   SQLite v14 合同的行为指引。

## Error and Observation Semantics

| 事实 | Master 行为 |
|---|---|
| Task receipt = accepted | 可进入 Async Handoff；保留原 `task_id` |
| receipt = unknown / timeout | 先对账原 `task_id`；不得结束为成功，不得换 ID |
| `REQUEST_CANCELLED` / Turn end | 只结束等待；Task 继续，不自动 Cancel |
| Pending Interaction | 保持未决并核对具体请求/Attempt/授权 |
| Wake identity mismatch | 拒绝验收，查询原 Task 并报告冲突 |
| Queue ACK = `QUEUED` | 只表示 CLI 接受，不表示 Turn started 或完成 |
| new in-progress Turn | 只表示 `TURN_STARTED`；Desktop visible 仍可能 `UNKNOWN` |
| Result available | 读取持久事实；不自动等于 Cleanup/Release/acceptance |

## Implementation

- [Master Skill](../../plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md) 保留
  授权、取消、审批、额度与独立验收 P0 规则，并路由到
  [async-handoff.md](../../plugins/codex-zcode-bridge/skills/zcode-bridge/references/async-handoff.md)。
- 既有 delegation、dispatch、monitoring、reporting、review 与 runtime references
  同步区分 foreground 和 async 行为，不改变公开工具或 TaskPackage schema。
- `test/skill-policy.test.ts` 增加确定性 workflow decision contract；它只证明
  Markdown 合同中的分支可机械核对，不证明真实模型遵循率。

## Consequences

- 已受理 Task 不再要求 Master 在当前 Turn 持续等待；Host Turn 可结束而 Executor
  继续持有 Worker 生命周期。
- shipped MCP Host 进程退出后原 Attempt Result/Cleanup/Release 已由 synthetic
  Worker E2E 证明；这不证明真实 Master 模型会按 Skill 结束 Turn，也不证明
  Wake 后会自动恢复并独立验收。
- Async Wake 仍是 experimental candidate。真实 App Server/Queue、严格 C/D、
  Desktop 全关和真实模型 Skill 遵循率保持 `NOT_RUN / BLOCKED`。
- Pending Interaction 不会自动唤醒 Thread；需要审批的任务应使用 foreground，
  或在异步交接说明中明确由用户下一次 Turn/Web/CLI 继续。
- 不改变 SQLite v14、Manager、Worker、Result、Cleanup、Recovery 或 Release CAS。

## Rejected

- 不把 `async_wake` 或 `foreground` 加进公共 MCP/TaskPackage schema。
- 不在 Master Skill 内直接运行 `codex queue`、`--resume` 或修改 Wake policy。
- 不以 Wake、Queue ACK、进程存活或 Worker 自报替代独立验收。
- 不因 Turn 结束、断连、用户停止当前回复或超时自动取消 Task。
