# ADR-061：Master 验收驱动的目标自治返工

> Status: DECISION
> Date: 2026-11-25
> Decision: Accepted（Owner 在 Preview.17 任务中明确批准）
> Baseline: `origin/preview` `6af69b55d7ecb660c2ad2c923888cf7f1e8886c8`
> Related: [ADR-036](ADR-036-host-native-interruption-requeue.md)、[ADR-051](ADR-051-executor-wake-delivery.md)、[ADR-052](ADR-052-async-master-handoff.md)

## Context

用户提交的是最终目标，而不是一次 Worker 执行。现有 Master Skill 已要求
独立验收，并优先使用同 Task 的 `zcode_continue`，但缺少验收失败后的完整
决策闭环：哪些缺陷可直接返工、何时可创建关联 Task、继承哪些合同、何时
应因无进展而熔断，以及 Queue 未知时如何避免重复提交。

`completed`、Worker 自报、工具成功、Wake、Queue ACK 或新 Turn 都不是
Master Accepted。普通工程缺陷要求用户逐次批准会中断既有目标生命周期，
但自动返工也不能扩大原授权或绕过 Hold。

## Decision

- Master 对原始最终目标、Workspace、模型、Effort、权限和预算负责。
- Worker 终态后，Master 必须回读持久 Result/Events，并在实际执行目录检查
  Git、diff、文件和适用验证；`whole_task` 检查完整任务，`staged` 只检查
  当前阶段。
- 验收失败必须来自可观察交付与既定验收标准的差异，不得因主观偏好扩大
  目标或降低标准。
- 普通实现、测试和集成缺陷直接返工，不请求再次批准。前序 Attempt 已
  Result、Cleanup 与 Release 且无 Pending/Hold/归属冲突时，优先用原
  `task_id` 调用 `zcode_continue`。
- Continue 不可用但任务仍在原授权、路径和执行边界内，且 Workspace 没有
  活动、未知或未决占用时，可创建唯一关联返工 Task。新 Task 继承最终目标、
  requirements、Workspace/worktree、请求的模型与 Effort、timeout、验收
  标准和适用测试；原值缺失保持未知，不猜 Provider/Runtime 实际值。
- 原 Task、Attempt、Result digest、Events、Cleanup/Release 证明和 WIP
  全部保留。关联 Task 的 context 只记录最小根因和失败证据，不复制完整
  历史日志。
- 首次失败至少完成一次诊断与返工。后续以新增通过项、失败集合收敛、根因
  范围缩小或新可行动证据判断进展；同一根因持续无进展时熔断并报告证据与
  阻塞，不以次数、耗时或 Token 充当进展。
- 目标、合同、权限、外部副作用、Pending、额度耗尽、未决 Hold、归属未知
  或必须由用户作出的决定仍停止并请求用户。
- `SUBMISSION_UNKNOWN` 按原 `task_id` 对账，不重复未知 Queue submission，
  不以新 Task 掩盖未知提交。
- R10 输入目标保护作为回归语义：主窗口前台不证明对话框/控件获得输入，
  鼠标或键盘序列部分发送后继续执行也不是成功；未能证明精确目标落点即
  验收失败并进入返工。

## Constraints

- 不新增 Goal Skill、Goal SQLite Authority、Scheduler、递归 Worker、
  持久返工状态机或第二授权体系。
- 不改变 MCP Tool/schema、Task 状态、SQLite Authority、Executor 或
  Cleanup/Release 语义。
- 不自动提交、推送、合并、发布、清理 Worktree 或访问生产数据。
- 修改限制在现有 Master Skill reference；净 Token 不增加，稳定公共前缀
  保持不变。

## Verification

- `test/skill-policy.test.ts` 的确定性决策夹具 15/15 PASS。
- 完整加载 Skill 使用同一 `js-tiktoken/o200k_base` 口径为
  `14,221 → 14,213`（Windows worktree），净变化 `-8`；稳定前缀
  `9,663` Token 未变。
- 真实模型遵循率、真实 Host 关联返工 E2E、真实缓存收益仍为 `NOT_RUN`，
  不以静态策略测试替代。
