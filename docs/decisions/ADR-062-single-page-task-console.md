# ADR-062：单页任务管理 Console 与逐 Attempt 成本事实

> Status: DECISION
> Date: 2026-11-25
> Decision: Accepted（Owner 在 Preview.17 任务中明确批准）
> Baseline: `origin/preview` `6af69b55d7ecb660c2ad2c923888cf7f1e8886c8`
> Related: [ADR-050](ADR-050-local-task-web-console.md)、[ADR-053](ADR-053-runtime-auto-learn-compatibility.md)、[ADR-058](ADR-058-plan-policy-decoupling.md)

## Context

旧 Operations Console 以 Dashboard、Tasks、Cost Lab、Runtime 和 Settings
并列导航，Task、Attempt、Result、Hold、Wake、Cleanup、Release 与 Usage
分散在多个页面。用户难以从单一入口判断任务是否仍在运行、是否需要处理，
也难以区分合法 Continue、关联返工、Cleanup 恢复与危险的手工强制释放。

同时，旧页面容易把 Plan、模型名、折扣或预计成本混为实际事实。Bridge
Authority 没有逐 Attempt Provider settlement 时，界面必须明确显示未观测，
不能用零值、模型推断或固定倍率补齐。

## Decision

- Console 主导航只保留 **任务 / Tasks**。Cost Lab 与 Runtime 不再占据独立
  主导航；其底层能力保留在 Diagnostics，继续使用同一 loopback Origin 和
  既有服务，不删除成本、Runtime 或 Billing 实现。
- Task 列表提供运行中、需要处理、已完成三个计数和筛选，并使用 inbox 行而不是
  宽表格。每行显示 Task 名称、Workspace、状态、Attempt、模型、套餐、执行消耗、
  更新时间与 Attention 摘要；Attention 行优先排序，已完成 Task 显示
  Review ready / Awaiting review / Review blocked。
- Task 详情在同一页面展开，固定按 Overview、Available actions、
  Acceptance/Attention、Attempt 时间线、Result、Execution usage、默认折叠的
  Execution facts（Wake/Cleanup/Release）和默认折叠的 Events 排列。先结论、
  再动作、再证据、最后事件；历史 Attempt 只读选择，不创建并行详情页。
- Console 只投影 Executor 持有的同一 SQLite Authority；HTTP 不返回
  `task.context`，不创建第二 Authority、Task、Manager 或持久 UI 缓存。
- Continue 与 related rework 只能依据服务端重新读取的权威 capability。
  Cleanup 未验证、Worker 仍活动、Hold/Pending/未知 Reply 或
  `submission_unknown` 时失败关闭。服务端不提供原地清除 Hold 或绕过状态机的
  “Accept / Force complete” 操作。
- Related rework 创建新 Task，来源 Task/Attempt 只写入 context；回执关系为
  `context_only`，不伪造 Authority parent/child edge，不覆盖原 Task、Attempt、
  Result、Cleanup、Release 或 Wake 历史。
- Usage 按 Attempt 统计，Task 汇总不得重复计数。真实零值保持 `0`；整套缺失
  显示 `not_observed`。Provider 实际成本没有 settlement 时必须显式显示
  `not_observed` / `bridge_authority_has_no_provider_settlement`，不得展示为
  `0` 或预计值。
- Plan、Discount、Model 与 Effort 使用独立标签。折扣状态只允许“已应用、未应用、未观测、不适用”；
  不从模型名推断套餐，不把 Start Plan 用量换算为 Coding Plan credits，不使用
  默认 `0.67` 倍率。Master Usage 与 Worker Usage 分栏，并明确是否记录。
- 页面保留双语、浅色/深色、桌面优先与窄屏布局；失败原因使用普通用户语言，
  同时保留真实状态、原因码和安全阻塞信息。
- 顶部使用低干扰实验性提示，不以宣传性架构说明替代任务事实。

## Non-Changes

- 不新增公共 MCP 工具或修改公开 schema、Task 状态语义、SQLite v14 Authority、
  Executor、Cleanup、Release 或 Wake 合同。
- 不恢复 0.67 折扣门禁，不修改 Provider/Billing 实际数据能力。
- 不提供绕过 Continue/Rework/Cleanup 状态机的管理入口。

## Verification

- 真实 SQLite Authority、Executor Control IPC、loopback HTTP 与 Chromium
  E2E 覆盖列表/详情、历史 Attempt、真实零值、完整 Events 分页、Continue、
  related rework、Cleanup blocker、双语、明暗主题、窄屏与 Deep Link。
- Worker、Result、Wake 与 Usage 为 synthetic fixture；真实模型、真实 Desktop、
  真实 Queue Wake、Master Usage 与逐 Attempt Provider settlement 仍为
  `NOT_RUN / NOT_OBSERVED`。
- 完整 Windows/Ubuntu CI 在 Preview.17 集成门禁中记录，不把定向浏览器 E2E
  写成真实 Provider 或 Release 证明。
