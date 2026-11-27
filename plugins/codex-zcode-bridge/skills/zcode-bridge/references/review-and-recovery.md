# 独立验收、返工与恢复

> Status: AUTHORITATIVE
> Last updated: 2026-11-25（最终目标负责与自治返工）
> Last verified: 2026-11-25，核对 Continue/Release、字段继承、Queue 未知与 R10 输入目标保护；真实模型遵循率 NOT RUN。
> Verified against: `6af69b55d7ecb660c2ad2c923888cf7f1e8886c8` + 本候选

## 验收与接收

Wake、Queue ACK 或新 Turn 都只触发恢复检查。先核对 Wake 的 Task/Attempt/Operation/Result digest 与交接身份，再用同 Task 的 Status/Events 核对持久事实；digest、commit ref、Cleanup 与 Release 不能从摘要反推。不一致或无法归属时不得验收，顺序见 [async-handoff.md](async-handoff.md)。

1. Master 对最终目标负责。在实际执行目录核对 Git/diff/文件和适用验证；`whole_task` 验完整任务，`staged` 验当前阶段。Worker 自报、工具成功和 `completed` 都不是验收。
2. 终态用 `zcode_result`；`summary` 缺证据时按同一 `expected_attempt` 读 `full`，用 `attempt`/`projection.omitted_fields` 核对归属。超限或读取失败保留具体缺项；独立核验 AgentReport。
3. 通过后按授权接收，保留用户改动、检查冲突并复验。Bridge 不自动应用、合并或删除 worktree，也不提交、推送或建 PR。
4. `invalid_agent_report` 先核对 `report_candidate`、`zcode_output` 与实际 diff；只修报告，禁工具/改文件/重跑。无法确认的决定置 `needs_master_decision=true`。
5. GUI 输入保护核对精确目标：主窗口前台不证明对话框或控件获得输入，鼠标/键盘序列部分发送后继续执行也不证明成功；每次注入前未核实精确 HWND/PID 或目标落点即失败返工。

Result 已提交、Cleanup 已验证、Operation 已 `released` 仍不是接收；返工、审批或新目标不得以 Wake 扩大权限。

## 验收失败后的自治返工

失败后依据 diff、文件、验证与 Result/Events 诊断根因，普通工程缺陷直接返工，不请求批准；首次失败至少完成一次返工。比较前一返工 Attempt：新增通过项、失败收敛或出现可行动证据即进展；同一根因无进展才熔断并报告证据/阻塞，不以次数、耗时或 Token 猜测。

- Continue 优先：前序为 completed/failed/waiting_for_master、已 `released`，且无 Pending/Hold/归属冲突时，用同 `task_id` 执行 `zcode_continue`，提交完整根因与验收缺口。
- Continue 不可用、原授权/路径不变且 Workspace 无活动/未知占用时，用 `zcode_task` 建关联返工 Task。`context` 记录原 task/attempt/result digest 与根因；继承最终目标、requirements、workspace/worktree、请求的模型与 reasoning effort、timeout、验收和测试。原值缺失不猜。
- 只可补充或收紧验收，不得降低或重解释。保留失败 Task/Attempt/Result/Events 与原 WIP，不取消、覆盖、reset、clean 或改写历史。
- 新授权/合同/权限/外部副作用、用户取消/停止、Pending、`zcode_usage_exhausted`、未决 Hold 或占用未知时停止并报告。`SUBMISSION_UNKNOWN` 按原 `task_id` 对账；不得重复未知 Queue submission、换 Task 掩盖或绕过 Hold。

本闭环不新增 Goal Skill、目标数据库、Scheduler、递归 Worker 或第二授权体系；状态只来自现有 Task/Attempt/Result/Events 和当前 Turn。

## 失败、取消与 Hold

- `failed` 用 `zcode_result.error_code` 判断原因，不用 feedback 标签替代。`cleanup_failed` 或 `cleanup_unverified` 是清理事实，与代码验收分开；后续 `observation.cleanup=verified` 只说明取得退出证据，不改写历史失败。
- Result 可先于 Cleanup 和 Release。终态后按原游标有界补读 Events，支持时用 `include_attempt: true`；用 Status 核对当前 Attempt 与 Hold。已提交 Result 的 Release 需 `released` 与 `result_committed` 同属受审 Attempt 且 `details.result_commit_ref` 相同；旧 schema 须有独立 Attempt 归属证据。无 Result 的取消和 `admin_abandoned` 按现有证据核对；后者占用已释放但 Cleanup 未验证。归属或释放不明确时报告未验证、保留占用并暂缓续作/重叠派发。
- `zcode_status.execution_observation.state=interrupted_without_result` 只表示持久 Worker 身份已退出；生产 Adapter 缺少独立 Cleanup Proof 时仍以 `adapter_cleanup_unverified` 保持 Hold。Fake Adapter 的合成重派不是生产能力，不得承诺自动重派。
- 对已知 `failed + cleanup_unverified` Task，先报告可确认的 workspace、Task、Attempt 和原因。核心 MCP 没有 Bridge Task/Attempt 全局枚举工具；只能使用用户给出的或已记录的原 `task_id`，不得猜 workspace 或扫描其他任务。`zcode_status` 不返回 workspace；缺失写未知，不猜测。
- `zcode_cancel` 只接受 `{ task_id }`，可能终止仍存活 Worker，没有 dry-run/authorize。用户授权的是当前明确 Recovery 操作，不是无限期终止权限；必须先取得用户的明确授权。获准后同一 Operation 一次只发起一个 cancel，随后读 `zcode_status`。历史 `launch_intent` 需再次显式取消；四种终态 Result、exact identity 退出且 tree clean 但 Adapter closure 缺失的 `cleanup_unverified`，显式调用一次即进入统一行政释放。行政释放不是 Cleanup；原 Result/Events 不变。带 Receipt/Identity 的 Intent、live descendant、活动或终止失败 Worker、identity unknown 与脏树继续占用。
- Recovery 只有原身份、recorded-tree claimant、interaction 状态和 Operation CAS 全部验证成功才释放；失败、未知或响应丢失保持 Hold。停止失败后先重新核对原 Worker 身份；原授权范围内可再次尝试，目标或范围变化时重新授权。不得并发重复发出终止信号，也不得拼接底层清理命令、重放 Prompt、创建 Attempt 或手工改 SQLite 绕过。
- Recovery 成功后先检查原 workspace Git diff/WIP，不自动 reset、clean、覆盖 checkout 或删除源码；单路径 Hold 不阻塞其他独立 workspace。用户取消时调用 `zcode_cancel` 并确认终态；`zcode_usage_exhausted` 后停止编辑、派发、续作和自动重试，等待额度恢复。
- Host 的明确取消授权直接用于该次 `zcode_cancel`，不重复申请或切换授权流程。ADR-039 支持取消无 Claim 的 Launch Intent；`cancelled + cleanup_held` 只表示禁止后续/重叠派发，不表示资源已释放。`workspace_occupied` 是路径重叠，`capacity_occupied` 是不同 Workspace 的容量占用；报告 Task/Operation/phase/Workspace 与阻塞时长。再次明确取消同一历史阻塞后可继续原入口；只有实际 `released` 且 `cleanup_verified=false` 的行政释放解除占用，仍保留 Result/Events 并检查 Workspace WIP。未知身份、quarantine、活动 Worker、终止失败或不完整树证明保持占用，不手工解锁。
