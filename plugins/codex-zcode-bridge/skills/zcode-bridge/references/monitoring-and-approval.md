# 执行监控、互动与审批

> Status: AUTHORITATIVE
> Last updated: 2026-11-01
> Last verified: 2026-11-01，仅核对 Codex Rollout Master token 起点；真实Worker、Host按需加载强制与token收益 NOT RUN。
> Verified against: bfab3386937f552d4c60761f32df9ea097fcb6f1 + Codex Rollout token候选；来源74d4764和经审查的JSON文案。

## 跟进

监控默认被动：Worker 正常实现、测试和修复时只观察进度，不向 ZCode 发送下一步指令；长时间没有输出时先查业务事件、执行目录文件变化、待处理交互、心跳和进程身份，再判断是否阻塞。只有 Worker 主动请求决定/权限、完整交付或明确失败时才介入。

0. 在本次委派开始前取得 Master token 起点：把 `SKILL_DIR` 设为当前 `SKILL.md` 所在目录，运行 `node "$SKILL_DIR/scripts/codex-master-token-usage.mjs"`。只读取 `CODEX_THREAD_ID` 指向的本机 Codex Rollout，不扫描最近活跃会话，不调用模型；保存返回的 `query.total.totalTokens` 作为报告窗口起点。命令返回 `thread_id_missing`、`rollout_not_found`、`thread_identity_unverified`、`no_token_count` 或 `file_changed` 时，保留该明确状态，不得猜测 Thread。
1. `zcode_task` 返回后立即调用 `zcode_events`（`after_seq: 0, view: "summary"`），不要先做别的工作或只复述 queued receipt。先报告 `workspace_ready` 中的 `project_path`、`execution_path`（如有则说明 Codex 准备的 worktree）和 queued/running 状态。按 `next_seq` 和 `wait_ms` 继续读取，直到出现 `turn_started`、明确启动失败或终态；不要忙轮询。
2. 在 `turn_started` 后、等待模型输出前，先向用户报告：Codex 项目根目录、实际执行目录、ZCode session ID、runtime 实际报告的 provider/model、runtime 实际报告的思考档位和执行模式。思考档位从 `session_ready.details.reasoning_level` 或 `model_selected.details.reasoning_level` 读取；若只有 `requested_reasoning_level`，说明这是请求值而不是 runtime 确认值；两者都没有时明确说 runtime 未报告档位，不要用模型目录的默认档位冒充当前档位。模式来自 Bridge 配置，默认 `yolo`；若为 `yolo`，明确提醒普通工具操作可能不经审批且使用当前 OS 账户权限，并说明可将 `ZCODE_BRIDGE_MODE` 设为 `build`。若使用 worktree，说明它不是 OS 沙箱。模型字段缺失时明确说 runtime 没有报告；不要把用户请求的模型或项目默认值猜成实际已选模型。
3. 如果在 `turn_started` 前失败，立即报告 Bridge 的启动错误；只有在 `session_ready` 已出现时才能声称 ZCode session 已创建。不存在 `session_ready` 时说明没有 ZCode session/model 元数据。
4. 运行期间用 `zcode_events` 的 `after_seq` 读取增量事件，默认使用 `view: "summary"`，需要逐条文本时改用 `view: "raw"`；`next_seq` 会跨过已合并事件。`wait_ms` 可设为 10000–25000；如需只等待 Pending/终态/Attempt 变化且不被普通进度唤醒，传 `wait_for: "attention"` 并以返回的嵌套 `attention` 为决策事实。后台命令完成通知场景可运行 `dist/wait-task.mjs`，但完整请求和 Result 仍通过 MCP 读取。如需快速刷新状态，可调用 `zcode_status`。需要简洁、可直接呈现的当前 attempt 摘要时调用 `zcode_feedback`；其 `last_observed` activity 不是当前运行中的工具状态，`interaction: not_observed` 也不代表没有交互。心跳只证明 worker 响应，工具事件只证明已观测活动；没有命令输出或结果时，不把它们描述成测试持续推进、已通过或源码已还原。`stalled` 是提示，不自动取消或重派。短时间内没有新事件时，先检查业务事件、执行目录的文件变化、待处理交互、心跳和进程身份，再判断是否真的卡住；不要因为一次静默就取消并重派。向用户简短汇报模型可见输出和工具活动摘要。事件不包含隐藏推理；`interaction_requested` 会包含完成决定所需的有限请求细节。
5. 收到 `interaction_requested` 时，从 `details.method` 和 `details.params` 读取 SQLite 持久请求，向用户概述方法、工具、理由、输入、选项或问题。需要逐项输入时读取 `zcode_events` 的 `view: "raw"`；当前链路不使用旧 JSON `full_request` 文件。若事件因 `max_bytes` 被省略或 `scan_incomplete`，调整读取预算后继续读取同一请求，内容不全时不得放行。只有用户明确授权该项操作才可用 `zcode_interaction_reply` 的 `allow`；worktree 或 `yolo` 模式本身不构成授权。Bridge 在回复时验证持久请求与原 Worker 通道身份，失败时保持未决并报告。用户输入只依据已知事实或用户明确回答；计划审批由用户决定。AskUserQuestion 的问题从 `details.params.questions`（若运行时嵌套工具输入则为 `details.params.input.questions`）读取，`answers` 以每个 `questions[].question` 完整原文为键，用户回答为值，不用 header 或选项标签替代。回复后继续观察，确认原任务继续或结束。
6. 任务终态后调用 `zcode_feedback` 获取标注来源的简洁原生文本，再按需调用 `zcode_result` 查看完整结果。completed 仅表示 Bridge/ZCode 执行和报告规范化完成，不代表代码审查通过；feedback 中的 Agent report 也不是 Bridge 独立验证。

遇到安装、运行时或 provider 配置问题时，先调用只读工具 `zcode_doctor`，根据每项状态诊断；它不会启动 ZCode session，`unknown` 不得描述成检查通过。

观测到终态或明确失败时，在验收、续作或接收前读取[审查与恢复](review-and-recovery.md)；涉及锁、清理或执行目录冲突时另读[运行时边界](runtime-boundaries.md)。额度耗尽和用户取消优先按入口立即停止，不等待其他流程。
