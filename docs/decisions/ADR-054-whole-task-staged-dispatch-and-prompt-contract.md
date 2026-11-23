# ADR-054：Whole Task / Staged 派发与 Worker Prompt 合同

> Status: DECISION
> Decision: Accepted（用户于 2026-11-23 明确批准）
> Date: 2026-11-23
> Baseline: `origin/preview@89ca334802f6e5c1e88b8284863f8151bf4be134`
> Related: [ADR-010](ADR-010-whole-task-delegation.md)、[ADR-015](ADR-015-master-skill-authorization-and-progressive-loading.md)、[ADR-045](ADR-045-async-executor-ownership.md)、[ADR-052](ADR-052-async-master-handoff.md)

## Context

当前 Skill、Prompt Builder 和 Async Handoff 指引仍保留一个只读 `auto` 选择偏好，
并在 Continue、Wake 回读和报告修复路径中存在重复或相互冲突的上下文。用户已明确
要求把派发收敛为 Whole Task 默认、Staged 例外，并在不改变 Bridge 运行时合同的
前提下减少重复信息、提高稳定前缀比例、保留独立验收能力。

## Decision

1. **只保留两种派发方式。** `whole_task` 是默认：一次派发一个完整、可独立验收的
   任务，Worker 自主调查、规划、实施、测试、修复和交付。`staged` 是例外：只在真实
   阶段依赖、必须经过 Master/用户决策、权限或预算边界、重大未决公共合同，或后续
   工作必须依赖前阶段成果时使用。每个阶段仍是完整、可独立验收的交付。
2. **删除 Auto 派发模式。** 只读是权限范围，不是派发方式；只读任务仍使用
   `whole_task`，只有真实阶段门才使用 `staged`。Single Dispatch 只表示一次有边界的
   委派，不是第三种模式、MCP 字段或运行时状态。
3. **不按规模机械拆分。** 文件数量、代码规模、执行时间、Token 消耗或模型能力未知
   都不是拆分理由。后续独立阶段使用新的 `task_id`，不得通过 `zcode_continue`
   推进下一阶段。
4. **Async Handoff 保持默认。** Task 可靠受理后，Master 只做有界受理核对，报告
   可验证的 Console 链接并结束 Turn；不等待 `turn_started`，不恢复 MCP 前台轮询。
   只有 Pending Interaction、必须即时处理的审批或用户明确要求时才使用 foreground；
   仅 Thread/Wake 绑定不可用时使用 Web Notify 回退。回执未知、启动错误、清理未决或
   Authority/授权边界无法确认时留在当前 Turn 或保持未决。Wake 后通过 Host 原生 MCP
   读取必要 Result，并独立验收实际 diff、文件和适用测试。
5. **Prompt Builder 只保留一份有效合同。** 首派把稳定的 Worker 职责和通用决策规则
   放在动态任务标识之前，输出合同保留一次并位于尾部；普通 Continue 不再嵌套完整
   首派 Prompt，仍完整保留 Objective、有效 Requirements、路径、验收、测试和必要
   Context。上一 Result 采用结构化证据投影，突出失败、未运行测试、未决事项和必要
   文件信息，不靠前 4,000 字符截断决定保留内容。
6. **报告修复独立分流。** `invalid_agent_report` 在任何实施职责之前进入 report-only
   模式；只依据已有证据修复五字段 JSON，禁止工具调用、文件修改、测试重跑和重复
   执行任务。超容量时显式失败，不静默丢弃约束。
7. **Skill 与 Builder 同步。** `SKILL.md`、delegation、dispatch、monitoring、
   async-handoff、review/recovery 和 reporting references 统一上述合同；删除
   `auto`、2,000 字符截断、等待 `turn_started`、已退役 Project Ledger 和错误证据
   来源。渐进式加载结构保留。

## Non-Changes

本决定不修改 MCP 公共工具 Schema、SQLite v14、Task/Attempt/Operation 合同、Result
Schema、五字段 AgentReport、Executor 所有权或 IPC、Wake 授权/投递、Cleanup、
Release、Recovery、Provider Authentication 或 Model Routing。不新增任务账本、
缓存服务、状态机、前台轮询路径或第二套派发机制。

## Evidence Boundary

离线 Prompt 对照只能证明文本长度、结构和稳定前缀变化，不能证明真实模型 Cache
Read、任务成功率或成本改善。没有真实模型 A/B 时统一标记 `NOT MEASURED`。

## Consequences

- Master 不再需要为普通可逆实现选择拆阶段，Worker 可在授权范围内完成完整闭环。
- Continue 保留可独立理解的任务合同，但去掉重复职责和完整历史输出。
- Wake 恢复使用 Status/Events/Result 的各自证据，不再把 Result 摘要当作
  digest、Cleanup 或 Release 证明。
- 真实模型遵循率、Cache Read 增量、严格 Wake C/D 和付费模型收益仍需独立验证。
