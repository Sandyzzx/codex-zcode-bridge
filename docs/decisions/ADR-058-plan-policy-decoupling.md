# ADR-058：套餐折扣验证与生产执行资格解耦

> Status: DECISION
> Decision: Accepted（用户于 2026-11-24 明确批准追加整改指令）
> Date: 2026-11-24
> Baseline: `codex/final-integration-20261124`（Preview.15 候选线）
> Related: [ADR-030](ADR-030-start-plan-provider-preflight.md)、[ADR-031](ADR-031-model-routing-v1.md)、[ADR-054](ADR-054-safe-installed-runtime-without-static-version-gate.md)

## Context

ZCode 4.0 起套餐政策调整：官方对 Start Plan 的使用范围、Coding Plan 的折扣活动均可能随时变化。Bridge 此前在多处将套餐折扣/权益验证结果用作执行前置条件（Worker Spawn 前的 Start Plan live-entitlement 就绪失败、session 工厂后的 Provider/plan 事实校验抛错、Task Admission 的 Start Plan 凭据可用性检查）。官方政策反复变化会导致这些耦合点反复返工。

## Decision

1. **折扣验证结果不再是执行门槛。** Task Admission、Provider Routing、Runtime
   Selection 和 Worker Spawn 均不以折扣验证记录、billing verdict 或权益快照
   作为阻断条件。折扣为 1.0、0.67 或未知不影响任务执行资格。
2. **移除 Bridge 自设的套餐权益预检。** 删除 `startPlanProviderEntitled`
   就绪失败、provider 快照 `access.entitled` 检查、非 BigModel Start Plan
   凭据绑定拒绝与官方注册表缺失拒绝（Worker Spawn 前）；Provider/plan 事实
   （`accountProviderSelectionCapability`）在 session 工厂后仅作诊断事件
   （`official_runtime_capability_diagnostic`），不再抛错。不新增替代门禁、
   授权文件、白名单、兼容状态机或权益缓存。
3. **保留官方认证与凭据安全。** Start Plan/Coding Plan 私有凭据通道、
   runtime-auth 头解析、凭据脱敏、任务生命周期保护全部保留。Start Plan 与
   Coding Plan 实现不删除（技术投资保留），历史任务记录保留。
4. **官方拒绝是唯一权威限制。** 官方服务端拒绝时返回真实错误，走正常
   turn-failure → Cleanup → Release 路径；不做针对风控的自动重试，不自动
   切换 Provider 或付费套餐（ADR-031 的 auto 路由偏好仍只作用于派发前的
   Provider 选择，不在失败后切换）。
5. **Cost Lab 保持观测能力。** 保留历史折扣证据与实际计费对账；
   `calculateCreditBreakdown` 不再默认假设 0.67 倍率——折扣期望仅在调用方
   显式提供 `discountRatio` 时计算（`expected_with_discount`），未提供时
   观测分类为 NORMAL/OTHER/ZERO_CHARGE/INCONCLUSIVE，`effective_extra_ratio`
   始终按实测计。
6. **SQLite Schema 不变。** 本决定不改 Schema、不改 Turn 事件、Lease Spawn
   Fence、Release/Wake、Result 回读合同。

## Non-Changes

安装安全门禁（ADR-054）不变；官方认证复用（ADR-037）不变；`zcode_cancel`
与行政释放合同不变；Model Catalog 冷读与路由偏好逻辑不变。

## Consequences

- 无权益预检时，未经授权的 Start Plan 任务会到达 AppServer 并收到官方
  拒绝（真实错误），随后正常 Cleanup/Release；不再有 Bridge 侧友好预检
  失败。
- Cost Lab 未声明活动倍率的历史对账记录分类从 `EXTRA_0_67` 变为
  `OTHER`/`INCONCLUSIVE`（`effective_extra_ratio` 仍记录实测倍率）；
  显式提供倍率的对账得到 `EXTRA_DISCOUNT_<ratio>` 分类。
