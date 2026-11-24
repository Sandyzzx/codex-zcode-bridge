# Async Handoff 派发与 Prompt 设计独立审计

> Status: RESEARCH
>
> 日期：2026-11-23。提交 Owner 裁决，仅交付审计。
>
> 代码基线：`origin/preview@89ca334802f6e5c1e88b8284863f8151bf4be134`。审计开始时，本地 HEAD、远端跟踪引用、`git ls-remote origin refs/heads/preview` 三者一致，工作区干净。以下位置均指这一提交及其仓库版 Skill。

## 裁决摘要

| 优先级 | 建议 | 判断依据 |
|---|---|---|
| 必须修改 | 纠正 Skill 的 `context` 截断、Async 等待顺序、Wake digest 证据来源及已退役 Ledger 说明。报告修复应从第一句起只要求修报告。 | 前四项可由接口或代码反证。修复分支目前同时要求实施、测试和禁止工具、重跑。 |
| 值得优化 | 普通 Continue 只渲染一次任务职责和有效任务合同。把上一 Attempt 的相关失败、未运行项和未决决定作为证据传入。Master 按动作读取 references，正常 Wake 只回读验收所需的持久事实。 | 仅去掉一份重复职责，短 Continue 已从 1,041 降至 912 个离线代理 Token。长日志、失败取证和多次返工须单独验证。 |
| 值得实验 | 在首派的同一条 `session/send` 正文内，把跨任务不变的职责与决策说明放在动态标识之前，保留靠近结尾的一份输出合同。 | 合成首派对的公共前缀由 3 增至 290 个代理 Token，总长度仍为 692。真实 Cache Read 增量不确定。 |
| 不建议修改 | 派发偏好、13 个 MCP 工具及 Schema、SQLite v14、Executor 所有权、五字段报告、Cleanup/Release/Wake 合同。也不建议恢复前台轮询、引入第二份任务账本、把普通 Continue 改为无条件只发差量，或让 Wake 携带完整 Result。 | 当前合同已经支持整任务、受理即交接、按 Attempt 回读和独立验收；上述变化扩大验证面或削弱边界。 |

## 1. 派发的单位、范围与交接

| 用户用语 | 当前语义 | Master 的承诺 |
|---|---|---|
| 单次派发 | 一次有边界的委派。`zcode_task` 每次接收一个 TaskPackage，交付范围可以是一个整任务，也可以是一个阶段。一次性委派无需创建持续 Goal。 | 同一 ID、相同规范化请求可以重取回执。Worker 可自行完成多个工程步骤，Task 在原 Turn 结束后仍能运行。 |
| `whole_task` | 优先给一个 Worker 一个预算内能独立验收的完整成果，包括跨文件调查、实现、测试、修复与重测。 | Master 给终点、约束和验收标准，保留外部决策与最终接收。 |
| `staged` | 有真实审批门、权限或预算分界、尚未决定的公共合同，或后阶段确实依赖本阶段结论时，当前阶段仍是一次完整交付。 | 验收本阶段即停。只有原授权覆盖且阶段门满足，或另有授权，才用新 `task_id` 提交下一阶段。 |
| `auto` / 自动档 | 当前 Skill 将它限于**已有 Bridge 授权的只读代码任务**。由 Master 选择 `whole_task` 或 `staged`。涉及变更时明确选定实际策略。 | 执行当前明确指令，再看同目标既定策略、项目约定和任务证据。无需为普通可逆选择逐项请示。 |

ADR-010 记录了 Owner 对整任务优先的决定。ADR-015 较早的自动选择表述由后续 Skill 和 ADR-052 收窄，测试夹具也固定了只读 `auto`。用户已经选定 ZCode 时保留其选择。历史调用和 Goal 本身均不产生新派发授权。模型价格、文件数量、Prompt 长度或 Worker 能力未知，都不足以单独设立阶段门。此处区分的是交付范围，`async_wake` 与 `foreground` 单独决定 Master 是否在本 Turn 跟进。五个名称均无对应派发字段。[ADR-010](../decisions/ADR-010-whole-task-delegation.md) · [ADR-015](../decisions/ADR-015-master-skill-authorization-and-progressive-loading.md) · [ADR-052](../decisions/ADR-052-async-master-handoff.md) · [策略与优先顺序](../../plugins/codex-zcode-bridge/skills/zcode-bridge/references/delegation-policy.md) · [阶段与只读场景](../../test/fixtures/master-skill-evaluation-20261111.json)

**代码路径。** `src/api-schemas.ts:13` 为严格输入，`src/mcp/server.ts:193` 提交一个交付。Thin MCP 交给独立 Executor。Manager 选路、校验项目根与执行根、比较规范化 TaskPackage，持久受理后入队。相同 ID 不同内容返回 `TASK_ID_CONFLICT`。新建回执只有 `task_id/status/created_at`，不含 Attempt、运行模型、启动或 Wake 证明。Master 不能据此填上未观测的字段，也不应等到 `turn_started` 才承认受理。策略选择和任务拆分都发生在 Master，服务端没有自动分解器。[Manager，154–224 行](../../src/manager/sqlite-lifecycle-mcp-authority.ts#L154) · [Async 架构](../architecture/BRIDGE_ASYNC_EXECUTION_V1.md)

**推荐的最简派发合同。** 只传 Worker 在当前执行根内无法可靠推导、或决定授权与验收的内容。

| 现有字段 | Master 要给 | 留给 Worker |
|---|---|---|
| `task_id`、`workspace`、可选 `worktree_path/model/timeout_ms` | 原 ID、真实项目根和 Host 已准备的执行根。按用户选择或任务实际需要传可选值。 | 在实际执行根工作。请求的模型、预算、路径与运行时观测分别取证。 |
| `objective` | 一句话说明完成后用户可观察到什么。阶段任务只描述本阶段终点。 | 内部计划、文件定位、实现顺序。 |
| `requirements`、`allowed_paths`、`forbidden_paths` | 已批准且与本次有关的决定、非目标、权限、只读或写入范围、停止点和必须升级的问题。硬边界直接写明。 | 在边界内选择低影响实现。空 `allowed_paths` 表示无额外路径限制，只读要写明。 |
| `acceptance_criteria`、`test_commands` | 可观察结果、必要回归、已核实且必须执行的命令。没有适用命令时数组可空，并说明适合的验收证据。 | 查找其余适用测试，自行修复与重测，区分 failed 和 not_run。 |
| 可选 `context` | 用户口头决定、不可重建的短事实、经检查可读的证据位置与用途。固定输入用 `SHA:相对路径` 或内容摘要，可变输入标为 `live`。 | 从当前根读实际代码和项目说明。缺失、根外链接、已变化或不可读时报告，不按文件名猜归属。 |

五个必填数组继续存在。避免把同一决定再写入 objective、context 和验收三处。验收描述如何检验该决定。长 diff、日志和可重读文档留在原处；原聊天独有的授权不能只写“按前面说的做”。小事实可直接给，引用材料同样会消耗工具和上下文，不能为了缩短派发而把检索成本转嫁给 Worker。[字段与工件引用](../../plugins/codex-zcode-bridge/skills/zcode-bridge/references/task-dispatch.md) · [接口](../INTERFACES.md)

## 2. 首派、Continue 与报告修复实际发送什么

生产 Windows x64 Worker 选择 `OfficialAppServerWorkerAdapter`，它继承共用 Adapter。`src/worker/worker-main.ts:755` 在首派与续作之间分派。Manager 按 `previous_operation_id` 读取已提交的上一 Result。Adapter 先构建字符串，再创建或恢复 Session，最后通过 `session/send({sessionId, content: prompt})` 发送一条正文。这确定了 Bridge 能控制的边界。安装版 AppServer 与 Host 如何拼装最终模型请求，要另行取证。[Worker](../../src/worker/worker-main.ts#L744) · [Manager](../../src/manager/sqlite-lifecycle-mcp-authority.ts#L1205) · [生产 Adapter](../../src/adapters/official-app-server-adapter.ts#L46) · [发送](../../src/adapters/zcode-app-server-adapter.ts#L1023)

| 路径 | 已核实的正文 | 影响 |
|---|---|---|
| 首派 | 从动态 `TASK ID` 开头，随后是通用角色、项目/可选 worktree、请求模型和时限、交付职责，再给任务字段、决策规则、可选 context，末尾一份输出合同。 | 不同任务很早出现差异。模型选择已由 Session 配置并核对，正文重复标识的价值低于执行根、范围和预算。`context` 非空时原样进入；整条超 60,000 个 JS UTF-16 单元抛 `task_prompt_exceeds_capacity`。这是 Worker 建 Prompt 的错误，受理回执不保证构建成功。 |
| 普通 Continue | 当前反馈及新增要求；有旧 Result 时把**仅上一 Attempt**的 Result 格式化为缩进 JSON，取前 4,000 单元再加截断标记；最后嵌入 `ORIGINAL TASK` 和完整首派 Prompt。若有持久 Session ID，还提示可能有历史。 | 任务 ID、交付职责各两份，有显式模型时模型说明也重复。输出合同只有一份。按序列化位置裁剪可能用完预算仍看不到后置的失败或决定；若已进 `zcode_output`，原文又可能重复结构化声明。没有累加历次完整 Result。 |
| `invalid_agent_report` Continue | 分支跳过原始目标、测试命令和 `ORIGINAL TASK`，传错误摘要、结构化候选声明、前 4,000 单元原输出、报告反馈及一份 JSON 合同。候选声明没有单独的 4,000 限制，仍受总容量约束。 | 这条路径已专门化，值得保留。但分支判断之前已插入要求“实施、测试、修复、重测”的 `DELIVERY_OWNERSHIP`，与随后 report-only 禁工具指令冲突。现有测试验证禁令和目标哨兵，没有排除这份通用实施指令。 |

以上逐段可核 `src/prompts/task-prompt.ts:30`、`:59`、`:72`、`:89`、`:101`、`:146`。`joinBoundedPreservingTail` 超限实际抛错，没有静默截掉后段。`OUTPUT_CONTRACT` 还要求合法示例、布尔 `needs_master_decision` 和三种测试状态。已有报告修复夹具验证候选的失败声明可以保留。[Builder](../../src/prompts/task-prompt.ts) · [测试](../../test/task-prompt.test.ts) · [AgentReport 解析](../../src/adapters/agent-report.ts)

**Continue 边界。** `zcode_continue` 的公开输入是原 `task_id`、反馈、可选新增要求和 `operation_id`。同一受理的 Continue 可凭同一个 `operation_id` 和同内容对账，不能用更换 ID 掩盖未知。Store 校验前序 `completed/failed/waiting_for_master`、Release、Claim、generation/revision 和 CAS，随后在原 Task 下创建新 Attempt。Cancelled 排除。前序有 Session ID 时 `session/resume` 必须返回相同 ID，缺失或错配即失败；无 ID 时 `session/create`。成功恢复同 ID 只证明身份。当前发送路径缺少“完整用户约束仍在模型可见历史”的证明。第 N 次 Continue 明确传入的是原 TaskPackage、**本次** feedback/additional requirements 和直接前序 Result。此前经 Master 决定且仍有效的约束不能只寄托在历史文本里。[Continue 受理](../../src/manager/sqlite-lifecycle-mcp-authority.ts#L411) · [Store 检查](../../src/sqlite-candidate/wp6b2b1/store.mjs#L1612) · [恢复与新建](../../src/adapters/zcode-app-server-adapter.ts#L837)

### 推荐的 Builder

1. **首派**沿用现有字段和一次 `session/send`。先试验把真正共用的工作区边界、职责与决策规则前移，随后给一次任务数据，暂留有示例的五字段输出合同在尾部。项目根与实际 worktree 要区分。优先消除明确重复，不为延长可缓存前缀添加填充。字段次序由对照结果决定。
2. **普通 Continue**共用同一份任务字段渲染，取消外层完整首派模板的嵌套。一次交付职责、一次输出合同，加本次反馈及仍有效的补充决定。目标、硬约束、路径、验收、测试和必要背景都可在无历史时独立理解。Master 一次汇总实际验收缺口，写明已解决的旧开放问题和剩余问题。无法确认跨 Attempt 的有效决定时补齐来源或保持未决。
3. **上一 Result**只在 Prompt 中投影。优先传前序身份、状态/错误、相关路径、失败与未运行的命令及原因、未决问题和确有需要的原文片段。正常的小结果无需为了投影增加一轮读取。以前序声明标注来源与省略项，将失败和未决问题排在成功清单前。省略可能改变返工判断时，Master 从同 Attempt full/事件核对后给反馈，证据仍不足则停止。MCP 面向展示的 `summarizeTaskResult` 会省略测试详情，不能直接拿来当返工材料。[现有摘要](../../src/result-summary.ts#L7)
4. **报告修复**先分支，再选择职责说明。用独立的“只修报告”短指令，保留错误、候选、必要原文、反馈和同一输出合同。工具、改文件、重跑和伪造证据均禁止，未知决定按 `true` 并解释。普通 Continue 的执行职责不能出现在这里。保留 60,000 总容量和有界原文，超限仍显式失败。

这套最低风险的去重适用于恢复成功和无 Session 的两种普通续作。更激进的“已 resume 就只发 feedback”目前没有证据支持。附带原始要求不意味着 Worker 必须重新做已完成的工作，续作焦点应由 Master 的失败证据和剩余验收项决定。

## 3. Async 受理、Wake 与 Master 的输入

| 时点 | 最少动作 | 异常路径 |
|---|---|---|
| 受理 | 完成 Ready Gate，确认原 ID 的可靠回执。做一次有界启动/Attention 核对，保留能验证的 Task、Attempt、Authority、Thread 和执行路径。只给用户目标、范围、受理状态、交接方式、一次性 Wake 模式或 Web 回退，以及经 Executor 验证的 `web_url`。然后结束 Turn。 | 回执未知先查原 ID/Authority，仅在能安全重放时原样重放。有已知 Pending、启动错误或清理未决先处理。排队受理后若已终态，直接走验收。链接未知则给安全查询方式。 |
| 受理以后 | 独立 Executor 持有 Worker。交接完成后前台空闲 `events/status/Waiter` 调用为 **0**。严格 Queue 需匹配一次性 Owner policy 和实时 loaded/idle、workspace、精确模型配置。显式 trusted-local 的风险由 Owner 接受。 | Queue 条件不足只承诺 Web Notify/下次用户 Turn。`submission_unknown` 禁止自动重送。断连、Turn end 和等待超时不取消任务。后发 Pending 没有自动 Wake，审批由用户明确授权。 |
| Wake | 当前消息已经很小，只给 Task、Attempt、Operation、Result 状态、digest、commit ref 和原生回读/验收指令。保留这些绑定和禁止重复派发的防线。 | 不在消息重贴 TaskPackage、原对话、日志、Worker 原文或完整测试清单。Queue ACK、Turn Started/Completed、Desktop Visible 各按独立事实记录。 |
| 恢复验收 | 用 Host 原生 `zcode_status({task_id})` 核对当前 Attempt，再读 `zcode_result({task_id,view:"summary",expected_attempt:n})`。用 `zcode_events` 限量、`wait_ms:0`、`include_attempt:true`，从已知游标核对 `result_committed` 的 digest/commit ref、同归属 Cleanup 与 released；必要时分页。最后在实际执行根复核 diff、文件和适用测试。 | 当前 Attempt 已推进、digest/commit ref 冲突或归属不明则保持未验收。摘要遗漏验收所需字段，用同 Attempt `full`。已知要原文的失败取证可直接 full；小于等于 2 KiB 的 summary 已返回完整数据，无须重读。原生工具有错保留原错误，禁止 shell 子进程代读。 |

建议首先改回读指引，Wake 消息字数属于次要收益。`zcode_status` 只接收 `task_id`。`expected_attempt` 是 Result 读取时的当前身份栅栏，不能用来检索任意历史 Attempt。Result 摘要不保证含 digest、Operation 或 Release 证明，摘要自身的 JSON 也不能用于重算完整 Result 的 digest。真实 loaded/idle 样本在事件 26 匹配 digest，在 28 和 29 核对 Cleanup、Release；当时同时读过 summary 和 full，不能把两读固化为每次流程。若原聊天中的验收目标已不可恢复，须从受信项目材料或用户恢复该目标，否则只报告可核实的生命周期结果。[Wake 消息](../../src/executor/wake.ts#L704) · [Status 与 Result 参数](../../src/mcp/server.ts#L204) · [Event 投影](../../src/manager/sqlite-lifecycle-mcp-authority.ts#L1444) · [真实验收记录](../reports/trusted-local-wake-20261123.md#L330)

## 4. Skill 修改范围

| 位置 | 现状与建议 |
|---|---|
| `SKILL.md:32`、`:42`、`:45`、`:58` | 入口保留调用授权、完整交付、停止、审批、独立验收和受理即结束。把发布实测历史与重复操作细节留在现有报告或 reference。入口给一次分流。ADR-015 要求提交前读监控指引，可保留对短审批/异常规则的必读入口；若要完全取消这项前置，先由 Owner 裁决。 |
| `references/task-dispatch.md:8`、`:21`、`:45` | 改掉“返回后立即跟踪事件”和“只保留前 2,000 字符”。前者应先区分交接方式，后者已被 ADR-038 和 Unicode 边界测试反证。模板只要求写本任务特有的自主范围和升级点，通用自治与报告格式由 Builder 提供。已有工件引用规则可直接复用。 |
| `references/monitoring-and-approval.md:10`、`:19` | 第一步先要求等 `turn_started`，之后才出现仅限 foreground 的限定。把限定放在第一步之前。Async 只执行有界核对；Pending 的原请求、归属及明确授权仍为必查。 |
| `references/async-handoff.md:68`、`references/review-and-recovery.md:12` | 前者统一说明原生摘要和事件分工，后者保留工程验收、full 升级及返工条件。修正 recovery 第 30 行“可选 Project Ledger”旧建议，保留核心 MCP 无全局枚举这一事实。ADR-038 已退役 Ledger；`test/skill-policy.test.ts:66` 仍强制旧句，需要同步为当前合同的行为断言。 |
| `references/reporting.md:12` | 将 Status、Attention 和 Events 按实际归属写清。Pending 详情与带 Attention 的有界事件查询有现有入口，不期待 Status 返回完整交互或 Release 凭证。交接字段集中在 async reference 即可。 |

沿用现有文件。`delegation-policy.md`、`goal-lifecycle.md`、`runtime-boundaries.md` 的策略和边界可保留。若 Owner 希望普通派发不再预载长篇 foreground 手册，优先在现有文件内移动短段落，校验 ADR-015 必经审批规则和 ADR-052 的分流。当前审计不提出新策略文件、两级用户报告或机器字段。[Skill](../../plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md) · [审批指引](../../plugins/codex-zcode-bridge/skills/zcode-bridge/references/monitoring-and-approval.md) · [ADR-038](../decisions/ADR-038-preview6-minimum-architecture-remediation.md)

## 5. 离线数值与真实缓存边界

本轮直接调用基线 TypeScript 纯函数，在内存中做局部文本对照。Node `24.16.0`，`js-tiktoken@1.0.21/o200k_base`，仅计单条正文。该编码用于复现仓库既有代理口径。这里的输入长度和公共前缀可以重算，模型实际输入、Cache Read、宿主遵循率、每项验收交付的成本均未测量。

| 合成样本 | 基线 | 对照 | 能归因的量 |
|---|---:|---:|---|
| 首派 A 的总量 | 3,450 单元 / 692 Token | 3,450 / 692 | 只移动固定段，长度收益为 0 |
| 首派 A、B 的最长公共前缀 | 9 单元 / 3 Token | 1,564 / 290 | A 的正文公共 Token 占比约 0.4% → 41.9%，只对应这对输入 |
| 普通 Continue，短失败 | 4,960 / 1,041 | 4,292 / 912 | 去掉一份职责节省 129 个代理 Token，约 12.4% |
| 普通 Continue，长日志 | 8,519 / 2,103 | 7,851 / 1,974 | 同样节省 129 个，约 6.1%；Result 的裁剪方式仍占主要增量 |
| 报告修复，长原输出 | 6,989 / 1,953 | 6,321 / 1,824 | 仅去掉相冲突的实施职责，候选证据、原输出与合同均保留 |
| 容量边界 | 首派 60,000 单元可构建 | 同任务短反馈 Continue 达 61,510，抛容量错误 | 受理过的首派不保证一定能续作，硬约束不能静默截断 |

**复算方法。** A 取 `test/helpers.ts:60` 的 `makeTask({task_id:"A1"})`。B 只替换 ID 为 `Z9`、目标为 `Review the parser, read only.`。按双换行切段，角色句、`DELIVERY OWNERSHIP` 和 `DECISION RULE` 按原相对顺序移到最前，其他段不动。逐 Token ID 比较直到首个差异。Continue 用 `feedback="Fix the extra line."`，无新增要求，Session `S1`。上一 Result 按 `task_id,status,summary,files_changed,tests,issues,needs_master_decision,zcode_output,exit_code,session_id,attempt,started_at,finished_at` 顺序构造，值依次为 `A1`、`failed`、`Smoke check failed.`、`["bridge-smoke.txt"]`、`[{"command":"check","status":"failed","details":"Unexpected extra line."}]`、`["Remove extra line."]`、`false`、空串、`1`、`S1`、`1`、两个 `null`。长日志替换输出为 700 次 `log line\n`。报告修复额外传 `error_code="invalid_agent_report"`、含原 `summary/tests` 的 candidate。去重对照只删除首次出现的职责段及随后的双换行。容量样本用 `x` 补 `context` 至整条首派恰好 60,000。没有修改 Builder。

Master 文件单独编码并统一 LF 后，根 Skill 为 2,495 个代理 Token，dispatch 为 1,856，monitoring 为 1,964，async 为 2,107，review 为 1,737。这些数字衡量每个动作可能调入的材料。某段若已在同一线程上下文中、由 Host 缓存，或只读了部分，不能按文件大小直接认领节省。Master 优先做两件事：去掉每个空闲等待引起的新增模型轮次；Wake 在原 Thread 复用稳定指引与工具目录，动态消息只放绑定和必要动作，不重贴前一轮的总结。重新排列 Wake 短消息的预期价值低于减少一次无用读回。

**实际缓存证据。** Z.AI 公共 API 文档描述系统可复用重复的系统提示和会话历史，并在 `usage.prompt_tokens_details.cached_tokens` 提供读数。Coding Plan、Start Plan 和 Master 各自实际走什么路由、采用何种最小块、保留时间、相似性判断与缓存命名空间，在此基线不确定。Bridge 能控制的是 `session/send` 正文和 Master 自己追加的内容，工具目录、系统指令、项目指令、恢复历史和额外模型请求都会影响最终输入。不要跨 Provider 套用固定阈值。[Z.AI Context Caching](https://docs.z.ai/guides/capabilities/cache) · [生产发送边界](../../src/adapters/zcode-app-server-adapter.ts#L1023)

已有两类真实读数可供对照。历史 Worker Coding Plan 样本有 22,657 uncached input、0 cached input。隔离 loaded/idle Wake 的单个 Master Turn 累计 input 134,805、cached 128,256，含多个调用。两者来自不同任务与执行侧，不能据此归因到模板或推广为产品命中率。此前的 27.2% 是另一组 MCP Envelope 等离线代理量，大样本主导，普通样本中位数未改善。历史单版 Host 回环看到模型消费 `structuredContent`，不能把 MCP text 和 structured 两个返回通道都算作新增模型输入。[Worker 实测](../evidence/coding-plan-official-discount-verification-20261118.md) · [Wake Turn 累计量](../reports/trusted-local-wake-20261123.md#L352) · [历史 A/B](token-efficiency-phase0-20261121/TOKEN_EFFICIENCY_AB_REPORT.md)

## 6. 验证门与风险

| 验证层 | 固定变量与比较项 | 接受条件 |
|---|---|---|
| 离线正文 | 冻结本 SHA 和输入，分别比较仅去重、仅重排、仅投影，再组合。包含只读、worktree、已批准/未决决定、无 Session、多次 Continue、长失败、报告修复、Unicode、恰好容量及 +1。 | 强制字段、禁止路径、授权、有效决定、验收/测试逐项保留；无 JSON 实施指令冲突；关键失败不会被成功清单淹没。按分层报告 UTF-16、UTF-8、代理 Token、逐 Token 公共前缀。 |
| 无模型生命周期与 Skill | 合成 Worker/原生 MCP 跑受理交接、丢回执幂等、Pending、Release 后 Wake、重复或过时 Wake、原生回读失败、摘要缺项与成功返工。静态夹具继续覆盖有门/无门、只读 auto 和用户已选执行器。 | Async 受理后空闲前台调用为零。无重复 Task/Attempt/Queue；跨 Attempt 不误验收；同范围返工才可 Continue；所有已知 Pending 都保持审批边界。必须独立检查非空 diff、文件与适用测试。 |
| 经 Owner 另行授权的模型 A/B | 冻结 Host/Runtime、Provider、模型/effort、工具目录、工作树与验收，按冷/热、同线程/跨任务、同 Session/新 Session 分层，配对并交错顺序，隔离交叉预热。单独测 Master、Worker、辅助请求和整项交付。 | 同时报告绝对 cache read/write、总输入/非缓存输入、输出、请求数、返工/修复次数、墙钟及每个独立验收成果的结算成本。分层给配对差异、分布和不确定区间。授权越界、漏报失败、错误放行或错误接收直接否决。 |

实际命中宜同时报告“有 Cache Read 的请求占比”和“读缓存 Token 占可比较输入的比例”。先核实 Provider 的 input 是否已含 cached，若不含再按该 Provider 口径还原分母。保留 Usage 的来源、scope、finality、缺失和冲突，避免把累计 Session、同一请求的 Event/Result、cache write 重复算入 read。缩短输入后即使命中比例下降，每项验收交付的费用仍可能下降，反之亦然。没有请求级归因、可执行硬预算、受支持 Runtime 或隔离账单时，结论保持不确定。复用现有门禁，无需新增常驻采集器或扫描其他会话。[Usage 归一化](../../src/usage/normalize.ts) · [真实试点门禁](token-efficiency-phase0-20261121/TOKEN_EFFICIENCY_RELEASE_GATE.md#L74)

当前公开证据仅覆盖一次真实 loaded/idle trusted-local Wake、Native MCP readback 与生命周期验收。严格 C/D、Desktop 完全退出、该次 Official Runtime provenance、非空工程验收及模型 Skill 遵循率，仍需分别验证。`yolo` 和 worktree 不提供 OS 沙箱；取消、额度耗尽、凭据和提交/推送/发布权限、Hold 与行政释放保持原合同。Result committed、Cleanup verified、Operation released、工程验收和接收应分别记录。涉及修改权威行为的后续方案先取得 Owner 决策并按仓库规则登记 DECISION。[项目状态](../PROJECT_STATE.md) · [Wake 合同](../decisions/ADR-051-executor-wake-delivery.md)

本次在项目内的隔离基线检出运行 `npm run test:affected -- --base HEAD --t0-only`，返回 `T0_ONLY_PASS`。Typecheck、构建、插件结构、14 份生成物新鲜度与 diff 检查通过。影响选择为 `documentation-only / NO_TESTS_APPLICABLE`，选中功能测试 0 项。完整回归、真实 Worker/Host A/B 和付费模型请求均为 `NOT_RUN`。
