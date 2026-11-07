# Gate 2 最终验证 — 未完成

> Status: RESEARCH
> Baseline: 67dd8c67275c4afeb81dd9795ee03e258083c54d
> Scope: 离线合成数据，未连接真实账户、Billing 或模型。

本轮新增 `frame.mjs` 和 `frame.test.mjs`，针对长度前缀单帧进行有界长度、分片 UTF-8、非法 UTF-8、额外帧、截断与非有限期限的隔离测试。与先前 Lease 测试一起运行：Windows Node 24.16.0，26 PASS / 0 FAIL。帧解析器尚未接入 `worker.mjs` 或生产 Worker，测试不等于端到端 IPC 通过。

## 验收状态

| 项目 | 状态 | 证据与缺口 |
| --- | --- | --- |
| RUNTIME_AUTH_TURN_ORDER | NOT VERIFIED | 生产 Adapter 的 session/create、setModel、send 和 event 源码顺序已检查；现有 SQLite 真实 Adapter 测试接的是 fake AppServer，不提供真实原生 runtime-header 相对 turn.started 的证据。 |
| PRODUCTION_WORKER_CLAIM_BINDING | NOT VERIFIED | 当前生产 Worker 无 Start Plan 专用 FD 或 Lease 接线；不能将独立子进程 PID 测试当作 Claim 集成。 |
| IPC_PROTOCOL | PARTIAL | 新增单帧解析与 Lease 独立测试通过；ACK 丢失、真实通道串接、跨 Worker 重放未完成。 |
| CANCELLATION_AND_CRASH | PARTIAL | 独立 Lease 覆盖写入前取消和等待探测时取消；写入中取消、Parent EOF、Worker 退出后收束未证明。 |
| SECRET_ISOLATION | NOT VERIFIED | 仅使用合成字符串，尚未通过生产 Claim/SQLite 路径扫描数据库、任务、日志、诊断、argv/env 和交互记录。 |
| CODING_PLAN_COMPATIBILITY | NOT RUN | 生产代码无本轮改动，但没有执行 Coding Plan 回归，不标记通过。 |
| INDEPENDENT_REVIEW | NOT RUN | 本轮修改后的独立审查尚未完成。 |

JavaScript 字符串清除引用不保证物理擦除；交付开始后不得重新发送。设备身份继续 NOT VERIFIED。Gate 2 未通过，不进入正式功能集成。
