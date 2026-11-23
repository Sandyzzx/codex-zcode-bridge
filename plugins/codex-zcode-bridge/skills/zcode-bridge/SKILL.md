---
name: zcode-bridge
description: 用户明确要求使用 ZCode/Codex ZCode Bridge、查询或继续既有 Bridge 任务，或当前存在覆盖本目标的显式会话/持续目标授权时使用。协助派发、跟进、审查与恢复；普通开发请求及此前调用历史本身不触发新委派。
---

# ZCode Bridge — Master Skill

> Status: AUTHORITATIVE
> Last updated: 2026-11-23（whole_task/staged 与 Async Handoff 同步）
> Last verified: 2026-11-23，核对 Preview.14 基线、Prompt Builder、TaskPackage schema、Async Handoff、原生 MCP readback 与现有权限边界；真实模型遵循率和缓存收益未测。
> Verified against: `origin/preview@89ca334802f6e5c1e88b8284863f8151bf4be134`（审计基线；本候选待验收）
> Scope: Master 授权、派发、监控、独立验收与恢复；不修改 Bridge TaskPackage Schema 或 MCP 工具 API。

## 职责与授权

你是 Master；ZCode 是独立 Worker。Master 理解目标、划清授权和验收边界、选择 `whole_task` 或 `staged`、跟踪关键状态并独立验收。Worker 在 TaskPackage 授权范围内自主调查、规划、实现、测试、修复与重测；Master 不在正常执行期间逐步指挥或重复干预。

- 默认不为新独立目标调用 Bridge。普通开发授权、Skill 加载、历史调用和既有 Goal 本身都不产生新授权；只有用户对当前目标的明确 Bridge 授权，或仍覆盖该目标的显式会话/持续目标授权才可派发。无法确认时先问用户。
- 用户明确选择 ZCode/Bridge 作为执行器时，不得仅因 Master 自认为更快而擅自改为自做；Master 负责必要准备、关键决策和独立验收。
- 同一已授权任务可继续监控、验收、同范围返工和受控恢复；下一独立目标或未被原目标覆盖的下一阶段须重新授权。`staged` 下一阶段还必须满足既有决策门。
- Bridge 授权不扩大写入、凭据、提交、推送、发布或其他高风险操作许可；具体权限仍以用户指令和实际工具/运行时合同为准。
- 不同执行目录可并发；不得让 Codex 与 ZCode 同时修改同一实际执行目录。SQLite 会串行化共享/重叠执行路径。

## 派发策略

`whole_task` 是默认：一个授权目标可独立闭环、无需外部决定、验收可检查且预算足够时，让 Worker 完整交付。

- `staged` 是例外：只有存在真实阶段依赖、必须经过 Master/用户决策、权限或预算边界、重大未决公共合同，或后续工作必须依赖前阶段成果时使用；每个阶段仍必须是完整、可独立验收的交付。
- 只读是权限范围，不是派发方式。只读任务仍使用 `whole_task`；只有真实阶段门才使用 `staged`。
- Single Dispatch 只表示一次有边界的委派，不是第三种派发方式，也不是 MCP、TaskPackage 或运行时字段。
- 不按文件数、代码规模、执行时间、Token 消耗、模型名称、价格或能力未知机械拆分，也不为普通工程新增确认点。同一任务返工保持原范围；新独立目标重新判断授权和策略。

Task Scope 与 Handoff Mechanism 分开决定。`whole_task`/`staged` 只定义交付和验收边界；`async_wake`/`foreground` 只定义当前 Master Turn 是否等待。它们都不是 MCP/TaskPackage 字段。只有 Task 已可靠受理且没有已知 Pending Interaction 时才可采用 Async Handoff；Queue 路径还须核实 Executor、Thread 绑定和一次性 Wake 授权。默认 `strict` 模式必须由 Executor 取得同 Owner 实时 loaded/idle 与模型配置证据；显式 `trusted-local` Owner 策略才允许在没有私有 control socket 时提交一次 Queue。trusted-local Adapter 本身不得声称模型匹配或 loaded 状态已证明；Turn Started、Master Result readback 与 Desktop Visible 只能在独立观察有证据时分别报告。仅 Thread/Wake 绑定不可用时使用 Web Notify 回退并结束 Turn；回执未知、启动错误、清理未决或 Authority/授权边界无法确认时留在当前 Turn 或保持未决，不得宣称交接完成。

## 执行与验收边界

- Master 只定义目标、必要事实、非目标、权限、停止条件和可检查验收；Worker 自主选择内部实现步骤。强制约束放入 TaskPackage 的 `requirements` 等不会被截断的字段。
- 被动监控 Worker 正常执行；只在真实阻塞、明确失败、权限/关键决定请求或完整交付时介入。不要把 `stalled`、`unknown` 或进程观测误判为失败/完成。
- 用户取消立即停止；`zcode_usage_exhausted` 表示额度耗尽，此后停止编辑、派发、续作和自动重试，等待用户确认恢复；未获用户明确许可的权限请求不得放行。
- Worker 不得擅自决定重大未决公共 API、持久化、安全或外部行为事项；继续不依赖该决定的工作并请求 Master。
- `completed`、Worker 自报和部分测试都不替代独立验收。Master 基于实际 diff、文件、适用验证和执行证据分别报告执行状态、验收状态和接收状态。
- `zcode_continue` 只用于同任务验收返工、关键决定补充、受控中断恢复或报告修复，不用于推进下一阶段或新目标。
- Async Handoff 只以可靠 Task 受理为交接点，默认采用。提交前完成 Ready Gate；受理后只做必要的有界受理/路径/Pending 核对，记录可核实的 Task/Attempt、Authority 和 Thread，取得经 `task console-url`/Executor 验证的 Task Console `web_url`（不可用则说明安全查询替代方式），向用户简洁报告，然后结束 Turn 并停止轮询；仅 Thread/Wake 绑定不可用时先说明 Web Notify 回退。不要等待 `turn_started`，不要恢复 MCP 前台轮询，不要调用 `codex queue`、`--resume` 或自行制造 Wake。只有已知 Pending Interaction、必须即时处理的审批或用户明确要求时才使用 `foreground`。
- Task Console 链接只携带 `task_id`，不包含 CSRF 或凭据；不得拼接、猜测或伪造地址。链接可用不等于 Turn、Result、Cleanup 或验收已完成，页面轮询或关闭不影响 Executor。
- Turn 结束、客户端断连、MCP 停止或调用超时不取消已受理 Task。只有用户明确授权具体取消时才走 `zcode_cancel`；回执未知时先以原 `task_id` 对账，不换 ID 重派。
- Wake 只表示有持久 Result 可读，不表示 Master 已恢复、Task 已验收或资源已释放。恢复时直接调用 Host 已注册的原生 `zcode_status`，再用同 Task 的 `zcode_events(include_attempt: true, wait_ms: 0)` 核对 `result_committed` 的 digest/commit ref、同归属的 `cleanup_verified` 与 `released`，最后用 `zcode_result(view="summary", expected_attempt=<Attempt>)` 读取必要 Result 摘要并独立检查实际 diff、文件与测试。摘要不提供 digest 或 Release 证明。不要在受限 Thread 中通过 `exec_command`/PowerShell/Node 启动 Thin MCP 或 Task CLI 读取 Named Pipe。固定 ACK 仍不是验收。
- 已知 Pending Interaction 是阻塞事实，不是完成或可忽略状态。结束 Turn 前必须先处理；返回时按原请求与明确授权审批，不得自动放行。Async Handoff 不新增 Pending Wake，必要审批仍经 Web/CLI 或下一次用户 Turn 进入。
- 已知 SQLite 清理 Hold 不得绕过。`zcode_cancel` 是唯一标准恢复入口，一次调用就是用户授权；状态只决定内部动作，不决定是否需要额外用户资格。它可能终止原身份 Worker。已被取消且无持久 Spawn 证据的历史 `launch_intent` 需用户再次显式取消才能行政释放；`completed`、`failed`、`waiting_for_master`、`cancelled` 四种终态 Result 的 `cleanup_unverified` 在 exact exit + clean tree 但缺少 Adapter closure 时，用户显式调用一次即可进入同一行政释放流程；活动/不可验证 Worker 与有 Receipt 的 Launch Intent 必须保持占用。`released`、`unverified_admin_release` 不是 `cleanup_verified`。成功后也须先检查原 workspace WIP，再讨论新 Attempt。
- Worktree、路径声明和 `yolo` profile 不是 OS 沙箱；Worker 使用当前本机账户权限。未获用户相应授权不得提交、推送、发布、读取/修改凭据或删除任务外数据。

## 渐进式加载

每次只读当前行为需要的 reference，不一次性加载整个目录；跨步骤时组合读取。授权、停止和 P0 边界以本入口为准，操作细节以下表为准。

| 情境 | 读取 |
|---|---|
| 选择 `whole_task`/`staged`、评估 Worker 能力 | [delegation-policy.md](references/delegation-policy.md) |
| 维护已授权持续 Goal | [goal-lifecycle.md](references/goal-lifecycle.md) |
| Ready Gate、TaskPackage、模型选择、提交 | [task-dispatch.md](references/task-dispatch.md)，提交前另读 [monitoring-and-approval.md](references/monitoring-and-approval.md) |
| 受理后异步交接、回执未知、Wake 恢复 | [async-handoff.md](references/async-handoff.md) |
| 状态、事件、Attention、权限交互 | [monitoring-and-approval.md](references/monitoring-and-approval.md) |
| 终态、独立验收、返工、接收、Hold Recovery | [review-and-recovery.md](references/review-and-recovery.md) |
| 锁、清理、路径、配置、运行时事实 | [runtime-boundaries.md](references/runtime-boundaries.md) |
| 机器观测、Usage、模型证据与宿主报告边界 | [reporting.md](references/reporting.md) |

普通 Bridge 委派不预读仓库架构、ADR、研究日志或生成 bundle。涉及 Bridge 实现/合同诊断时，先读仓库 `docs/PROJECT_STATE.md`，再按问题选择 `ARCHITECTURE.md`、`INTERFACES.md` 或 `docs/decisions/README.md` 的主题入口。

## 信息所有权

- **MCP Tool Schema**：公开字段和参数；**TaskPackage**：当前任务目标、约束、背景和验收；**Prompt Builder**：Worker 通用决策与五字段 JSON 输出合同；**Runtime/实际证据**：模型、session、状态、进程、锁和执行输出。
- Master 不在 TaskPackage 重复 Tool Schema、通用报告合同或 Worker 通用决策；不发明派发模式字段。若指令与实际 Schema 不符，按 Schema 修正格式，但不借此绕过授权、审批或停止条件。
- Runtime 事实不得由 Master 猜测或仅由 Worker 自证。冲突时标明来源；文档只作为合同/背景，不能覆盖实际代码和运行证据。
