# 当前接口与兼容边界

> Status: AUTHORITATIVE
> Last updated: 2026-11-21（ADR-043 SQLite v14 ONLY）
> Last verified: 2026-11-21，核对 v14-only 支持声明、`unsupported_sqlite_schema` 拒绝边界、未完成 Marker 保留及现有 Task/Result/Recovery 合同。
> Verified against: ADR-043 candidate based on `c1245a02f8f9d4b6e1102eabac230b657d85de9b`
> ADR-039 Last verified: 2026-11-16，仅取消投影、CAS、清理 Hold 与并发取消定向隔离测试；基线 `ec5f3e83d737df469f9ed54361d2aec46b4a15a8` + 本地候选。生产取消未重试。
> ADR-047 Candidate: `zcode_result` 可选摘要与 `zcode_events` 归属。

准确字段以 `src/interfaces.ts`、`src/mcp/schemas.ts` 与共享 `src/result-contract.mjs` 为准。[ARCHITECTURE.md](ARCHITECTURE.md) 描述实现，[SHARED_CORE.md](SHARED_CORE.md) 列出 Core API 主版本兼容策略。ADR-038 保留 13 个默认 MCP 工具、SQLite v14、32 MiB Result 与现有 Task 状态语义。

## MCP 与任务

默认工具：zcode_task、zcode_status、zcode_feedback、zcode_result、zcode_continue、zcode_cancel、zcode_events、zcode_interaction_reply、zcode_doctor、zcode_model_catalog、zcode_default_model、zcode_set_default_model、zcode_clear_default_model。实验 progress probe 已退役；生产 Worker 只提供上述冻结工具面。

TaskPackage 的 requirements、allowed_paths、forbidden_paths、acceptance_criteria、test_commands 必须存在，可为空。workspace 为绝对项目路径；可选 worktree_path 为 Host 已准备的执行目录，Bridge 不创建/删除 worktree。task_id 最长 64 字符，仅字母数字、下划线和连字符。输入约束和路径列表是 Worker 指令，不是 OS 沙箱。

相同 task_id 和相同内容可重放原回执，不同内容返回 TASK_ID_CONFLICT。Continuation 的 operation_id 同样绑定规范化请求；相同 key/内容重放，不同内容冲突。未知执行结果必须查询原 task_id，不能换 ID 重派。

公开状态为 queued/running/completed/failed/cancelled/waiting_for_master；后四者结束当前 Attempt。completed 只表示执行及报告归一化结束，不表示 Owner 验收。Continue 接受完成、失败或待主机决定且已 Release 的前序 Attempt，保持 task ID 并创建新 Attempt；永久 Claim 不重放。

## Authority 与 Recovery

生产只有 SQLite Authority，支持声明为 `SQLite v14 ONLY`。新装与旧 JSON 安装从相同 Fresh SQLite Bootstrap 开始；旧 `.tasks` 不参与选择、恢复或新任务。已有 v14 的 `json_artifacts`、迁移 Result/Event 行、digest 与 receipt 继续按 Schema 校验并保留原始字节，但旧 JSON 迁移 Task 不再是 Bridge 支持的查询业务对象。已有 v13 数据库或 v13→v14 未完成 Marker 以 `unsupported_sqlite_schema` 非破坏性拒绝，不提供升级、恢复或回滚；损坏/不完整 SQLite 继续明确拒绝，不回退 JSON，不重置数据库。

Admission 在事务中检查 Capacity 及执行路径重叠，覆盖跨 Manager 竞争。Worker 精确身份、Launch token/receipt、Claim、Attempt/generation/revision CAS 保持绑定。最终 workspace use 校验先于 Launch Intent；拒绝只留下 untouched reserved，显式 queued Cancel 经原 CAS 终结并释放。Intent 后即可能已 Spawn，缺 Receipt/句柄、timeout 或 Manager 崩溃都不授权重新派发。

[ADR-039](decisions/ADR-039-host-authorized-cancellation.md)：Host 已授权的 queued Cancel 也覆盖尚无 Claim 的 Launch Intent。取消 Result、投影与 `cancelled_before_claim` 事件原子持久化，后续 Receipt/Claim 被拒绝；原启动证据、Operation phase 和占用保留。返回 `cancelled` 与 `execution_observation.state=cleanup_held`，原因 `cancelled_before_claim_cleanup_unverified`，不伪造 Cleanup 或 Release。重复取消重放原状态，不启动新 Attempt。

Manager 可在启动和 Host 存活期间重复核对 running Operation。ADR-036 的原子 Store 操作只在精确原身份已退出、recorded-tree clean、Adapter Cleanup 证明完整、没有 Runtime 执行事件、无未回答交互且没有另一个 Host 的存活句柄时创建一个同 Task ID 的新 Attempt。该成功链当前只有 `testOnlyFakeAdapter` 合成覆盖；生产 Adapter 没有可消费的独立 Cleanup Proof，因此真实 Result-less Running Attempt 默认保留 Operation/Workspace Hold，`zcode_status.execution_observation.state=interrupted_without_result` 且审计原因为 `adapter_cleanup_unverified`。Runtime 执行事件表示 Workspace、Git、迁移或外部调用副作用不可由 SQLite 重建；unknown、alive、脏树、未解决交互或缺少执行副作用边界同样保留 Hold。显式 zcode_cancel 仍复用持久 Claim、取消 intent 与 CAS；已有 Result 时只恢复 Cleanup，不覆盖 Result。

已有终态 Result 的 cleanup_unverified 可通过 zcode_cancel 仅清理恢复，不创建 Attempt 或覆盖 Result。存活的原精确世代可由显式取消触发身份绑定终止；退出仍需 claimant scan。Result 与取消竞争由 SQLite CAS 仲裁；重复取消/恢复不重复 Spawn 或 Release。数据库根损坏或一致性无法解释时继续 fail closed。未知 Hold 不自动清除。

Running 取消遇到 `cleanup_identity_unknown` / `cleanup_incomplete` Hold 时，可由新鲜的精确身份和进程树证明追加 `cancel_recovery_resolved`，绑定原取消核验及所消解的全部 Hold event digests，再继续原 Result/Cleanup/Release CAS。历史 Hold 不删除；quarantine、其他原因和未知 reply outcome 仍拒绝。同一 Host 同任务的并发取消合并执行；跨 Host 保持原 CAS。终态 Result 后中断的 cleanup 可由再次取消继续，不能覆盖已提交 Result。

## Result 与期限

[ADR-026](decisions/ADR-026-sqlite-result-contract.md)：完整 canonical TaskResult 最大 **33,554,432 UTF-8 字节**；Worker envelope 另留 **262,144 字节**，换行分隔符另计 1 字节。容量按实际 canonical JSON 序列化计，不按字符数。报告文本/数组使用统一语义；身份和元数据仍有既有界限。

[ADR-047](decisions/ADR-047-compatible-result-summary.md)：`zcode_result({task_id})` 和 `view: "full"` 返回同一完整 Result。`view: "summary"` 对不超过 2 KiB 的 JSON 直接返回原结果。更大的结果包含 `projection.omitted_fields` 和全部测试声明的 `projection.test_counts`。用 `view: "full", expected_attempt: <摘要的 attempt>` 读取缺失字段及原文。`expected_attempt` 只核对当前已提交 Result，其他 Attempt 返回 `TASK_STATE`，未提交返回 `TASK_NOT_FINISHED`。Cleanup、Hold 和 Release 通过 Status/Events 核对。

AgentReport 必须包含布尔 needs_master_decision，不补造缺失字段。非法或超限报告形成明确的基础设施失败 Result（invalid_result_payload/result_too_large），标明原报告未提交，不裁剪为成功，不重派。完整合法帧先落 SQLite，再验证 Worker close/树/资源；已提交 Result 不因晚退出被丢弃。

确定未提交的 Store/管道错误记录 operation-scoped 诊断并保留 running/占用；无法写诊断时输出 SQLITE_RESULT_SUBMISSION_FAILED。COMMIT ACK 不确定保留 poison/WRITER_INTENT，输出只读对账，禁止替代 Result、自动 Cleanup/重试。升级操作与回滚规则见 [运行配置](ZCODE_RUNTIME.md)。

[ADR-027](decisions/ADR-027-execution-and-cleanup-deadlines.md)：Manager 一次选择 Task override > Host 持久配置/环境 > 1h，范围 60s–4h。私有 Task 副本传同一预算给 Worker/Adapter，不改公开持久 Task。resolver/启动/turn 共用执行期限，终结/错误/取消即撤销 timer；清理独立 300s，迟到确认不自动升级已发布 unverified。

Claim 后执行 envelope 写入 15s；Result 等待 execution + 330s；提交后 close/interaction drain 共用 15s，精确身份 probe 继续 5s。Host shutdown 独立 60s。超时只说明该阶段未完成，不授权重派/释放。现有 1,100,000-byte continuation 输入限制保持；当前 Native Host 不能完整接收最大 Result 的已知限制延后，不改变存储容量或新增 Chunk API。

## Events、Attention 与反馈

zcode_events 接受单调 cursor、limit 1–200、wait_ms 0–25,000、raw/summary 与既有 scan_cursor/max_bytes。summary 只合并同 Attempt、同 Operation、无 evidence 的相邻 `model_output` 文本行；Permission、Interaction、错误、终态、其他事件类型和 Attempt 都是边界。`next_seq` 指向最后扫描到的合并行所在的 neutral public cursor，`omitted_events` 给出合并数量；`max_bytes` 在 summary 合并后仍由 canonical JSON 字节数约束，超限时返回 `scan_incomplete` 和可继续的 cursor。raw 保持逐行读取，attention 等待后仍按普通 cursor 读取一次。

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
