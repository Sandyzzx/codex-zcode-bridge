# 当前接口与兼容边界

> Status: AUTHORITATIVE
> Last updated: 2026-11-25（ADR-060 Continue Release 事实与 Executor 自动恢复）
> Last verified: 2026-11-25，核对真实 Store 在 3 条 Wake Observation 后用当前 revision Continue、真实 Thin MCP 在 Executor `SIGKILL` 后自动恢复并继续读取；Preview.17 完整 Host/CI 验证在集成阶段更新。
> Verified against: A-line candidate based on `6af69b55d7ecb660c2ad2c923888cf7f1e8886c8`
> ADR-039 Last verified: 2026-11-22，隔离 SQLite/MCP 覆盖 Receipt 保护、live descendant、活动 Worker、终止失败、completed/failed/waiting_for_master/cancelled 终态绑定、并发重复取消与 SQLite 历史校验；生产取消未重试。
> ADR-047/048: Accepted for Preview；默认 `zcode_result` 保持完整，Summary 仍为显式 opt-in。

准确字段以 `src/interfaces.ts`、`src/mcp/schemas.ts` 与共享 `src/result-contract.mjs` 为准。[ARCHITECTURE.md](ARCHITECTURE.md) 描述实现，[SHARED_CORE.md](SHARED_CORE.md) 列出 Core API 主版本兼容策略。ADR-038 保留 13 个默认 MCP 工具、SQLite v14、32 MiB Result 与现有 Task 状态语义。

## MCP 与任务

默认工具：zcode_task、zcode_status、zcode_feedback、zcode_result、zcode_continue、zcode_cancel、zcode_events、zcode_interaction_reply、zcode_doctor、zcode_model_catalog、zcode_default_model、zcode_set_default_model、zcode_clear_default_model。实验 progress probe 已退役；生产 Worker 只提供上述冻结工具面。

TaskPackage 的 requirements、allowed_paths、forbidden_paths、acceptance_criteria、test_commands 必须存在，可为空。workspace 为绝对项目路径；可选 worktree_path 为 Host 已准备的执行目录，Bridge 不创建/删除 worktree。task_id 最长 64 字符，仅字母数字、下划线和连字符。输入约束和路径列表是 Worker 指令，不是 OS 沙箱。

相同 task_id 和相同内容可重放原回执，不同内容返回 TASK_ID_CONFLICT。Continuation 的 operation_id 同样绑定规范化请求；相同 key/内容重放，不同内容冲突。未知执行结果必须查询原 task_id，不能换 ID 重派。

公开状态为 queued/running/completed/failed/cancelled/waiting_for_master；后四者结束当前 Attempt。completed 只表示执行及报告归一化结束，不表示 Owner 验收。Continue 接受完成、失败或待主机决定且已 Release 的前序 Attempt，保持 task ID 并创建新 Attempt；永久 Claim 不重放。Release 事实不会因后续 Wake `intent`/`queued`/`submission_unknown`/`turn_started`/`web_notify` Observation 失效；Continue 仍要求 Cleanup 已验证、没有活动 Worker 且 Workspace 可用，未知 Queue submission 与未核实 Turn 必须先按现有事实核对，不重复投递。

[ADR-059](decisions/ADR-059-owner-binding-and-installed-auto-wake.md)：Owner Thread 只来自 MCP handler 的 `ctx.mcpReq._meta.threadId`，不是 TaskPackage 输入；输入中出现 Owner 身份键返回 `TASK_INVALID`。Task、首个 Attempt 与 `task_owner_bindings` 在同一 SQLite 事务写入；Binding 为 `bound|unavailable`，缺失时 reason 为 `owner_thread_unavailable`，ZCode Runtime Session ID 不得替代。`zcode_task`/`zcode_continue` receipt 以可选 `owner_binding` 与 `console_link` 加性返回；`console_link.available=false` 不影响已受理 Task，`reason_code` 说明安全查询回退。

## Authority 与 Recovery

生产只有 SQLite Authority，支持声明为 `SQLite v14 ONLY`。新装与旧 JSON 安装从相同 Fresh SQLite Bootstrap 开始；旧 `.tasks` 不参与选择、恢复或新任务。已有 v14 的 `json_artifacts`、迁移 Result/Event 行、digest 与 receipt 继续按 Schema 校验并保留原始字节，但旧 JSON 迁移 Task 不再是 Bridge 支持的查询业务对象。已有 v13 数据库或 v13→v14 未完成 Marker 以 `unsupported_sqlite_schema` 非破坏性拒绝，不提供升级、恢复或回滚；损坏/不完整 SQLite 继续明确拒绝，不回退 JSON，不重置数据库。

[ADR-060](decisions/ADR-060-executor-crash-recovery-and-release-fact-continue.md)：Thin MCP 默认在下一次控制请求发现
Executor 不可用时触发一次自动恢复。已有健康 Executor 直接复用；旧 Owner
必须精确退出，且同一 Authority 没有活动/不可核实的 Worker 时才归档旧
Lease、启动并健康检查。恢复使用现有进程锁和 Spawn 入口，不新增 MCP 工具、
第二 Authority 或常驻 Supervisor。`ZCODE_BRIDGE_EXECUTOR_AUTO_RECOVER=0`
仅用于显式诊断/测试。恢复失败返回稳定诊断，不猜测 Lease 或 Worker 已退出。

Admission 在事务中检查 Capacity 及执行路径重叠，覆盖跨 Manager 竞争。Worker 精确身份、Launch token/receipt、Claim、Attempt/generation/revision CAS 保持绑定。最终 workspace use 校验先于 Launch Intent；拒绝只留下 untouched reserved，显式 queued Cancel 经原 CAS 终结并释放。Intent 后即可能已 Spawn，缺 Receipt/句柄、timeout 或 Manager 崩溃都不授权重新派发。

[ADR-039](decisions/ADR-039-host-authorized-cancellation.md)：Host 已授权的 queued Cancel 覆盖尚无 Claim 的 Launch Intent。首次取消 Result、投影与 `cancelled_before_claim` 事件原子持久化，后续 Receipt/Claim 被拒绝；原启动证据与未核实占用保留。用户重复调用现有 `zcode_cancel({task_id})` 表示显式行政授权，可把**没有任何持久 Launch Receipt/Identity 证据**的 pre-Claim 历史阻塞 CAS 为 `released`，并追加 `observation_recorded(reason=user_authorized_release_unverified)`。存在 `launch_receipt_id`、digest 或 identity 时 Manager 与 Store 都拒绝该路径。该事件不是 `cleanup_verified`，不新增工具、force 参数或第二 Writer；释放后调用现有 Scheduler 使已有 queued Attempt 继续 Admission。

Manager 可在启动和 Host 存活期间重复核对 running Operation。ADR-036 的原子 Store 操作只在精确原身份已退出、recorded-tree clean、Adapter Cleanup 证明完整、没有 Runtime 执行事件、无未回答交互且没有另一个 Host 的存活句柄时创建一个同 Task ID 的新 Attempt。该成功链当前只有 `testOnlyFakeAdapter` 合成覆盖；生产 Adapter 没有可消费的独立 Cleanup Proof，因此真实 Result-less Running Attempt 默认保留 Operation/Workspace Hold，`zcode_status.execution_observation.state=interrupted_without_result` 且审计原因为 `adapter_cleanup_unverified`。Runtime 执行事件表示 Workspace、Git、迁移或外部调用副作用不可由 SQLite 重建；unknown、alive、脏树、未解决交互或缺少执行副作用边界同样保留 Hold。显式 zcode_cancel 仍复用持久 Claim、取消 intent 与 CAS；已有 Result 时只恢复 Cleanup，不覆盖 Result。

已有 **completed**、**failed**、**waiting_for_master** 或 **cancelled** 终态 Result 的 `cleanup_unverified` 可通过同一 `zcode_cancel` 入口仅清理恢复，不创建 Attempt 或覆盖 Result，也不按 Result 类型要求第二次用户授权。存活的原精确世代可由显式取消触发身份绑定终止；行政释放只有在精确身份已 `exited`、recorded-tree/claimant scan 为 clean、无 live PID，且 Adapter resource closure 仍不可得时才允许。新 MCP 释放证据统一绑定原 Result commit/digest、Claim、Worker identity 与持久 Recovery evidence；Store 只保留旧 `cancelled` 取消证明的读取校验和幂等兼容，不形成第二个用户流程。live descendant、Unknown/Alive、stop failure、probe failure 或脏树继续保持容量与 Workspace 占用。Result 与取消竞争由 SQLite CAS 仲裁；同一 Manager 的并发重复取消合并执行并只追加一个行政释放事实，不重复 Spawn 或 Release。数据库根损坏或一致性无法解释时继续 fail closed。未知 Hold 不自动清除。

`zcode_status` 对 queued Attempt 可选返回 `dispatch_blocker`：`reason`、阻塞 `task_id`/`operation_id`、`phase`、`workspace`、`queued_duration_ms` 和 `blocked_duration_ms`。执行路径与当前 Workspace 重叠时 `reason=workspace_occupied`；只有占用 Operation 数达到配置 Capacity 上限且没有同路径阻塞时才是 `capacity_occupied`。该字段是只读诊断，不是重派命令；`launch_intent` 必须显式出现在 phase 中。`zcode_status` 与 `zcode_cancel` 的 output Schema 以可选字段加性包含同一 blocker；既有调用和默认响应形状不变，但校验固定 Schema 哈希的静态消费者必须刷新目录。Doctor 的 `active_tasks` 摘要同样报告阻塞 Task/Operation/phase/Workspace。`zcode_cancel` 的行政释放成功只以 SQLite `released` 投影和 Capacity/Workspace 占用解除为准；queued successor 的实际 Admission/派发由异步 Scheduler 决定，必须随后用 Status/Doctor 或实际 Admission 证据核对，不得从取消响应推断。`cleanup_state=unverified_admin_release` 与事件 reason `user_authorized_release_unverified` 表示用户授权但未核实清理，不得写成已验证 Cleanup。

Running 取消遇到 `cleanup_identity_unknown` / `cleanup_incomplete` Hold 时，可由新鲜的精确身份和进程树证明追加 `cancel_recovery_resolved`，绑定原取消核验及所消解的全部 Hold event digests，再继续原 Result/Cleanup/Release CAS。历史 Hold 不删除；quarantine、其他原因和未知 reply outcome 仍拒绝。同一 Host 同任务的并发取消合并执行；跨 Host 保持原 CAS。终态 Result 后中断的 cleanup 可由再次取消继续，不能覆盖已提交 Result。

## Result 与期限

[ADR-026](decisions/ADR-026-sqlite-result-contract.md)：完整 canonical TaskResult 最大 **33,554,432 UTF-8 字节**；Worker envelope 另留 **262,144 字节**，换行分隔符另计 1 字节。容量按实际 canonical JSON 序列化计，不按字符数。报告文本/数组使用统一语义；身份和元数据仍有既有界限。

[ADR-047](decisions/ADR-047-compatible-result-summary.md)：`zcode_result({task_id})` 和 `view: "full"` 返回同一完整 Result。`view: "summary"` 对不超过 2 KiB 的 JSON 直接返回原结果。更大的结果包含 `projection.omitted_fields` 和全部测试声明的 `projection.test_counts`。用 `view: "full", expected_attempt: <摘要的 attempt>` 读取缺失字段及原文。`expected_attempt` 只核对当前已提交 Result，其他 Attempt 返回 `TASK_STATE`，未提交返回 `TASK_NOT_FINISHED`。Cleanup、Hold 和 Release 通过 Status/Events 核对。

安装版 Codex Host/AppServer 的 MCP 单行上限为 **16,777,216 bytes**。超过该边界的 Result 仍完整持久化在 SQLite；[ADR-056](decisions/ADR-056-result-readback-contract.md) 起，`zcode_result` 提供可选 `offset_bytes`+`max_bytes`（成对提供，1,024–4,194,304 字节）分页读取存储的 canonical JSON：响应为 `{core identity, result_digest, page:{offset_bytes,next_offset,total_bytes,data}}`，`next_offset` 保证 UTF-8 码点边界，拼接全部 `data` 的 SHA-256 等于 `result_digest`。大 Result 由此可完整恢复；`okResult` 文本通道超过 1 MiB 时改为有界引用，structuredContent 仍为权威载荷。不能把摘要或本地数据库存在误报为已取齐完整证据。

AgentReport 必须包含布尔 needs_master_decision，不补造缺失字段。非法或超限报告形成明确的基础设施失败 Result（invalid_result_payload/result_too_large），标明原报告未提交，不裁剪为成功，不重派。完整合法帧先落 SQLite，再验证 Worker close/树/资源；已提交 Result 不因晚退出被丢弃。

确定未提交的 Store/管道错误记录 operation-scoped 诊断并保留 running/占用；无法写诊断时输出 SQLITE_RESULT_SUBMISSION_FAILED。COMMIT ACK 不确定保留 poison/WRITER_INTENT，输出只读对账，禁止替代 Result、自动 Cleanup/重试。升级操作与回滚规则见 [运行配置](ZCODE_RUNTIME.md)。

[ADR-027](decisions/ADR-027-execution-and-cleanup-deadlines.md)：Manager 一次选择 Task override > Host 持久配置/环境 > 1h，范围 60s–4h。私有 Task 副本传同一预算给 Worker/Adapter，不改公开持久 Task。resolver/启动/turn 共用执行期限，终结/错误/取消即撤销 timer；清理独立 300s，迟到确认不自动升级已发布 unverified。

Claim 后执行 envelope 写入 15s；Result 等待 execution + 330s；提交后 close/interaction drain 共用 15s，精确身份 probe 继续 5s。Host shutdown 独立 60s。超时只说明该阶段未完成，不授权重派/释放。现有 1,100,000-byte continuation 输入限制保持；当前 Native Host 不能完整接收最大 Result 的已知限制延后，不改变存储容量或新增 Chunk API。

## Events、Attention 与反馈

zcode_events 接受单调 cursor、limit 1–200、wait_ms 0–25,000、raw/summary 与既有 scan_cursor/max_bytes。summary 只合并同 Attempt、同 Operation、无 evidence 的相邻 `model_output` 文本行；Permission、Interaction、错误、终态、其他事件类型和 Attempt 都是边界。`next_seq` 指向最后扫描到的合并行所在的 neutral public cursor，`omitted_events` 给出合并数量；`max_bytes` 在 summary 合并后仍由 canonical JSON 字节数约束，超限时返回 `scan_incomplete` 和可继续的 cursor。raw 保持逐行读取，attention 等待后仍按普通 cursor 读取一次。

[ADR-048](decisions/ADR-048-bounded-default-event-pages.md)：省略 `max_bytes` 时默认页预算为 32 KiB；`has_more` 或 `scan_incomplete` 为真时调用方必须继续读取。默认模式可返回一个超限 Event 以防 cursor 卡死，显式 `max_bytes` 仍是硬预算。默认预算不会删除、去重或隐藏 Permission、Interaction、错误、Hold、Cleanup、取消与终态 Event；完整持久历史仍可按 cursor 读取到结束。

[ADR-047](decisions/ADR-047-compatible-result-summary.md)：设 `include_attempt: true` 可在每条 SQLite Event 读取持久归属的 `attempt`。分页仍包含所读范围内的所有 Attempt，`max_bytes` 包含新增字段。默认或 `false` 保持原 Event 响应。`attention.attempt` 只标识 Attention 自身的 Attempt。

可选 wait_for="attention" 用 SQLite 单事务 snapshot 等待当前 Pending、终态或 Attempt 变化。普通事件不提前唤醒，等待中不推进事件 cursor；返回时按原 cursor 读取一次事件页，顶层 status 镜像 attention.status。无效 cursor 先拒绝；读取失败、Task 不存在或 reply ACK 不确定时明确失败，不能合成空 Pending。

只读 Thin Waiter：

```text
node dist/wait-task.mjs --task <task_id> [--timeout-s S] [--poll-ms MS] [--data-dir ABS_SQLITE_STATE_DIR]
```

它与 Manager 共用 validator/等待谓词，使用正常只读 SQLite 连接而非 immutable，可观察 WAL 新提交，不变更业务数据库/WAL。SQLite 自身所需的 SHM/空 sidecar 变化不算业务写入。输出 zcode-bridge/wait-task-v2；退出 0 为 Pending/终态/Attempt 变化，3 超时，2 参数/配置/读取错误。

zcode_feedback 保持默认工具名与 v0.1 snapshot，但只返回机器可读的简洁投影，不再生成固定人类 Markdown transcript。字段来源分 Bridge、runtime-observed、Agent report；只投影当前 Attempt 已持久化事件。缺 runtime model 为 null，不从请求/catalog 合成；Agent 声明不是 Bridge 独立验收；未知 usage 不估算，phase/progress 保持 null。`NormalizedUsage.cached_input_tokens` 映射官方 Cache Read；可选 `cached_write_input_tokens` 单独映射 Cache Write，缺失保持 null，真实 0 保持 0。source/scope/finality/conflicts 随 Result 保留。Doctor 只诊断绑定的 SQLite Authority，未绑定时报告 unknown，不扫描旧 JSON。

## Adapter、交互与隐私

唯一生产调用为 ZCode app-server。终结事件按 session、runtime seq 和可用 turn ID 绑定；历史会话必须观察当前 turn.started 才能接受终结。旧协议缺字段的既有兼容边界不在本轮重写。无新 live event 时按既有 session/events replay 路径补拉；不支持/持续失败会显式降级，session/read 仍未接入。

app-server stdout 单帧最大 16 MiB 原始 UTF-8（含空白），顶层须为对象；非法/越限帧锁存首个原因并结束 pending RPC/turn。可见文本捕获另限 2,000,000 字符，带截断标志。这与完整 TaskResult 存储上限是不同合同。

交互继续使用 SQLite 的 request digest、reply intent/prepared/committed/ACK；回答只对当前 Attempt 和原身份有效，ACK 不确定不重放。permission 接受 allow/deny；user input 接受 accept/decline，以问题全文为 answers key。SQLite 私有 request/frame 有现有 1 MiB 边界，回答和嵌套结构也有既有限额。旧 JSON 的 64KB 事件行、full_request 文件引用和 state.lock 审批协议已退役；它们不是 SQLite 接口的兼容承诺。

Provider 的 retryable/statusCode 不足以证明未接受请求；429、5xx、网络错误不自动重发。明确 quota/usage exhaustion 以 zcode_usage_exhausted 通知 Master 停止，等待用户确认恢复。报告错误的显式续作使用报告修复 prompt，不自动发送新 turn；prompt 约束不是 OS 隔离。

单用户 Windows 受信任 profile 使用 yolo。普通任务范围内读取/编辑/构建/测试可以自动执行；Push/Merge/Tag/Release、生产 Authority 切换、范围外删除、凭据或真实生产数据操作仍需相应授权。

公开事件和诊断不转发原始 RPC error、未知 metadata 或隐藏 reasoning。Task prompt、审批输入与可见回答可能含敏感内容，按本地策略管理。Bridge 不再写入或镜像官方 Desktop 私有 task index；Task Authority 始终是 Bridge SQLite，Desktop 独立任务列表可见性不是 Bridge 合同。浏览器默认关闭；独立 CDP profile 和 app-server 的清理共同决定 proof，身份/隐私合同见 [ADR-007](decisions/ADR-007-browser-host-rpc.md) 与 [ADR-009](decisions/ADR-009-windows-identity-bound-tree-termination.md)。
