# Preview.17 P0-C：Master 目标驱动自治返工

> Status: RESEARCH
> Date: 2026-11-25
> Branch: `codex/preview17-b-master-autonomy-20261125`
> Base: `6af69b55d7ecb660c2ad2c923888cf7f1e8886c8` (`origin/preview`)
> Scope: 只改现有 Master Skill 的验收与返工行为、离线决策夹具和本设计记录；不改变 MCP Schema、SQLite、Executor、Worker 或发布流程。
> Evidence boundary: Markdown 合同、确定性模拟、静态哈希和本地 Tokenizer 计数；真实模型遵循率、真实 Host 缓存收益与真实关联返工 Task 均未运行。

## 1. 问题与结论

P0-C 要求 Master 对最终目标负责，而不是把 Worker 的 `completed` 当作交付完成。现有 Skill 已有“独立验收”和 `zcode_continue` 同 Task 返工，但缺少验收失败后的完整自治闭环：

- 什么时候可直接继续，什么时候必须停止；
- 关联返工 Task 只能在什么安全条件下创建；
- 新 Task 必须继承哪些原始合同；
- 如何区分“同一根因反复失败”和“仍有真实进展”；
- 如何避免降级验收标准或重复未知 Queue submission。

本轮设计把这些行为收进现有 `review-and-recovery.md`，不新增 Skill、持久 Authority、Scheduler、递归 Worker 或授权层。根 Skill 的授权、审批、取消、额度和 Async Handoff 边界不变。

## 2. 行为设计

### 2.1 最终目标与独立验收

Master 对原授权最终目标负责。`completed`、Worker 自报、工具成功、Wake、Queue ACK 和文件存在都不是验收。终态后 Master 必须回读持久 Result/Events，并在实际执行目录检查 Git 状态、实际 diff、文件内容和适用验证；`whole_task` 验完整任务，`staged` 只验当前阶段。

验收失败必须来自可观察交付与既定标准的差异，不是“Master 感觉可以更完善”。Worker 已通过项保留；已声明失败/未运行项先核实原因，再形成下一轮返工证据。

### 2.2 优先级与安全分支

| 条件 | 动作 |
|---|---|
| 验收通过 | 按用户授权接收；不自动提交、推送、合并或删 worktree |
| 普通工程缺陷，前序 Attempt 可 Continue | 汇总根因和完整验收缺口，以原 `task_id` 调 `zcode_continue` |
| Continue 不可用，但原授权与执行目录仍安全 | 创建同一最终目标的关联返工 Task |
| 需要新授权、公共合同/安全/持久化决定、权限或外部副作用 | 停止自动返工并报告具体决定 |
| Pending Interaction、额度耗尽、未决 Hold、Workspace/归属未知 | 停止或保持未决，不新建 Task 绕过 |
| Queue/提交结果未知 | 保持 `SUBMISSION_UNKNOWN`，按原 `task_id` 对账，不重复未知 Queue submission |

“普通工程缺陷”只指在原目标、原写入范围、原验收标准内修正实现、测试或集成问题。它不是扩大权限、改写公共合同或接入生产数据的授权。

### 2.3 Continue 优先

前序 Attempt 为 `completed`、`failed` 或 `waiting_for_master`，已有同 Attempt 的 `result_committed`、`cleanup_verified` 与 `released` 证据，且没有 Pending、未知清理或归属冲突时，优先保留原 `task_id` 使用 `zcode_continue`。

返工 feedback 必须包含：

- 实际根因，不只复述 Worker 摘要；
- 未满足的验收项与对应实际证据；
- 仍通过、仍失败和未运行的验证；
- 本轮只要求修复的边界。

不为普通缺陷请求用户批准，不拆成微任务，不原样重派，不自动换模型。

### 2.4 关联返工 Task 的安全条件

只有 Continue 不可用，且以下条件同时成立时才创建关联 Task：

1. 仍处于原授权目标、路径与外部操作边界内；
2. 原 Workspace 没有活动、未知或未决占用；
3. Queue/提交状态已知，不能把未知回执变成第二个 Task；
4. 没有 Pending、Hold、额度耗尽或需要用户选择的事项。

新 `task_id` 必须唯一且不与原 Task 冲突。`context` 记录原 `task_id`、Attempt、Result digest、根因和最小必要失败证据；保持 objective 指向同一最终目标，不把历史完整日志复制进 Prompt。

### 2.5 合同继承

| 字段 | 关联返工 Task 处理 |
|---|---|
| 最终目标 | 保持同一目标；只缩小到未满足交付 |
| `requirements` | 继承原约束并补充失败证据；不得删除安全/合同边界 |
| `workspace` / `worktree_path` | 保持同一项目与实际执行根 |
| 模型 / Provider | 使用原请求；原请求未指定时继续省略，不猜实际 Provider |
| reasoning effort | 使用原请求档位；原请求未指定时继续省略 |
| `timeout_ms` | 使用原任务预算；原请求未指定时沿用同一默认，不写成实测值 |
| `acceptance_criteria` | 原样继承，并可补充/收紧；不得降低或重解释 |
| `test_commands` | 继承适用入口，可新增必要检查 |
| Task/Attempt/证据 | 原 Task、Attempt、Result、Events 和 Workspace WIP 全部保留 |

继承采用“原值优先、未知保持未知”原则。不得把请求模型写成 Runtime 实际模型，也不得用目录默认值补造 reasoning effort。

### 2.6 进展驱动熔断

首次普通验收失败至少完成一次诊断与返工，不能因为“失败了”立即停止。之后每次交付与前一返工 Attempt 比较：

- 判定为进展：新增通过项、失败集合收敛、根因范围缩小，或出现新的可行动证据；
- 判定为无进展：同一根因重复，交付物/测试结果/证据没有形成新的通过项或收敛；
- 不能把尝试次数、耗时、Token、Worker 自报或重复重试当作进展。

只有同一根因且无进展才触发熔断。熔断后保留失败证据，报告已尝试路径、当前阻塞和仍需用户决定，不再自动重派或自动换模型。

### 2.7 R10 输入目标保护回归语义

R10 只作为回归语义，不重派历史任务，不读取或修改 LumeCAE 生产数据。

以下两种“看似有输入、实际未证明目标正确”的情况必须判为验收失败并进入自动返工：

1. 主窗口仍在前台，但不能证明对话框或目标控件实际获得输入；
2. 鼠标/键盘序列只发送了一部分，调用方已经继续执行。

验收需要核对精确前台 HWND/PID 和每个注入事件的目标落点；“主窗口前台”不是充分条件，“部分发送”也不是成功。

### 2.8 明确非目标

- 不新增 Goal Skill、Goal SQLite Authority 或第二套任务账本。
- 不新增 Scheduler、递归 Worker、Supervisor 或持久返工状态机。
- 不新增 MCP 工具、TaskPackage 字段或授权体系。
- 不修改 Task/Attempt/Result/Release/Cleanup 语义。
- 不自动提交、推送、合并、发布、清 worktree 或操作生产数据。

## 3. Prompt 前缀与 Token

### 3.1 修改范围

只修改 `plugins/codex-zcode-bridge/skills/zcode-bridge/references/review-and-recovery.md`。`SKILL.md`、frontmatter、description、渐进式加载路由、文件顺序和其余七份 references 未改；根 Skill 和其前面的六份 reference 仍形成稳定前缀。

### 3.2 测量方法

- Tokenizer：`js-tiktoken@1.0.21`，`o200k_base`（与仓库既有代理口径一致）。
- 范围：按加载顺序拼接 `SKILL.md` 与排序后的全部 `references/*.md`。
- 字节：Windows worktree 实际字节（`core.autocrlf=true`，CRLF）；另做归一化 LF 对照。
- 比较基线：`origin/preview@6af69b55d7ecb660c2ad2c923888cf7f1e8886c8`。

### 3.3 结果

| 指标 | Preview.16 基线 | Preview.17 候选 | 净变化 |
|---|---:|---:|---:|
| 完整 Skill，Windows worktree Token | 14,221 | 14,213 | **-8** |
| 完整 Skill，归一化 LF Token | 14,108 | 14,101 | **-7** |
| `review-and-recovery.md` Token | 1,814 | 1,806 | **-8** |
| 稳定公共前缀 Token | 9,663 | 9,663 | **0** |
| 稳定前缀占基线 | 67.95% | 67.95% | **0** |

结论：

- 硬上限“净增 ≤ 100 Token”满足；
- “目标 0”满足，实际无净增且减少 8 Token；
- 稳定前缀 9,663 Token 未变，修改位于第七份 reference 的元数据处；
- 前六个加载文件（根 Skill + `async-handoff`、`delegation-policy`、`goal-lifecycle`、`monitoring-and-approval`、`reporting`）保持字节不变；稳定前缀继续覆盖 `review-and-recovery.md` 的标题和 Status 行。缓存布局和加载顺序未调整。

机器记录在 `test/fixtures/master-goal-autonomy-20261125.json`，包含逐文件 Token、完整 Token、稳定前缀和归一化 LF SHA-256。

## 4. 测试与证据

### 4.1 已实现

- `test/skill-policy.test.ts` 新增确定性验收后续决策合同：通过、Continue、关联 Task、熔断、安全 Hold、Queue 未知对账。
- 新夹具覆盖 R10 的两个输入目标保护反例，明确不重派历史任务或访问 LumeCAE 数据。
- 静态测试验证关键合同短语、唯一修改文件、稳定前缀哈希和 Token 预算记录。

### 4.2 运行状态

| 命令 | 状态 | 结果 |
|---|---|---|
| `npm run build:test` | `PASS` | TypeScript test build 与资源复制成功 |
| `node scripts/test-isolated.mjs dist-test/test/skill-policy.test.js` | `PASS` | 15/15，0 fail，0 skip |
| `npm run test:affected -- --development` | `PASS` | `TARGETED_TESTS_PASS`；T0 的 typecheck、build、plugin validation、generated freshness、`git diff --check` 均通过；隔离测试 15/15，0 fail，0 skip |
| `npm run typecheck` | `PASS` | 由受影响门禁执行 |
| `npm run build` | `PASS` | 由受影响门禁执行；生成物 final 与基线一致 |
| `npm run validate:plugin` | `PASS` | `codex-zcode-bridge@2.0.0-preview.16` 结构有效 |
| `npm run check:generated` | `PASS` | 14 个生成物 tracked 且 fresh |
| 真实模型/Host 遵循率 | `NOT_RUN` | 本设计不宣称 |
| 真实关联返工 Task E2E | `NOT_RUN` | 本设计不宣称 |
| 完整 `npm test` / 跨平台矩阵 | `NOT_RUN` | 受影响范围只需定向开发门禁；未以定向结果冒充完整回归 |

首次受影响门禁在本地依赖初始化前因缺少 `node_modules/playwright-core/browsers.json` 停止，未进入测试；执行 worktree 内 `npm ci --no-audit --no-fund` 后重跑同一门禁通过。该初始化不改变 tracked 文件。

模拟测试只证明 Markdown 决策合同可机械执行，不证明真实模型会遵循，也不证明真实 Host 会创建正确 Task。

## 5. 建议 ADR

建议后续由全局 ADR Owner 分配：**Master Acceptance-Driven Autonomous Rework**。候选决策应明确“普通工程缺陷无需再次批准”“Continue 优先”“关联 Task 安全条件”“字段继承”“同根因无进展熔断”和“不得降低验收标准”。

本轮不修改 `docs/decisions/README.md` 或任何全局 ADR 编号，避免与其他并行工作线冲突。

## 6. 剩余风险

1. 真实 Master 模型是否稳定遵循新段落未测量；静态夹具不能替代模型 A/B。
2. 关联返工 Task 的端到端行为未在真实 Host 创建，字段继承目前是 Skill 合同而非运行时强制。
3. R10 只验证语义与模拟决策；没有重派历史 R10，也没有触碰 LumeCAE 生产数据。
4. Token 数来自 `js-tiktoken/o200k_base` 代理口径，不是 Host 实际计费、Cache Read/Write 或跨平台字节差异。
5. Queue 未知时不重提交流程沿用现有 Async 合同；真实网络中断下的手工对账仍需 Host 验证。
