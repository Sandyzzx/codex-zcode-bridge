# ADR-039：Host 授权取消与清理证据分离

> Status: DECISION（2026-11-21 Owner 最终裁决修订）
> Date: 2026-11-16；修订 2026-11-21
> Decision: 用户要求修复 Host 明确授权取消被 `queued_cancel_launch_already_intended` / `operation_recovery_latched` 阻断的路径。2026-11-21 Owner 最终裁决：用户显式调用现有 `zcode_cancel({task_id})` 优先，可对历史阻塞 Attempt 执行行政释放；默认 Recovery 仍保持保守。本决定不授权生产数据库手改、自动清理或伪造 Cleanup Proof。
> Baseline: Preview.7 `ec5f3e83d737df469f9ed54361d2aec46b4a15a8`；2026-11-21 修订基于 Preview.10 `a03ace1ca17e43c64256d8739220366f22eb4df6`

## 决定

1. `zcode_cancel({task_id})` 保持现有 Schema。当前 queued Attempt 即使已经持久化 Launch Intent，只要 Claim 尚未提交，也可在同一 SQLite 事务中记入取消 Result、取消事件及 Task/Attempt 投影。原 Launch 信息不删除；后续 Receipt/Claim 不能跨过取消投影。取消前后的 Claim 竞争由同一 Store CAS 仲裁。
2. 未创建 Operation 或 untouched reserved 的既有取消及预约释放保持不变。Launch Intent 后的取消使用 `observation_recorded` 记入 `cancelled_before_claim`，第一次取消保留原 phase 和占用；没有进程退出/资源证明时，取消成功不代表 Cleanup/Release 成功。用户随后重复显式调用同一 `zcode_cancel({task_id})`，视为对该历史 pre-Claim 阻塞的行政授权，可在同一 Authority 事务中把 Operation CAS 为 `released` 并追加 `observation_recorded(reason=user_authorized_release_unverified)`。该事件只表示用户授权的未核实行政释放，不表示 `cleanup_verified`，不新增工具、force 参数或第二 Writer。
3. 已有永久 Claim 的取消继续要求精确 Worker 身份、持久取消 intent 和新鲜进程树核验。仅 `cleanup_identity_unknown` / `cleanup_incomplete` 的 Hold 可以由绑定该 Claim 的新鲜取消树证明消解；quarantine、未知 Hold、交互 reply outcome unknown 不属于该授权。
4. 消解使用追加的 `observation_recorded(cancel_recovery_resolved)`，绑定一条新鲜 `cancel_tree_verified` event、其 proof digest 和完整 Hold event digest 集合。新鲜 proof event 必须晚于它消解的每个 Hold；Store 重开时重新核对两者的事件 digest、顺序、Claim 与 Worker identity。不能仅凭旧 proof 或孤立哈希消解新 Hold。历史失败/Hold 保留，不能删除、改写或整体关闭 Recovery gate。随后继续原 Result、Cleanup、Release CAS，不创建 Attempt、Spawn、Prompt 或模型请求。
5. 同一 Authority 内同 Task 的并发取消合并为一个 Promise；跨 Host 仍由 Store revision/Claim CAS 仲裁。已有 Result 优先，不能覆盖正常 Result。
6. 已有终态取消 Result 且 Operation 停在 `cleanup_unverified` 的历史阻塞，可由用户显式重复 `zcode_cancel` 进入行政释放：先复用现有身份绑定终止、Cleanup Recovery 和 Release CAS；只有仍然无法获得 Cleanup 证明时，才允许 `user_authorized_release_unverified` 直接释放。原 Result、Result digest、Task ID、Prompt 和既有事件保持不变，不伪造 `cleanup_verified`。
7. 可识别的存活 Worker 仍必须先走现有取消/终止路径。若终止失败或身份仍为 Unknown/Alive，本次调用不得虚报释放成功，也不得把该状态升级为 Cleanup Verified。行政释放仅限历史身份未知、证据缺失或已明确终态但清理未闭合的 Operation；不自动清理历史任务、不自动撤销用户代码、不创建新 Task ID。
8. 行政释放必须原子、幂等，并在释放后调用现有 Scheduler pump，使既有 queued Attempt 继续 Admission。成功证明必须同时包含 SQLite Operation `released` 投影与实际 Admission/派发结果，不能只依赖 `zcode_cancel` 返回值。`zcode_status` 与 Doctor 只读报告 queued Attempt 的阻塞原因、阻塞 Task/Operation、phase、Workspace、排队时长和阻塞时长；尤其不得遗漏 `launch_intent`。
9. 本修订与 ADR-045 Executor Lease 的单 Authority Writer 原则兼容：所有写入仍由当前唯一 Manager/Store 完成；CLI/Web/Doctor 不得打开第二可写 Authority。

## 验证边界

使用隔离 SQLite、合成/本地进程测试覆盖 Launch Intent / Receipt / Claim 竞争、取消重放、重开、Hold 消解、拒绝无证明/quarantine、Result 优先、pre-Claim 行政释放、终态 `cleanup_unverified` 行政释放、存活 Worker 不虚报释放、释放后 queued Admission、SQLite 重开和只读 Doctor/Status 报告。生产历史任务不经用户明确授权不得修改；应用本地候选不等于已经修复已安装插件或完成生产任务取消。
