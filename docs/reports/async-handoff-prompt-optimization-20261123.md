# Async Handoff 派发与 Prompt Builder 优化报告

> Status: RESEARCH
> Date: 2026-11-23
> Baseline: `origin/preview@89ca334802f6e5c1e88b8284863f8151bf4be134`
> Candidate: `codex/async-handoff-prompt-optimization-20261123`
> Scope: Master Skill、派发合同、Worker Prompt Builder 与对应离线测试；不修改 Bridge 运行时合同。
> Evidence boundary: 本报告是候选实现的离线证据，不是真实模型 Cache Read、Worker 遵循率或付费 A/B 结论。

## 1. 结论摘要

候选把派发收敛为 `whole_task` 默认、`staged` 例外，并删除 Auto 派发模式。只读仍是
权限范围，不作为派发方式。Async Handoff 仍是可靠受理后的默认交接；Master 不等待
`turn_started`，不恢复 MCP 前台轮询。

Prompt Builder 现在：

- 首派先渲染稳定的 Worker 职责与决策规则，再渲染动态 TaskPackage；输出合同只出现
  一次并保留在尾部。
- 普通 Continue 只渲染一份任务合同，不再嵌入完整首派 Prompt；保留 Objective、
  Requirements、路径、验收、测试、必要 Context 和当前反馈。
- 上一 Result 只投影当前返工需要的结构化证据：状态、错误、文件、失败/未运行测试、
  测试计数、问题和未决决定；不再把完整 `zcode_output` 当作历史输出重贴。
- `invalid_agent_report` 在任何实施职责之前进入 report-only 分支；只允许依据已有证据
  修复五字段 JSON，不包含工具、文件修改或测试重跑指令。
- 总容量仍为 60,000 个 JavaScript UTF-16 单元；超限显式抛出
  `task_prompt_exceeds_capacity`，不静默删除任务约束。

## 2. 修改清单

### Prompt Builder 与测试

- `src/prompts/task-prompt.ts`
- `test/task-prompt.test.ts`

### Skill

- `plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md`
- `plugins/codex-zcode-bridge/skills/zcode-bridge/references/delegation-policy.md`
- `plugins/codex-zcode-bridge/skills/zcode-bridge/references/task-dispatch.md`
- `plugins/codex-zcode-bridge/skills/zcode-bridge/references/monitoring-and-approval.md`
- `plugins/codex-zcode-bridge/skills/zcode-bridge/references/async-handoff.md`
- `plugins/codex-zcode-bridge/skills/zcode-bridge/references/review-and-recovery.md`
- `plugins/codex-zcode-bridge/skills/zcode-bridge/references/reporting.md`
- `test/skill-policy.test.ts`
- `test/fixtures/master-skill-evaluation-20261111.json`

### Decision

- `docs/decisions/ADR-054-whole-task-staged-dispatch-and-prompt-contract.md`
- `docs/decisions/README.md`
- `docs/architecture/BRIDGE_ASYNC_EXECUTION_V1.md`（同步当前派发/Handoff 语义）
- ADR-010、ADR-015、ADR-052 的 Applicability 标注；历史正文保留。

## 3. 派发合同

### Whole Task（默认）

一次派发一个授权范围内的完整、可独立验收成果。Worker 自主调查、规划、实施、测试、
修复和交付；Master 只定义目标、必要事实、权限、停止条件和验收标准。文件数量、
代码规模、执行时间、Token 消耗、模型名称或能力未知都不单独构成拆分理由。

### Staged（例外）

只在真实阶段依赖、必须经过 Master/用户决策、权限或预算边界、重大未决公共合同，
或后续工作必须依赖前阶段成果时使用。每个阶段仍是完整、可独立验收的交付；阶段完成后
停止，下一独立阶段使用新的 `task_id`，不得通过 `zcode_continue` 推进。

### Single Dispatch

Single Dispatch 只表示一次有边界的委派，不是第三种派发模式，不是 MCP/TaskPackage
字段，也不是运行时状态。

### Async Handoff

Task 可靠受理后，Master 做一次有界受理核对，记录可核实的 Task/Attempt/Authority/
Thread 身份，报告真实可访问的 Console `web_url`，然后结束 Turn。不得等待
`turn_started`，不得使用 `wait_for` 或 Thin Waiter 维持前台连接。只有已知 Pending
Interaction、必须即时处理的审批或用户明确要求时才使用 foreground；仅 Thread/Wake
绑定不可用时使用 Web Notify 回退并结束 Turn。回执未知、启动错误、清理未决或
Authority/授权边界无法确认时留在当前 Turn 或保持未决，不得宣称交接完成。

## 4. Prompt 对照

### 首派

基线结构：

```text
TASK ID
通用角色
工作区/模型/时限
DELIVERY OWNERSHIP
任务字段
DECISION RULE
Context
OUTPUT CONTRACT
```

候选结构：

```text
DELIVERY OWNERSHIP
DECISION RULE
TASK ID
工作区/模型/时限
任务字段
Context
OUTPUT CONTRACT
```

动态任务标识之后的内容仍是任务特定数据；输出合同仍只出现一次并位于尾部。没有为了
增加公共前缀而添加无意义文本。

### 普通 Continue

基线会先传本次反馈和上一 Result，再在尾部嵌入 `ORIGINAL TASK` 与完整首派 Prompt；
任务 ID、交付职责和部分模型说明因此出现两次。候选结构为：

```text
DELIVERY OWNERSHIP
DECISION RULE
CONTINUATION CONTEXT
PERSISTED SESSION（有 Session 时）
TASK ID
工作区/模型/时限
Objective/Requirements/Paths/Acceptance/Tests
Context
PREVIOUS ATTEMPT EVIDENCE（结构化投影）
MASTER FEEDBACK
ADDITIONAL REQUIREMENTS
OUTPUT CONTRACT
```

原始 Objective、有效 Requirements、路径限制、验收标准和测试命令仍完整保留。Session
ID 只说明可恢复身份，不假设历史上下文完整；多次 Continue 不累积旧 `zcode_output`。

### Report Repair

基线先插入通用 `DELIVERY OWNERSHIP`，再出现 report-only 禁令，语义冲突。候选先渲染
`REPORT REPAIR MODE`，然后只给任务身份、工作区、错误摘要、候选声明、响应头尾摘录、
报告反馈和输出合同；不渲染 Objective、测试命令或实施职责。

报告原文使用头尾摘录，不再简单保留前 4,000 字符。五字段报告合同、布尔
`needs_master_decision`、失败/未运行状态和证据声明均保留。

## 5. 离线文本对照

本次候选直接导入编译后的纯函数，使用与审计相同的 A/B 任务构造，统计 JavaScript
UTF-16 单元和 UTF-8 字节。未调用模型，也未宣称 Token 或 Cache Read 结果。

| 样本 | 基线（审计代理值） | 候选（UTF-16） | 可归因变化 |
|---|---:|---:|---|
| 首派 A | 3,450 / 692 proxy tokens | 3,478 | 稳定段增加约 28 单元，换得更长公共前缀 |
| 首派 A/B 公共前缀 | 9 单元 / 3 proxy tokens | 1,592 单元 | 动态 `TASK ID` 前移后的结构收益 |
| 普通 Continue，短失败 | 4,960 / 1,041 proxy tokens | 4,314 | 去掉完整首派嵌套，按结构化证据投影 |
| 普通 Continue，长日志 | 8,519 / 2,103 proxy tokens | 4,314 | 不再携带旧 `zcode_output` |
| Report Repair，长原文 | 6,989 / 1,953 proxy tokens | 7,041 | 结构修复优先；头尾摘录保留关键证据 |
| 容量边界 | 首派 60,000 可构建 | 首派和 Continue 均显式受 60,000 限制 | 超限不静默丢约束 |

基线数字来自输入审计的 `js-tiktoken/o200k_base` 代理测量；候选本次只重算字符和公共
前缀，未重新安装 tokenizer。真实 Cache Read、Cache Write、请求级输入和模型遵循率
均为 `NOT MEASURED`。因此不能把上表字符减少直接表述为真实缓存命中率或费用改善。

## 6. 验证结果

### 已运行

- `npm run typecheck`：`PASS`
- `npm run build`：`PASS`
- `npm run build:test`：`PASS`
- `node scripts/test-isolated.mjs dist-test/test/task-prompt.test.js dist-test/test/skill-policy.test.js`：
  `26/26 PASS`
- `npm run test:full`（第二次完整运行）：`1099` tests，`1097 PASS`，`0 FAIL`，
  `2 skipped`；插件结构校验 `PASS`
- `npm run test:affected -- --development`：`121/121 PASS`；`typecheck`、build、
  plugin validation、generated-artifact freshness 与 diff check 均通过
- `git diff --check`：`PASS`
- GitHub Release Gate：待提交并推送最终候选后运行

首次完整运行出现两个测试失败。其中一个是对旧输出断言的测试未随实现更新，修正后定向
测试通过；另一个是 `formal MCP Host shutdown is bounded on unknown cancellation` 合成
交互等待超时，单测和连续两次重复均通过。没有证据证明该超时由本次 Prompt/Skill 改动
引起，但根因未确认，保留为残余 flake 风险；第二次完整运行通过。

### 覆盖的边界

- 稳定职责与决策规则在动态任务标识之前，且各只出现一次。
- Continue 不嵌套 `ORIGINAL TASK`，不重复通用职责；无 Session 时仍保留完整任务合同。
- 多次 Continue 不累积旧输出。
- 失败测试、未运行测试、测试计数、文件、问题和未决决定进入结构化投影。
- Report Repair 不含 `DELIVERY OWNERSHIP`、实施或测试重跑指令，并保留头尾原文。
- Unicode、长 Context、总容量和显式超限。
- Whole Task 默认、Staged 例外、只读仍是权限范围。
- Async 默认不等待 `turn_started`；Wake digest/Cleanup/Release 从同 Attempt Events
  核对；Project Ledger 旧建议已删除。

### 未运行

- 真实模型 Worker 遵循率：`NOT_RUN`
- 真实模型 Prompt Cache A/B：`NOT_MEASURED`
- 严格 Wake C/D、Desktop fully exited：沿用当前 Preview 证据，`NOT_RUN` / 未重新验证
- 付费模型请求：`NOT_RUN`

## 7. 必须保留与回归风险

必须保留：

- MCP 公共工具名与 schema、SQLite v14、Task/Attempt/Operation、Result Schema、
  五字段 AgentReport。
- Executor 所有权、IPC、Wake 授权与投递、Cleanup、Release、Recovery、Provider
  Authentication 和 Model Routing。
- 任务理解、授权边界、路径限制、验收标准、测试状态、独立验收和超容量显式失败。

潜在风险：

- 结构化 Result 投影省略普通 Continue 的 `zcode_output`。若规范化字段为空而原始输出
  才含关键失败，Master 应在反馈中补入当前必要证据；`invalid_agent_report` 仍保留头尾
  原文。
- 稳定前缀重排只证明文本布局，不证明 Provider 的实际缓存边界或命中率。
- Skill 是行为约束，不是服务端鉴权；真实 Host 是否遵循仍须独立 E2E。
- 本候选未运行付费模型；所有性能收益保持离线/结构证据边界。

## 8. 优先级

### 必须修改

- Auto 派发模式、2,000 字符 Context 截断、Async 等待 `turn_started`、错误的 Wake
  digest/Cleanup/Release 证据来源、Project Ledger 旧建议和 Report Repair 冲突。

### 值得优化

- Continue 去重、结构化 Result 投影、首派稳定前缀、Skill 跨文件去重，以及按动作
  只读必要 reference。

### 不建议修改

- MCP/SQLite/Task/Result/AgentReport/Executor/Wake/Cleanup/Release 合同；不恢复 MCP
  轮询，不新增账本、缓存服务、状态机或第二执行路径。
