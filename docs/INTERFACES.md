# 当前接口与兼容边界

> Status: AUTHORITATIVE
> Last updated: 2026-11-04
<<<<<<< HEAD
> Last verified: 2026-11-04，核对 Operation scoped Hold、`zcode_cancel` 参数/返回和 Provider 未接受证据边界（Windows Node `v24.16.0` 完整套件 818 项中 816 通过、0 失败、2 跳过；独立 Reviewer 对合同闭合为 PARTIAL，见[简化报告](reports/sqlite-hold-simplification-2026-11-04.md)）；同日核对 SQLite Attention Core、`zcode_events` Attention 扩展、只读 Thin Waiter、MCP schema 与默认事件 cursor（真实 Claude 与 Marketplace Host E2E 状态见 M2 集成报告）。
> Verified against: 77dd5f14 + sqlite-hold-simplify-20261104 候选（ADR-024 scoped Hold）+ Attention 集成候选 2205654b；整合 Worktree 重核交叉点后以整合提交为准。
=======
> Last verified: 2026-11-04，核对 SQLite Attention Core、`zcode_events` Attention 扩展、只读 Thin Waiter、MCP schema 与默认事件 cursor；真实 Claude Code 与 Marketplace Host E2E 未在本轮完成。
> Verified against: 77dd5f14ee61701ac15872192429ecd4f53e1323 + 本 Worktree Attention 集成候选
>>>>>>> 43b41579 (feat: unify attention waiting with thin waiter)

准确类型与 schema 以 `src/interfaces.ts` 和 `src/mcp/schemas.ts` 为准。核心公共入口见 [SHARED_CORE.md](SHARED_CORE.md)。历史源码注释中的 V0.1/FROZEN 是沿革说明，不代表当前新增功能已经冻结。

ADR-026（Owner 已批准）：SQLite v14 的 TaskResult 上限为 **33,554,432 个 canonical JSON UTF-8 字节**，不是字符数；Worker Result envelope 另限 262,144 字节，私有帧上限为两者之和，换行分隔符另计 1 字节。AgentReport/TaskResult 报告正文、issues、tests command/details 和 files_changed 允许合法 JSON Unicode/多行文本及超过 256 项；身份、Claim/CAS 和执行元数据仍使用原合同。`src/result-contract.mjs` 统一报告语义、序列化和容量定义，SQL CHECK 使用同一 UTF-8 字节门槛。

已执行的报告如果确定违反类型/容量合同，Worker 将其转换为独立的基础设施 `failed` Result：`error_code` 为 `invalid_result_payload` 或 `result_too_large`，summary 明确原报告未提交，超限报告带实际 canonical 字节数。该失败不是对原报告裁剪后的成功结果，不重派执行；清理仍要求原执行 proof 和 Manager 的精确身份验证。无法读取帧或确定未提交的 Store 错误以 operation-scoped `observation_recorded` 诊断及 `zcode_status.error_code/error` 暴露，保留 running/占用，使用现有 Recovery/经批准的行政路径处理；数据库无法写诊断时输出 `SQLITE_RESULT_SUBMISSION_FAILED`。COMMIT ACK 不确定则输出只读对账信息并保留 poison/WRITER_INTENT，不替换 Result、不自动清理或重试。Schema 升级是显式停机复制操作，见运行配置文档。

生产 Task Authority 为 SQLite。Marketplace 新装和无有效 SQLite 数据库的升级安装在 MCP 服务启动前执行相同 Fresh Bootstrap；旧 JSON `.tasks` 不参与 Authority 选择、恢复或新任务处理。Bootstrap 失败时拒绝服务，不回退 JSON；旧任务不会自动迁移或续接。该 OD 实现当前仍是未验收候选。

默认 MCP 工具：`zcode_task`、`zcode_status`、`zcode_feedback`、`zcode_result`、`zcode_continue`、`zcode_cancel`、`zcode_events`、`zcode_interaction_reply`、`zcode_doctor`、`zcode_model_catalog`、`zcode_default_model`、`zcode_set_default_model`、`zcode_clear_default_model`。实验 progress probe 需显式启用。

只读 Thin Waiter 位于插件制品 `dist/wait-task.mjs`，供不能复用 Host 内 stdio MCP 连接的后台等待器调用：

```text
node dist/wait-task.mjs --task <task_id> [--timeout-s S] [--poll-ms MS] [--data-dir ABS_SQLITE_STATE_DIR]
```

`zcode_events` 增加严格可选 `wait_for: "attention"`；不传该字段时输入、输出、事件 cursor、raw/summary 和普通长轮询保持不变。Attention 模式只由 SQLite 单事务 snapshot 判断当前 Attempt Pending、终态或 Attempt 变化；普通事件和 queued→running 进度不提前唤醒。轮询不读取或推进 `after_seq`/`scan_cursor`，返回时按原始 cursor 读取一次普通事件页，顶层 `status` 镜像嵌套 `attention.status`。读取失败、Task 不存在或 reply ACK 不确定时显式失败，不返回伪造空 Pending。JSON 内存 Authority 不支持 Attention；生产 SQLite-only 配置缺库时 Thin Waiter 显式失败，不回退 `.tasks` JSON。Waiter 使用正常 SQLite 只读连接，不使用 `immutable=1`，可观察启动后新建 WAL 与提交；业务数据库和 WAL 内容不得改变，SQLite 一致读所需的 SHM 内部变化/空 sidecar 是允许的只读副作用。输出 schema 为 `zcode-bridge/wait-task-v2`，退出码 `0` 表示 Pending/终态/Attempt 变化，`3` 超时，`2` 参数、配置、SQLite 或读取错误。

TaskPackage 的五个数组必须存在，可为空。workspace 是绝对项目路径；worktree_path 是宿主已准备的执行目录。Bridge 不创建或删除 worktree。task_id 只能是最多 64 字符的字母数字、下划线和连字符。单 attempt timeout 范围 60,000–14,400,000 ms。

单用户本机 SQLite Host 的受信任执行档案使用 `yolo`，与 JSON 默认路径一样自动放行工作区内的普通读取、编辑、构建、测试和任务范围内清理。配置文件 `trusted-local-policy.json`、`workspace_roots` 和项目登记不是使用前提。Post-Claim Worker 仍须通过精确 Host policy snapshot、Workspace、Claim 和进程身份握手；TaskPackage、prompt 或 Skill 不能自行产生或提升该授权。Push、Merge、Tag、Release、生产 Authority 切换、任务范围外删除、凭据修改和真实生产任务数据操作保留为用户决策。

SQLite startup Recovery 与调度按 Operation 和执行路径隔离。精确 `alive` 或临时 `unknown` Worker 不转移执行权，也不释放其 Claim/Capacity；同一路径及重叠路径保持占用并排队，其他路径可继续派发。数据库根损坏或一致性无法解释时仍 fail closed。客户端不得把一次 transient Manager fence 当成 Worker 已退出、任务已取消或资源已释放。

执行路径在 SQLite Admission 事务中按活动 Operation 检查，覆盖不同 Bridge Manager 同时尝试同一或重叠目录的竞态。输掉 Admission 的 Attempt 保持 `queued`，不 Spawn；路径释放后由调度器重新尝试。此约束不改变公开 Task 状态或 MCP schema。

`failed` Task 对应 `cleanup_unverified` Operation 时，`zcode_cancel` 可执行仅验证清理的恢复：不重放 prompt、不创建 Attempt、不覆盖失败 Result。显式 cancel 可以对仍存活的原 Worker 使用已记录的精确 PID/start fingerprint 调用身份绑定终止，并重新 probe。仅当原身份已退出、recorded-tree claimant scan clean、无未解决 interaction 且 Operation revision CAS 成功时，才记录本次新 cleanup evidence 并释放容量。未知、仍存活、证据扫描失败或并发 CAS 竞争都保留该执行路径占用。启动 Recovery 不终止存活 Worker。历史 cleanup failure 与 Attempt 事件保持可审计。

当前 app-server 不提供可验证的 Provider 未接受标记；`turn.failed` 中的 `retryable` 或 `attribution.statusCode` 单独不足以证明请求未被接受。因此 HTTP 429、5xx、网络超时、连接重置和 DNS 错误均不自动重发，避免重复执行。若未来协议提供可信的未接受证据，才可在同一 Worker/Attempt 内有限重试，并遵守有界 `Retry-After`；已观察 `turn.started` 后始终不重试。401/403、额度不足、无效请求和其他错误以普通失败 Result 通知 Master。模型请求失败本身不设置全局 Hold；清理失败单独决定原执行路径是否仍被占用。

任务状态为 queued/running/completed/failed/cancelled/waiting_for_master。后四种结束当前 attempt；completed 表示执行及报告解析完成，宿主仍独立验收。续跑只接受 completed/failed/waiting_for_master，且清理必须已验证；保留同 task ID、执行目录和旧 attempt 证据。

AgentReport 必须包含布尔型 needs_master_decision；缺失或字符串值仍返回 invalid_agent_report，不静默合成。该错误的显式续作使用仅修复报告的 prompt，携带 candidate 与有界原始响应，不重发原实现任务或测试命令，禁止模型编辑或重跑。Bridge 不自动增加修复 turn；禁止工具操作是 prompt 约束，不是 OS 沙箱。心跳而无业务事件时 observation.activity 为 starting（启动宽限内）或 unknown，不声称业务执行。固定反馈模板区分原 attempt 的 cleanup_failed 与后续 cleanup=verified；未确认清理标为未验证，不能写成 NOT RUN。决策见 ADR-005。

任务 objective、requirements、路径、验收、测试命令及续跑 feedback 不截断；完整 prompt 超过 60,000 字符会返回 TASK_INVALID。参考 context 与旧结果摘要仍有明确的截断标记，不能把安全约束只放在参考 context。

zcode_events 默认模式使用单调 seq cursor、limit 1–200、wait_ms 0–25,000、raw/summary view。summary 合并可见输出时会注明压缩。公开事件只包含可见文本、工具名称与状态，以及有限的生命周期 metadata；隐藏 reasoning 和未知 usage metadata 不进入公开事件。`turn.failed` 只投影 Bridge 稳定错误码，不转发 provider 原始 RPC error；明确额度耗尽显示为 `zcode_usage_exhausted`，未识别原因仍显示为 `zcode_nonzero_exit`。订阅前记录 `snapshot.runtime.eventSeq`。live 订阅连续 10 秒没有新事件时，每 5 秒按已观测序号向 `session/events` 补拉一次，重放仍经过同样的 session、单调 runtime seq 和 turn ID 过滤；runtime 明确拒绝该方法时降级为纯 live 订阅，连续 3 次失败后同样降级，两种情况都会发出可见的 `session_event_replay_unavailable` 事件。协议变化不能只靠字符串方法名推断支持。`session/read` 未接入，原生当前状态查询仍为 NOT RUN。运行时事件先核对 session、单调 runtime seq 和可用 turn ID；存在历史事件的 session 必须观察新 turn.started 后才接受结束事件。缺少某些身份字段的旧协议仍有兼容路径，真实跨版本行为未全部验证。

`zcode_feedback` 是独立的 `TaskFeedbackSnapshotV01` v0.1 聚合层，含 `schema_version: "0.1"`，并返回结构化 snapshot 与简洁文本。它不替代 `zcode_events`，也不改变 `TaskResult`、状态接口或已持久化记录。字段来源分为 Bridge task state（task、attempt、status、起止时间和墙钟 duration）、runtime-observed（只接受当前 attempt 规范化 `model_selected`、`model_tool_call`、`tool_status` 事件中的 allowlisted 字段）和 Agent report（仅当前 attempt 出现 `report_ready`、结果 attempt/status 匹配且结果为 `completed` 或 `waiting_for_master` 时，标记 `source: "agent_report"`）。模型不从请求或 catalog 回退；runtime model 缺失时为 `null`。`phase` 与 `progress` 固定为 `null`。activity 使用 Bridge 持久化事件时生成的 observation timestamp，语义固定为 `last_observed`；不表达工具仍在运行。交互状态固定为 `not_observed`，表示 snapshot 未确立可靠的当前交互状态，不表示历史中没有交互或没有待处理请求；原始交互事件仍由 `zcode_events` 提供。该 snapshot 不包含 runtime turn outcome 或 Bridge failure reason 字段，因此文本只显示可由 Bridge status 支持的完成/失败状态，不推断 turn 成功、目标完成或主机验收。Agent 报告中的 summary、文件、tests 与 issues 均不是 Bridge 独立验证结果。

zcode_interaction_reply 必须引用当前 attempt 的 interaction_requested.request_id，不能复用旧 ID。permission 只接受 allow/deny；user input 接受 accept/decline，answers 以完整问题文本为键。工具 schema 与 TaskManager 校验回答长度、支持的问题和允许选项。任务约束与路径声明不是 OS 权限控制。

大审批输入事件与完整性边界（ADR-008）：审批 params 完整私有保存至 1 MiB UTF-8 bytes（计量单位是 `JSON.stringify(params)` 的紧凑序列化，不是整个 JSON 记录文件）。单事件行仍守 64,000 bytes：小请求保持既有完整字段形状；超限请求发布为 `preview: true` 的有界预览（`input_preview`、`input_bytes`、可选 `questions_preview`/`options_preview`），并附 `full_request` 引用（同任务/attempt 私有记录的 `file` 路径、`bytes`、`sha256`）。`bytes`/`sha256` 对应上述序列化 params，宿主复核时用同一单位，且预览不是全文，需要全文必须读引用记录。allow/accept 在 interaction 锁内校验记录与字节/哈希一致后落盘：完全无新元数据且 <=旧 32,000-byte 上限的记录按 legacy 兼容；缺/错类型元数据、不匹配、或验证时超过 1 MiB 的一律返回 TASK_STATE 且不记为已授权。等待中记录消失、损坏或与最初请求不一致时 worker 明确 decline（`interaction_request_undeliverable` 事件，`interaction_record_missing`/`interaction_record_unreadable`/`interaction_record_mismatch`），不悬挂轮询。超过 1 MiB 的请求以 `interaction_request_oversized` 事件（actual/limit）明确拒绝并建议拆分输入。SHA256/bytes 是损坏与意外改动的核对手段，不是对同 OS 账户恶意篡改的安全隔离。

协议帧边界（ADR-008）：app-server stdout 的完整 JSON-RPC 帧按换行逐条消费，单帧上限 16 MiB 原始未 trim 的 UTF-8 字节；帧顶层必须是 JSON 对象。越限、坏 JSON 或非对象帧为致命协议错误（`protocol_error` 事件，含 error_code 与安全大小字段），锁存首个原因、结束全部 pending RPC 与 turn、阻止后续 request；模型文本捕获保持独立的 2,000,000 字符上限与截断标志。该行为不改变任何 MCP 工具名与 schema。

稳定错误包括 TASK_INVALID、TASK_ALREADY_EXISTS、TASK_ID_CONFLICT、CONTINUE_OPERATION_CONFLICT、BRIDGE_BUSY、REQUEST_QUEUE_TIMEOUT、TASK_NOT_FOUND、TASK_NOT_FINISHED、TASK_STATE、CANCEL_FAILED，以及 runtime/provider、timeout、invalid_agent_report 等执行错误。明确匹配到 ZCode provider 用量额度耗尽错误时，任务保留 `failed` 语义并使用 `error_code: "zcode_usage_exhausted"`；仅当 runtime 错误字段含明确 quota/usage exhaustion 标记才使用该码，HTTP 429、一般限流和未知错误仍为 `zcode_nonzero_exit`。该错误结果说明当前执行已中断，Codex 应立即停止当前任务并告知用户，不继续工作、不自动重试或续作，并等待用户确认额度恢复。相同 task_id 与相同任务内容会重放首次回执；不同内容返回 TASK_ID_CONFLICT。超时后使用原 task_id 查询或重试，不要换 ID。续作可传 operation_id；相同 ID 与相同反馈会重放回执，不同反馈返回 CONTINUE_OPERATION_CONFLICT。cleanup_failed 表示运行时清理未验证，任务保持目录占用；再次 zcode_cancel 尝试清理后保留原执行结果。

公开进度 usage 仅保留数值 token/cost 字段，隐藏推理、未知 metadata 和原始 RPC error 不转发。审批需要的工具输入、任务 prompt、可见回答、私有本地日志仍属于可能含敏感内容的任务证据，使用者须按本地数据策略管理。

控制面、权威状态与补充观察的边界见 [ADR-004](decisions/ADR-004-separate-control-state-and-observation.md)：ZCode 本地 metadata、rollout 与日志可以进入补充观察，但不得单独决定任务状态、状态迁移或恢复结论；Desktop `tasks-index.sqlite` 是登记过的 best-effort 集成例外。

可选浏览器宿主（ADR-007）只新增反向 RPC，不改任何公开 MCP 工具名与 schema：app-server 的 `interaction/browserList` 回 `{ browsers: [] }`（关闭时的正确表达）或单个 cdp descriptor；`interaction/browserExecute` 回官方 BrowserCommandResult（含结构化 error、sideEffect none/uncertain 与 elapsedMs）。host 端参数解析保持身份字段（requestId/sessionId）必填、咨询字段（workspace/clientMode 等）可选并剥未知键；跨 session、workspacePath/workspaceKey 与绑定不符、turnId 冲突、重复在途 requestId、stale browserId/generation、非法命令分别得到拒绝或结构化错误，不再落入通用 Unsupported。浏览器事件仅含生命周期与错误码（browser_host_started/disabled/launch_failed/closed、browser_cleanup_unverified），不记录 URL、标题、页面内容、截图、auth 或 CDP endpoint。浏览器清理与 app-server 清理共同决定最终 cleanupVerified；任一未验证即保持 cleanup_failed 语义。桌面 IAB、Computer Use、录制、用户 tab 认领与子会话派生不在合同内，descriptor 以 apiSupportOverrides 如实隐藏。1.2.3修复版本已做限定live模型链路验收；本分支及跨app-server版本范围见审查说明。
