# ADR-039：Host 授权取消与清理证据分离

> Status: DECISION
> Date: 2026-11-16
> Decision: 用户要求修复 Host 明确授权取消被 `queued_cancel_launch_already_intended` / `operation_recovery_latched` 阻断的路径。本决定限定该修复，不授权生产数据库手改或无证据释放。
> Baseline: Preview.7 `ec5f3e83d737df469f9ed54361d2aec46b4a15a8`

## 决定

1. `zcode_cancel({task_id})` 保持现有 Schema。当前 queued Attempt 即使已经持久化 Launch Intent，只要 Claim 尚未提交，也可在同一 SQLite 事务中记入取消 Result、取消事件及 Task/Attempt 投影。原 Launch 信息不删除；后续 Receipt/Claim 不能跨过取消投影。取消前后的 Claim 竞争由同一 Store CAS 仲裁。
2. 未创建 Operation 或 untouched reserved 的既有取消及预约释放保持不变。Launch Intent 后的取消使用 `observation_recorded` 记入 `cancelled_before_claim`，保留原 phase 和占用；没有进程退出/资源证明时，取消成功不代表 Cleanup/Release 成功。恢复、调度、查询和 Doctor 必须承认该区别，不自动重派。
3. 已有永久 Claim 的取消继续要求精确 Worker 身份、持久取消 intent 和新鲜进程树核验。仅 `cleanup_identity_unknown` / `cleanup_incomplete` 的 Hold 可以由绑定该 Claim 的新鲜取消树证明消解；quarantine、未知 Hold、交互 reply outcome unknown 不属于该授权。
4. 消解使用追加的 `observation_recorded(cancel_recovery_resolved)`，绑定原取消核验证据、新鲜 proof/tree digest 和完整 Hold event digest 集合。历史失败/Hold 保留，不能删除、改写或整体关闭 Recovery gate。随后继续原 Result、Cleanup、Release CAS，不创建 Attempt、Spawn、Prompt 或模型请求。
5. 同一 Authority 内同 Task 的并发取消合并为一个 Promise；跨 Host 仍由 Store revision/Claim CAS 仲裁。已有 Result 优先，不能覆盖正常 Result。

## 验证边界

使用隔离 SQLite、合成/本地进程测试覆盖 Launch Intent / Receipt / Claim 竞争、取消重放、重开、Hold 消解、拒绝无证明/quarantine、Result 优先和占用保留。生产五项任务只读取状态；应用本地候选不等于已经修复已安装插件或完成生产任务取消。
