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
- Task 页面顶部只用一行紧凑文字显示 Running / Needs attention / Execution
  completed，
  不使用大型统计卡；计数与 `All tasks` 共用 bucket 并可点击筛选。搜索按
  Task 名称、Task ID、Workspace 与目标过滤。
- Task 列表使用 inbox 行而不是宽表格，每项最多三行：Task 名称与一个主要状态；
  Workspace 简称、Model、Plan、Attempt 与更新时间；需要处理时的失败原因或
  Attention 摘要。列表不重复完整路径、Usage、时间或状态；缺失的 Workspace、
  Model、Plan 或时间字段直接隐藏，不渲染连续 `Not observed`。Attention 行
  优先排序，执行完成 Task 显示 Awaiting review / Review blocked，不把 Worker
  execution completed 写成 Master accepted。
- Task 详情在同一页面展开，固定为 Task header、Problem and actions、Work
  history、Execution 和默认折叠的 Technical details。Problem and actions 合并
  Acceptance、Attention 与 Available actions；Work history 合并 Attempt
  timeline 与 Result，Result 不再重复标题、Attempt 编号或独立状态标签；
  Execution 默认只显示 Model、Plan、Discount、Total tokens，展开后显示
  Token、Cache、Effort、可靠 Provider 成本与 Master/Worker Usage；Technical
  details 合并 Wake、Cleanup、Release 与 Events。先结论、再动作、再证据、
  最后事件；历史 Attempt 只读选择，不创建并行详情页。
- Task header 只显示 Attempt、Workspace 简称与 Updated；默认不显示内部
  Task ID、完整路径或工作流类型标识。完整 Workspace 路径只在用户主动展开时
  出现。`wake-unknown`、`attention`、`cleanup`、`done`、`queued` 等内部类型
  标识不进入普通任务列表或详情。
- `Result.issues` 与 `Result failed` 是 Worker 报告事实，不是 Master 验收
  结论。Console 在当前 Attempt 的 Problem and actions 中显示一次
  `Result issues` / `Result failed` 或“Master acceptance is not recorded”，
  不得在 Result 区域重复同一状态说明，也不得仅凭 Result 内容声称 Acceptance
  failed 或 Accepted。当前 Authority 不提供 `master_accepted` 事实，Console
  不得据 Result、Task status 或 Wake 自行推断。
- Console 只投影 Executor 持有的同一 SQLite Authority；HTTP 不返回
  `task.context`，不创建第二 Authority、Task、Manager 或持久 UI 缓存。
- Continue 与 related rework 只能依据服务端重新读取的权威 capability。
  Cleanup 未验证、Worker 仍活动、Hold/Pending/未知 Reply 或
  `submission_unknown` 时失败关闭。服务端不提供原地清除 Hold 或绕过状态机的
  “Accept / Force complete” 操作。
- Related rework 创建新 Task，来源 Task/Attempt 只写入 context；回执关系为
  `context_only`，不伪造 Authority parent/child edge，不覆盖原 Task、Attempt、
  Result、Cleanup、Release 或 Wake 历史。
- Usage 按 Attempt 统计，Task 汇总不得重复计数。真实零值保持 `0`；缺失字段
  默认隐藏，只在展开 Execution 时用一条有界汇总说明未观测项，不重复渲染
  `Not observed`。Provider 实际成本没有 settlement 时不得展示为 `0` 或预计
  值；没有可靠金额时不创建 Provider 成本字段，只在同一条汇总中说明。
- Plan、Discount、Model 与 Effort 使用独立标签。折扣状态只允许“已应用、未应用、未观测、不适用”；
  不从模型名推断套餐，不把 Start Plan 用量换算为 Coding Plan credits，不使用
  默认 `0.67` 倍率。Master Usage 与 Worker Usage 分栏，并明确是否记录。
- 页面保留双语、浅色/深色、桌面优先与窄屏布局；失败原因使用普通用户语言，
  同时保留真实状态、原因码和安全阻塞信息。
- 顶部品牌标直接使用插件发布资产 `assets/icon.png` 的原始 PNG 字节，不使用
  `B/` 文字占位或相似重绘；实验性提示使用低干扰胶囊，不以宣传性架构说明
  替代任务事实。

## Non-Changes

- 不新增公共 MCP 工具或修改公开 schema、Task 状态语义、SQLite v14 Authority、
  Executor、Cleanup、Release 或 Wake 合同。
- 不恢复 0.67 折扣门禁，不修改 Provider/Billing 实际数据能力。
- 不提供绕过 Continue/Rework/Cleanup 状态机的管理入口。

## Verification

- 真实 SQLite Authority、Executor Control IPC、loopback HTTP 与 Chromium
  E2E 覆盖列表/详情、隐藏内部 ID 与缺失字段、单次未观测汇总、历史 Attempt、
  真实零值、Result 合并、完整 Events 分页、Continue、related rework、
  Cleanup blocker、双语、明暗主题、窄屏与 Deep Link。
- Worker、Result、Wake 与 Usage 为 synthetic fixture；真实模型、真实 Desktop、
  真实 Queue Wake、Master Usage 与逐 Attempt Provider settlement 仍为
  `NOT_RUN / NOT_OBSERVED`。
- 完整 Windows/Ubuntu CI 在 Preview.17 集成门禁中记录，不把定向浏览器 E2E
  写成真实 Provider 或 Release 证明。
