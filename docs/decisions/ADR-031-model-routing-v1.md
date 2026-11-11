# ADR-031：Model Routing v1 — Start Plan 优先与显式模型选择

> Applicability: ACTIVE — 下文对 ADR-030 的 prepare/issue 实时授权引用，以该 ADR 页首 Preview.3 修订为准：每任务一次权威 Billing verdict；路由本身不增加 Billing 请求。原设计正文保留用于追溯。

> Status: DECISION
> Date: 2026-11-09
> Decision: ACCEPTED — Owner 授权 Model Routing v1 合同冻结与最小实施
> Observed runtime: ZCode CLI/AppServer 0.17.1

## Context

Preview 2.0 已有 Start Plan Provider、任务级实时 Billing 预检（ADR-030）与
Private Credential Lease。当前用户必须显式选择 `account:bigmodel-start-plan`
才能使用 Start Plan，且 Bridge 只在启动时读取一次官方凭据：启动后新登录、
退出登录或切换账号都不会影响后续任务。用户期望"像使用 ZCode CLI 一样"：
普通模型自动优先 Start Plan，显式选择保持强制，凭据按任务读取当前登录状态。

## Decision

1. **用户可见模型名**：所有经 Start Plan 执行的模型统一以
   `<OfficialModelId>-StartPlan` 呈现和选择（例如 `GLM-5.3-Flash-StartPlan`）。
   别名从官方 Provider Registry 的 Start Plan `builtinModelIds` 动态生成，
   不硬编码模型列表。发给官方 AppServer 的 `model_id` 始终是去掉后缀的原始
   ID；后缀只存在于 Bridge 的目录、选择语义和路由决策记录中。持久化的
   TaskPackage 始终保存实际执行的 provider/model（可核验的真实 Provider ID）。
2. **唯一自动路由设置**：新增 `ZCODE_BRIDGE_PREFER_STARTPLAN`（持久化于
   runtime-config.json，默认 `true`，仅接受 `true`/`false`）。它只影响
   `zcode_task.model` 未指定 `provider_id` 的普通模型选择；不自动授权调用
   Bridge，不改变显式 Provider 语义，不引入第二套模型配置系统。
3. **路由优先级**（每个新 Task 在创建时解析一次）：
   1. 显式 Start Plan：`provider_id` 为 Start Plan Provider 或模型名带
      `-StartPlan` 后缀 → 强制 Start Plan；无权益时拒绝，不回退。
   2. 显式其他 Provider（Coding Plan）→ 原样使用，不受偏好影响。
   3. 普通模型（未指定 provider）：`prefer_startplan=true` 时优先 Start Plan；
      仅当非权威权益缓存记录该模型 `no_entitlement`/`quota_exhausted`/
      `model_unavailable`（确认事实）且存在支持同一模型的 Coding Plan
      Provider 时，执行前回退到该 Coding Plan。Billing 网络异常、权益未知、
      3007/3012 风控、401/403 等一律不视为回退条件：照常路由 Start Plan 并在
      预检处给出可诊断的失败分类。`prefer_startplan=false` 时普通模型直接
      解析到 Coding Plan Provider（Bridge 默认 Provider 优先，其次官方
      Registry 中第一个支持该模型者；都不支持时拒绝并给出原因）。
   4. 未指定模型：沿用既有默认模型语义（Bridge 持久默认 → ZCode session
      默认），不做自动路由，不覆盖用户已有显式配置。
   自动路由只允许选择同一官方模型 ID，绝不跨模型替换。
4. **任务幂等**：路由结果在创建时解析并持久化于 TaskPackage.model；重复提交
   同一 `task_id`（含别名输入）在 Host 生命周期内复用首次解析结果，不因套餐
   状态变化重新选路。任务开始执行后失败不自动重派 Coding Plan。不新增
   SQLite 路由表、状态机或 Recovery 机制。
5. **凭据行为（CLI-like）**：移除"启动时无 Start Plan 凭据即永久不可用"。
   Host 向 SQLite Authority 提供 `startPlanPrivateAuthFactory`，仅当任务实际
   需要 Start Plan 认证时按需创建 Issuer：每次派发读取当前官方凭据，新登录
   无需重启即可被下一任务识别；退出登录后新任务以可诊断错误拒绝；运行中的
   任务绑定派发时账户，凭据交付前的账号一致性校验保持不变（跨账号不交付）。
   Private Credential Lease、HANDLE 门禁、单次 ACK、Host 关闭撤销能力全部
   保留。不引入文件监控、后台轮询或账号数据库。
6. **套餐状态**：路由只消费由实时 Billing verdict（prepare/issue 路径）更新的
   非权威进程内缓存；路由本身不发 Billing 请求，不新增第三次 Billing GET；
   `prepare()`/`issue()` 的实时授权语义不变。本轮不实现 `zcode_plan_status`。
7. **Schema 兼容扩展**：`zcode_task.model.provider_id` 由必填改为可选
   （向后兼容：仍接受完整 provider/model）。持久化 TaskPackage 的
   `ZCodeModelSelection` 合同不变（provider_id 必填），路由必须在持久化前
   解析出完整选择。

## Rationale

路由是任务创建时的一次性解析，执行链（ADR-030 预检、Private Lease、SQLite
生命周期）不需要知道"偏好"的存在；这样生命周期合同保持冻结，路由缺陷不
可能破坏 Result/Cleanup/Release。非权威缓存只做执行前选路，授权仍以任务级
实时 Billing 为准，避免把缓存变成第二条授权路径。

## Consequences

- Host 启动后首个普通模型任务在无缓存记录时会路由 Start Plan 并执行实时
  预检；预检拒绝形成普通 failed Result，其 verdict 更新缓存，后续同类任务
  执行前回退。这是 v1 已知的首次失败代价，不通过额外探测消除。
- 目录中的 Start Plan 别名条目不代表实时权益；权益只以任务级 Billing 为准
  （与 ADR-030 的目录语义一致）。
- Host 重启后进程内路由缓存清空；重复提交历史 `task_id` 若解析结果与持久化
  TaskPackage 不一致，按既有 TASK_ID_CONFLICT 拒绝，不静默改写历史任务。

## Verification

覆盖路由矩阵（显式/普通/偏好关闭/回退/拒绝/幂等）、别名与官方 Registry 映射、
目录别名条目、动态凭据发现（新登录/退出/换账号）、风控与未知不回退、Coding
Plan 与 SQLite Result/Cleanup/Release 回归，以及 Gate E1 合成完整 E2E。真实
Start Plan 模型 Turn 需 Owner 单独授权（Gate E2，最多一次）。
