# ADR-027：执行、清理与结果交付期限

> Status: DECISION
> Date: 2026-11-06
> Decision: Owner 已授权 R3 本地设计、实现和隔离验证；本记录明确该范围内的期限合同，不授权发布或生产迁移。
> Baseline: 904f45770f21a423ba683cd0a91d9b1dd5fca6b8

## 决策

Manager 在每次执行前使用现有 resolver 解析一次 task override / Host 持久化环境 / 1h 默认，保持 60s–4h。只在私有执行 envelope 的 Task 副本填入有效 timeout_ms，不改持久 Task、MCP schema、Result 32 MiB 或 SQLite v14。Worker 使用该快照，不重新选择默认期限。

Adapter 的执行计时器从执行初始化开始，包含 resolver、启动和 turn；正常终结或错误/取消确定后立即撤销。RPC、身份探针等局部期限仍保留各自职责，但不能让初始化无限等待执行取消。清理复用原来的 browser close、身份绑定树终止及 claimant scan，统一由 Adapter 的一个独立 **300s** 总预算约束，正常/失败共享同一路径，不额外增加执行 watchdog。该预算容纳现有 120s helper 会话及回退/扫描、browser close 等阶段；没有放宽底层身份验证或 helper 上限。耗尽只表示 cleanup unverified，不能表示树已消失。迟到清理不能回写已发布的 Result 或自动释放占用。

Claim 后私有执行 envelope 的写入单独限 **15s**，防止 Worker 不读 fd5 时无限背压；超时关闭本地发送通道，持久记录 `private_execution_delivery_timeout` 并保留原 Claim/Workspace，不推断未执行，也不重新派发。既有 1,100,000-byte 输入 envelope 上限保持不变。

Manager 的完整 Result 管道读取预算为 **有效执行时长 + 300s 清理 + 30s 交付余量**，不再封顶 1h。执行预算从 Adapter 开始，Manager 的等待从交付执行 envelope 后开始；交付余量覆盖 Worker 初始化及编码/管道差异，并非新的执行时间。没有完整帧则保留 R2 的持久提交失败诊断及 Claim/Workspace 占用，不重派、不伪造 Result、不把基础设施超时写成用户取消。

完整单帧 EOF、绑定/Claim/Result 合同通过后即可提交 Result；Worker 退出属于 Cleanup 的前置证据，不能作为丢弃合法 Result 的条件。提交后 Worker close 与 interaction pump drain 共用 **15s**，再用现有 **5s** 精确身份探针验证；未退出/非零退出/未知身份/缺 Adapter proof 都持久记录 cleanup_unverified 并保留占用。Result 已提交并不等于 Cleanup 或 Release。

Manager 的有界等待结束后，仍存活 Worker 的现有内存 handle 保留到实际 close，以支持显式身份绑定取消；不会继续无限 await interaction pump。Host 关闭只关闭本地观察通道和 Store，不将失去 IPC 当作清理成功。重启继续遵守现有 Recovery：活/未知不重派，已提交 Result 可按原身份/树证据做仅清理恢复；无 Result 的一般结案仍是 R5，不在本轮实现。

用户取消继续走既有持久 cancel intent、精确树终止、CAS 仲裁。Host shutdown 的独立等待预算不转成新的任务预算。保持“运行完成、Result 提交、Worker 退出、树清理、Workspace Release”相互独立的事实。

已提交终态 Result 的 cleanup_unverified 可通过既有 zcode_cancel 做仅清理恢复，范围从 failed 扩及 completed/cancelled/waiting_for_master：后置退出超时不应使成功报告失去清理入口。精确身份、原树 claimant scan、未解决交互和 CAS 门保持；不覆盖原 Result，不创建 Attempt。已 released 的重复请求返回原状态。无 Result 的一般恢复仍不在本决策内。

## 验证与回退

用受控时间验证 1h/4h、任务/环境优先级及 Manager 等待选择；真实 Windows 子进程验证超时、取消、慢/失败清理、已交付 Result 但 Worker 未退出、Manager 退出/重启和迟到确认。测试可通过内部 seam 缩短固定等待，不增加生产配置。回退仅代码及 bundle；不改 Schema、不迁移生产数据、不解除未知 Hold，不接管/重派已有 Worker。
