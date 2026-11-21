# 独立验收、返工与恢复

> Status: AUTHORITATIVE
> Last updated: 2026-11-22（行政释放保护与默认 Event 页）
> Last verified: 2026-11-22，核对 opt-in Result 摘要、Event Attempt 归属、16 MiB 原证据回读边界、ADR-039 行政释放资格与 SQLite Hold 合同；真实生产恢复 NOT RUN。
> Verified against: Preview `450c18afc0c8af2700734399c5aebd87a36df795` + unified integration candidate

## 验收与接收

1. 在事件报告的实际执行目录检查 Git 状态、完整 diff、实际文件和适用验证。`whole_task` 验收整个授权任务；`staged` 验收当前阶段及交接条件，明确后续目标未完成。验证命令和分层遵循当前项目自己的权威说明，不把 Worker 自报、工具成功或 `completed` 当作验收。
2. 终态常规用 `zcode_result(view="summary")`，旧 schema 用原 `task_id` 调用。已知需要原文时直接用 `view: "full"`，已知 Attempt 时同时传 `expected_attempt`。用 Result 的 `attempt` 核对执行归属。`projection.omitted_fields` 中验收所需的证据在续作前按同一 Attempt 补读。原文超过宿主接收上限或读取失败时，记录具体缺项，必要的验收或报告修复保持未决。Master 独立核验 AgentReport 声明。
3. 审查通过后，按用户授权接收所需改动；保留既有用户改动、检查冲突并复验。Bridge 不自动应用、合并、删除 worktree，也不自动提交、推送或创建 PR。
4. 结果不达标时汇总全部失败证据，用 `zcode_continue` 做一次完整返工。保持原策略和授权，只收紧实际失败维度，不追加无关规则、不拆成微任务、不无限原样重派或自动换模型。
5. `invalid_agent_report` 且执行已完成时，直接读全量核对 `report_candidate`、`zcode_output` 和实际 diff。续作只修复 JSON 报告。缺失决定只能基于证据补齐，无法确认则 `needs_master_decision=true`。

## 失败、取消与 Hold

- `failed` 用 `zcode_result.error_code` 判断原因，不用 feedback 标签替代。`cleanup_failed` 或 `cleanup_unverified` 是清理事实，与代码验收分开；后续 `observation.cleanup=verified` 只说明取得退出证据，不改写历史失败。
- Result 可先于 Cleanup 和 Release。终态后按原游标有界补读 Events，支持时用 `include_attempt: true`。用 Status 核对当前 Attempt 与 Hold。已提交 Result 的 Release 需要 `released` 和 `result_committed` 均属于受审 Attempt，且 `details.result_commit_ref` 相同。旧 schema 下须有独立的 Attempt 归属证据。无 Result 的取消和 `admin_abandoned` 分别按其现有取消、行政放弃证据核对。`admin_abandoned` 的占用已释放，Cleanup 仍未验证。归属或释放不明确时报告未验证，保留占用边界，暂缓续作和重叠工作区派发。
- `zcode_status.execution_observation.state=interrupted_without_result` 只表示持久 Worker 身份已退出；当前生产 Adapter 缺少独立 Cleanup Proof 时 Recovery 仍以 `adapter_cleanup_unverified` 保持 Hold。Fake Adapter 的合成重派分支不是当前生产能力，不得据此承诺自动重派。
- 对已知 `failed + cleanup_unverified` Task，先报告可确认的 workspace、Task、Attempt 和原因。核心 MCP 没有 Bridge Task/Attempt 全局枚举工具；可选 Ledger 只能枚举其管理的 ProjectTask，不能发现所有 Bridge 任务。`zcode_status` 不返回 workspace；缺失写未知，不猜测。
- `zcode_cancel` 只接受 `{ task_id }`，可能按原 PID/start fingerprint 终止仍存活 Worker，没有 dry-run/authorize 参数。用户授权的是当前明确 Recovery 操作，不是无限期终止权限；必须先取得用户的明确授权。获准后同一 Operation 一次只发起一个 cancel，调用后读 `zcode_status`。重复取消只可对已被取消且无持久 Spawn 证据的历史 `launch_intent`，或已有终态 `cancelled` Result、exact identity 已退出且 tree scan clean 但 Adapter closure 仍缺失的 `cleanup_unverified` 执行行政释放。带 Launch Receipt/Identity 的 Intent、live descendant、活动或终止失败 Worker、identity unknown 与脏树继续占用。
- Recovery 只有原身份、recorded-tree claimant、interaction 状态和 Operation CAS 全部验证成功才释放；失败、未知或响应丢失保持 Hold。停止失败后先重新核对原 Worker 身份和状态，原授权范围内可再次尝试；目标身份或操作范围变化时重新取得用户授权。不得并发重复发出终止信号，也不得拼接底层清理命令、重放 Prompt、创建 Attempt 或手工改 SQLite 绕过。
- Recovery 成功后先检查原 workspace Git diff/WIP，再讨论是否创建新 Attempt；不自动 reset、clean、覆盖 checkout 或删除用户源码。单路径 Hold 不阻塞其他独立 workspace。
- 用户取消时调用 `zcode_cancel` 并确认终态。`zcode_usage_exhausted` 表示本次执行中断：停止编辑、派发、续作和自动重试，告知用户并等待确认额度恢复。

- Host 对指定任务的明确取消授权应直接用于该次 `zcode_cancel`，不重复申请。ADR-039 支持取消无 Claim 的 Launch Intent；若返回 `cancelled + cleanup_held`，只表示后续执行已被禁止，不能声称资源已释放或立即派发重叠路径。`zcode_status.dispatch_blocker` 的 `workspace_occupied` 表示执行路径重叠，`capacity_occupied` 表示只有不同 Workspace 的容量占用；报告阻塞 Task/Operation/phase/Workspace 与阻塞时长。用户再次明确取消同一历史阻塞后可继续原取消入口；只有实际 `released` 且 `cleanup_verified=false` 的行政释放才解除占用，仍须保留原 Result/Events 并检查 Workspace WIP。未知身份、quarantine、活动 Worker、终止失败或不完整树证明保持占用，不手工解锁。
