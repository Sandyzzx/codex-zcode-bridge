# ADR-039：Host 授权取消与清理证据分离

> Status: DECISION（2026-11-22 集成修订）
> Date: 2026-11-16；修订 2026-11-21、2026-11-22
> Decision: 用户要求修复 Host 明确授权取消被 `queued_cancel_launch_already_intended` / `operation_recovery_latched` 阻断的路径。2026-11-21 Owner 最终裁决：用户显式调用现有 `zcode_cancel({task_id})` 优先，可对历史阻塞 Attempt 执行行政释放；默认 Recovery 仍保持保守。本决定不授权生产数据库手改、自动清理或伪造 Cleanup Proof。
> Baseline: Preview.7 `ec5f3e83d737df469f9ed54361d2aec46b4a15a8`；2026-11-22 终态释放集成基于 Preview `ac1e8396f25a1a1d3ff373def84726d28c1f4193`

## 决定

1. `zcode_cancel({task_id})` 保持现有 Schema。当前 queued Attempt 即使已经持久化 Launch Intent，只要 Claim 尚未提交，也可在同一 SQLite 事务中记入取消 Result、取消事件及 Task/Attempt 投影。原 Launch 信息不删除；后续 Receipt/Claim 不能跨过取消投影。取消前后的 Claim 竞争由同一 Store CAS 仲裁。
2. 未创建 Operation 或 untouched reserved 的既有取消及预约释放保持不变。Launch Intent 后的取消使用 `observation_recorded` 记入 `cancelled_before_claim`，第一次取消保留原 phase 和占用；没有进程退出/资源证明时，取消成功不代表 Cleanup/Release 成功。用户随后重复显式调用同一 `zcode_cancel({task_id})`，视为对该历史 pre-Claim 阻塞的行政授权，可在同一 Authority 事务中把 Operation CAS 为 `released` 并追加 `observation_recorded(reason=user_authorized_release_unverified)`。该路径只允许 `launch_receipt_id`、`launch_receipt_digest` 和 `launch_identity_json` 均为空的历史 Launch Intent；只要存在任何持久 Spawn/Receipt 身份证据，Manager 与 Store 都拒绝行政释放。该事件只表示用户授权的未核实行政释放，不表示 `cleanup_verified`，不新增工具、force 参数或第二 Writer。
3. 已有永久 Claim 的取消继续要求精确 Worker 身份、持久取消 intent 和新鲜进程树核验。仅 `cleanup_identity_unknown` / `cleanup_incomplete` 的 Hold 可以由绑定该 Claim 的新鲜取消树证明消解；quarantine、未知 Hold、交互 reply outcome unknown 不属于该授权。
4. 消解使用追加的 `observation_recorded(cancel_recovery_resolved)`，绑定一条新鲜 `cancel_tree_verified` event、其 proof digest 和完整 Hold event digest 集合。新鲜 proof event 必须晚于它消解的每个 Hold；Store 重开时重新核对两者的事件 digest、顺序、Claim 与 Worker identity。不能仅凭旧 proof 或孤立哈希消解新 Hold。历史失败/Hold 保留，不能删除、改写或整体关闭 Recovery gate。随后继续原 Result、Cleanup、Release CAS，不创建 Attempt、Spawn、Prompt 或模型请求。
5. 同一 Authority 内同 Task 的并发取消合并为一个 Promise；跨 Host 仍由 Store revision/Claim CAS 仲裁。已有 Result 优先，不能覆盖正常 Result。
6. 已有 `completed`、`failed`、`waiting_for_master` 或 `cancelled` 终态 Result 且 Operation 停在 `cleanup_unverified` 的历史阻塞，可由用户显式重复 `zcode_cancel` 进入受控 Recovery。允许行政释放的必要条件是：绑定该 Claim 的精确 Worker 身份已确认 `exited`，recorded-root/claimant 进程树扫描为 clean 且无 live PID；此后仍无法取得 Adapter 的完整 resource closure，才允许追加 `user_authorized_release_unverified` 并 CAS 为 `released`。原 Result、Result digest、Task ID、Prompt、Cleanup 失败事件和既有事件保持不变，不伪造 `cleanup_verified`。`cleanup_identity_unknown` 或仅有 PID 缺失都不足以触发该分支。
7. 可识别的存活 Worker 仍必须先走现有取消/终止路径。若终止失败、post-stop 身份仍为 Unknown/Alive、存在 live descendant、tree probe 失败或无法完成 clean scan，本次调用不得虚报释放成功，也不得把该状态升级为 Cleanup Verified。行政释放仅限已经终止且树已关闭、但 Adapter resource closure 仍缺失的终态 Operation；不自动清理历史任务、不自动撤销用户代码、不创建新 Task ID。
8. 行政释放必须原子、幂等，并在释放后调用现有 Scheduler pump，使既有 queued Attempt 继续 Admission。成功证明必须同时包含 SQLite Operation `released` 投影与实际 Admission/派发结果，不能只依赖 `zcode_cancel` 返回值。`zcode_status` 与 Doctor 只读报告 queued Attempt 的阻塞原因、阻塞 Task/Operation、phase、Workspace、排队时长和阻塞时长；尤其不得遗漏 `launch_intent`。
9. 本修订与 ADR-045 Executor Lease 的单 Authority Writer 原则兼容：所有写入仍由当前唯一 Manager/Store 完成；CLI/Web/Doctor 不得打开第二可写 Authority。
10. `cleanup_unverified` 行政释放分两类持久绑定。原 `cancelled` Result 绑定 `cancel_id`、`cancellation_verification_digest` 与 `recovery_evidence_digest`；`completed`/`failed`/`waiting_for_master` 终态 Result 绑定原 `result_commit_ref`、`result_digest`、Claim 与 Worker identity digest，并用 `terminal-result-admin-release-v1` 的 canonical authorization digest 连接当前 `recovery_evidence_digest`。后者必须是当前 Operation revision 的 `cleanup_incomplete` Recovery event，带 `complete_cleanup_closure_unavailable`、`process_tree_root_observed=true`、`process_tree_scan_clean=true` 与 scan digest。Store 重开时重建同一 Recovery envelope 并重新校验，不得回退到较早的 eligible proof 绕过更新的 live Hold。相同绑定重复调用返回 durable duplicate；不同取消/Result、Recovery、Revision 或 phase 绑定 fail closed。
11. Recovery Observation 不再受固定 8 条限制。相同 Operation/Claim/phase 且材料事实未变化的重复 probe 只返回既有 Event 与持久 `evidence_digest`，不新增 Revision；`observed_at` 等动态字段不单独构成新事实。身份状态、probe 原因、进程/树证据或 phase 变化必须追加新事件。Cleanup/Cancel 消解超过 8 条 Hold 时使用完整事件集合的 count/root 承诺；旧 digest 数组继续可校验。ADR-039 必须使用 Store 返回的持久 Evidence Digest 绑定行政释放，不能依赖未持久化的新鲜 evidence hash。

## 验证边界

使用隔离 SQLite、合成/本地进程测试覆盖 Launch Intent / Receipt / Claim 竞争、取消重放、重开、Hold 消解、超过 8 条 Hold 的 count/root 承诺、重复材料事实去重、拒绝无证明/quarantine、Result 优先、无 Spawn 证据的 pre-Claim 行政释放、带 Receipt 的 pre-Claim 拒绝释放、四种终态 Result 的 `cleanup_unverified` 行政释放与原 Result 绑定、live descendant 与终止失败保持占用、并发重复取消幂等、释放后 queued Admission、SQLite 重开和只读 Doctor/Status 报告。生产历史任务不经用户明确授权不得修改；应用本地候选不等于已经修复已安装插件或完成生产任务取消。
