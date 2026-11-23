# 执行监控、互动与审批

> Status: AUTHORITATIVE
> Last updated: 2026-11-23（Async 默认受理核对）
> Last verified: 2026-11-23，核对 `zcode_events` 默认 32 KiB 页预算、显式 `max_bytes`、`scan_incomplete`/cursor、Attention、Attempt 归属与 SQLite interaction 读取；真实模型 Async Handoff 遵循率 NOT RUN。
> Verified against: `origin/preview@89ca334802f6e5c1e88b8284863f8151bf4be134`（审计基线；本候选待验收）

## Async 受理核对

默认采用 [Async Handoff](async-handoff.md)。`zcode_task` 返回可靠受理回执后，只做一次有界受理核对：

1. 调用 `zcode_events(after_seq: 0, view: "summary", include_attempt: true, wait_ms: 0)`，核对 Task/Attempt 归属、queued/running、`attention.pending_requests`、已有启动失败或终态，以及可得的 `workspace_ready`/`session_ready` 路径。只有派发时的路径时标“请求”，实际路径缺失时标“未确认”。不要为等待 `turn_started` 继续调用 `wait_for` 或 Thin Waiter。
2. 省略 `max_bytes` 时 Manager 使用 32 KiB 页预算；`has_more` 或 `scan_incomplete` 为真时用 `scan_cursor`（否则用 `next_seq`）只补读当前页，不重复查询未变化的状态。不要把连续 `model_output`/summary 转发给用户或作为新的模型输入。
3. 无已知 Pending、启动失败或未决清理事实时，记录可核实的身份、路径和当前状态，向用户报告并结束 Turn。回执未知、出现 Pending、启动失败或终态时留在当前 Turn：回执按 [async-handoff.md](async-handoff.md) 对账，Pending 转入互动，终态转入独立验收。

仅 Thread/Wake 绑定不可用时，使用 Web Notify 回退并结束 Turn；不得把回执未知、启动错误、清理未决或 Authority/授权边界无法确认当作可结束的 Async 交接。

## Foreground 跟进

仅在存在已知 Pending Interaction、必须即时处理的审批或用户明确要求时使用 foreground。以下长等待与 Thin Waiter 不属于 Async Handoff。

1. `zcode_task` 返回后立即调用 `zcode_events`（`after_seq: 0, view: "summary"`），报告 queued/running 和工作路径。用 `workspace_ready`（若有）或 `session_ready` 核实项目根目录、实际执行目录和 worktree。只有派发时的路径时标“请求”，实际路径缺失时标“未确认”。启动阶段用普通事件等待（`wait_ms` 最大 25000），直到当前 Attempt 的 `turn_started`、启动失败或终态。省略 `max_bytes` 时 Manager 使用 32 KiB 页预算；`has_more` 或 `scan_incomplete` 为真时用 `scan_cursor`（否则用 `next_seq`）增量续读，不重复查询未变化的状态。
2. `turn_started` 后向用户报告项目根目录、实际执行目录、session ID、runtime 报告的 provider/model/reasoning 和执行模式。模型和档位只读 `session_ready` 或 `model_selected` 的 runtime details。只有请求值时标“请求”，缺失写“未报告”。生产受信任本机 profile 当前映射 `yolo`，普通工具可自动执行并使用当前 OS 账户，不提供 OS 沙箱。
3. 消费一页后将 `next_seq` 用作下次的 `after_seq`。默认 `view: "summary"`，它只合并同一 Attempt、同一 Operation 内连续的安全模型文本，保留交互、错误、Hold 与终态。默认预算只限制单页输出，不删除持久事件；`has_more` 或 `scan_incomplete` 时先以 `wait_ms: 0` 补读，用返回的 `scan_cursor`（若有）或 `next_seq` 续页。显式 `max_bytes` 仍是硬预算；若单个事件超限且游标未推进，从同一位置提高该次预算后重读。不要把连续 `model_output`/summary 转发给用户或作为新的模型输入。
4. 心跳、工具事件和文件变化分别证明不同事实；没有输出或结果时不推断测试通过、源码已还原或任务完成。`stalled` 只是观测提示；短静默先查业务事件、文件变化、交互、心跳和进程身份，不立即取消或重派。
5. `zcode_feedback` 是当前 Attempt 的简洁机器投影；`last_observed` 不是实时工具状态，`interaction: not_observed` 不代表没有交互。终态后按需读取 feedback 与 result；两者都不替代独立验收。
6. 安装、运行时或 provider 配置异常先调用只读 `zcode_doctor`；`unknown` 不是通过。诊断不得读取或写入凭据。

工具支持时，读取启动、等待与验收事件均传 `include_attempt: true`。用 Status 或 Attention 核对当前 Attempt，再选择逐条 `event.attempt` 相符的启动、授权与结果事件。页内可以包含多个 Attempt。旧 schema 下仅使用已知归属的事件，多个 Attempt 且无可靠归属时将启动或释放标为未验证。

## 有界等待

确认当前 Attempt 的 `turn_started`、报告启动信息并读完事件分页后，只需等待权限/输入、终态或 Attempt 变化时，用原游标调用 `zcode_events(view="summary", wait_for="attention", wait_ms=25000)`。同一返回包含事件页和最新 `attention`。每次只保留一个等待调用。空页可沿游标继续等。普通事件及 Hold/Cleanup 变化不保证唤醒，出现异常或到诊断检查点时读 `zcode_status`。

- 对长时间正常运行且当前无 Pending 或待处理异常的 Attempt，可选 Thin Waiter。复用近期 Attention 和 Status 核对该条件，必要时即时补读。从本次 MCP 的启动入口和 Authority 配置核实实际插件根、含 `bridge.sqlite` 的绝对 state 目录和原回执的 `task_id`。三者绑定明确且宿主能接收命令退出时，用受支持的 Node 启动该插件的 Waiter，最多等待 120 秒。

  ```text
  node "<installed-plugin-root>/dist/wait-task.mjs" --task "<task_id>" --timeout-s 120 --data-dir "<absolute-sqlite-state-dir>"
  ```

- Thin Waiter 退出码 `0` 表示 Pending、终态或 Attempt 变化，`3` 表示本次等待超时，`2` 表示参数、配置或读取错误。以 `zcode-bridge/wait-task-v2` 和匹配的 `task_id` 核对返回的 JSON。输出中的 `pending_requests` 是可能截断的 ID 列表，完整请求与当前 Pending 通过 MCP 核实。
- Thin Waiter 正常退出或超时后，从等待前的游标用 `zcode_events(wait_for="attention", wait_ms=0)` 确认并消费增量页，再用 `zcode_status` 核对当前 Attempt、`error_code` 和 `execution_observation`。绑定无法确认或 Waiter 不可用时沿用 MCP Attention。
- 用 `attention.attempt` 及 Waiter 的 `initial_attempt` / `attempt` 核对预期 Attempt。变化时保留任务游标，重新核对启动身份。当前 Pending 转入互动。终态（含 `waiting_for_master`）转入独立验收，分别核实 Result、Hold/Cleanup 与 Release。发现 Result 提交异常或仍有 Hold 时退出空闲等待，保留未验证的占用。
- `TASK_NOT_FOUND`、读取失败、Waiter 输出无法核实或 `interaction_reply_outcome_unknown` 时报告实际错误，用原 Task/Authority 的 MCP 即时核对 Attention、Status 或 Raw Events。再次满足空闲条件后才继续等待。请求中止或回执丢失时保留最后已消费的游标，恢复跟进时先以 `wait_ms: 0` 核对原任务。任务取消走独立的 `zcode_cancel` 授权流程。

## 互动

启动或运行期间看到 `interaction_requested` 或 Attention 有 Pending 时，用当前 `attention.pending_requests` 核对 `details.request_id`（必要时先以 `wait_for: "attention", wait_ms: 0` 读取）。读取持久请求的 method、工具、理由、输入、选项或问题。若请求事件已在监控游标之前或本页详情不全，以独立的 `view: "raw"` 补读游标从该请求之前分页（位置未知则 `after_seq: 0`），按需提高或省略 `max_bytes`。保留主监控游标，回复前再次以 Attention 核对当前 Attempt 和 Pending。请求内容或归属不明时保持未决。只有用户明确授权该具体操作才能用 `zcode_interaction_reply` `allow`。

默认 32 KiB 页预算对单条超限交互保留安全例外，但事件已返回不等于请求内容完整。显式 `max_bytes` 下若返回 `scan_incomplete`，先提高该次读取预算并继续同一 cursor。worktree、`yolo`、TaskPackage 或历史授权都不构成许可。

用户输入只依据已知事实或用户明确回答。AskUserQuestion 从 `details.params.questions`（嵌套工具输入时为 `details.params.input.questions`）读取；`answers` 以每个问题完整原文为键，不用 header/选项标签替代。回复后继续观察，Bridge 校验请求与原 Worker 通道身份，失败时保持未决并报告。
