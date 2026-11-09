# Model Routing v1 验收报告（2026-11-09）

> Status: RESEARCH / 验收证据
> Basis: ADR-031（DECISION）、Forensics 门禁（PR #67，HEAD `12cfcdaa`）、本报告执行结果
> Branch: `codex/model-routing-v1-20261109`，实现提交 `6012c5e7`

## 合同与实现

- ADR-031 已冻结：`<ModelId>-StartPlan` 别名、`ZCODE_BRIDGE_PREFER_STARTPLAN`（默认 true）、
  路由优先级、任务幂等（task_id 级路由缓存）、按次派发动态凭据发现、无第三次 Billing GET。
- `src/runtime/model-routing.ts`：路由矩阵、官方 Registry 读取、非权威 verdict journal、
  目录别名条目；`zcode_task.model.provider_id` 改为可选（MCP 入口），持久化 TaskPackage 仍为
  完整 provider/model。生命周期合同（R1–R5、Result/Cleanup/Release、ADR-024/027/030）未改动。
  Gate 的 `startPlanPrivateAuthFactory` 仅在实际 Start Plan 任务派发时解析；Authority 在任务
  创建阶段做 pre-intent 无凭据拒绝（ADR-028 语义），不在 Intent 前制造 launch-unknown 占用。

## 测试证据

| 门禁 | 结果 |
|---|---|
| Typecheck / Build / Plugin Validation / `git diff --check` | PASS |
| 路由单元矩阵 `test/model-routing.test.ts` | 16/16 PASS |
| Gate E1 合成 E2E（mvp-real-adapter harness） | 45/45 PASS（新增 4 项 ADR-031 场景全过） |
| Windows 全量回归 `npm run test:affected`（FULL_SUITE 选择） | 861 tests：860 PASS / 1 SKIP / 0 FAIL，约 21.1 分钟 |
| Ubuntu | NOT RUN（远程 CI 待 PR 触发；不把 Windows PASS 冒充跨平台 PASS） |
| SQLite Stress 边界（R2 32 MiB 等） | 已包含在上述全量执行中，PASS |

Gate E1 场景覆盖：显式别名 → 原始 model id 执行；普通模型自动 Start Plan；启动后登录/换账号被
下一次派发识别（凭据按次读取，无重启）；无凭据任务在创建时被拒且不创建 Operation；确认不可用
→ 执行前回退同模型 Coding Plan（零 Billing 消耗）；Billing 拒绝不静默回退；别名永不进入
AppServer 请求；凭据零泄漏。

## Gate E2 — 受控真实 E2E（单次模型 Turn，PARTIAL）

隔离证据目录：`D:\gate-e2-model-routing-20261109\`（独立 LOCALAPPDATA 根 + 独立 Workspace +
独立 SQLite v14 root；生产 SQLite、凭据、Device ID 未触碰）。任务 `gate-e2-1794166382206`，
model `{ model_id: "GLM-5.3-Flash-StartPlan" }`。

- CONFIRMED：动态凭据发现 → Billing 预检与租约前复核通过（执行链推进到 Send，两次只读
  Billing GET）→ Provider 注册 → Session 创建 → Turn 启动。
- REAL MODEL TURN：FAIL（一次，未重试）。ADR-011 FailureFacts：`phase=processing_input`,
  `http_status=405`, `provider_code=none`, `error_type=unknown_error`, `category=unknown`,
  `confidence=unknown`。与 Gate B 历史 turn.failed 同属 405 未确认家族；根因 UNCONFIRMED，
  本轮不推断为 WAF 归因。
- 生命周期闭环 CONFIRMED：result_committed（failed）→ cleanup_pending → cleanup_verified
  （manager_os_cleanup_verification）→ released；无 Hold、无 Recovery 占用、无孤儿 Worker。
- 别名映射 CONFIRMED：路由执行链全程使用原始 `GLM-5.3-Flash`，未向官方请求发送后缀。
- REAL_BILLING_REQUESTS: 2（prepare + issue，执行链推断）；REAL_MODEL_TURNS: 1；无自动重试。

## 结论

`IMPLEMENTATION: PASS`，`SYNTHETIC_E2E (Gate E1): PASS`，`REAL_E2E (Gate E2): PARTIAL` —
路由与动态凭据链在真实环境推进到模型 Turn 并保持完整生命周期闭环，但单次真实 Turn 因
HTTP 405 失败（405 类，UNCONFIRMED）。诊断链（ADR-011 FailureFacts）首次在真实失败中产出
结构化证据，符合 Forensics 验收目标。下一次真实尝试需 Owner 重新授权。
