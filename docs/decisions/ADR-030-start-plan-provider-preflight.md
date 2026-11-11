# ADR-030：Start Plan Provider 的任务级权益预检

> Applicability: ACTIVE, AMENDED — Preview.3 的已批准合同为每个 Start Plan Issuer/Task 一次权威 Billing GET；`issue()` 复用完全相同的 account/provider/model/device/credential 绑定 verdict，身份变化拒绝复用，需新任务重新授权。原第 5 条“交付前第二次新鲜 Billing”已被任务级 verdict 绑定取代；fail-closed、Private Lease/HANDLE/ACK 与不跨任务缓存语义不变。来源：PR #71 / 当前 PROJECT_STATE；不改变原历史正文。

> Status: DECISION
> Date: 2026-11-07
> Decision: ACCEPTED — Owner 授权 Preview 2.0 Start Plan Provider 就绪性收口
> Observed runtime: ZCode CLI/AppServer 0.17.1

## Context

ZCode AppServer 0.17.1 的 Provider Resolver 只有在 account Provider 的
`entitled === true` 且 account state `current !== false` 时，才允许模型变为
executable/selectable。`availability: "pending"` 不会解除该门槛。

Preview Start Plan 原执行顺序是在 Session/模型选择后，通过 Private Credential
Lease 执行实时 Billing。因旧 `coding-plan-cache.json` / Provider 配置为
unavailable，AppServer 会先拒绝模型选择，运行时 Billing 永远无法开始。

## Decision

1. 只对明确选择 `account:bigmodel-start-plan` 的任务，在 Provider 注册之前，使用
   当前官方凭据和任务指定模型执行一次实时、只读 Billing 检查。
2. 只有 Billing 明确证明该模型有可用权益，才在本次任务的 Provider 配置快照中把
   该 Provider 标记为 entitled/current。JWT 存在、旧缓存、旧 API Key 和 Provider
   注册成功本身均不证明权益。模型未列入官方 builtin registry 时 fail closed。
3. Provider snapshot 仅含必要的权益布尔状态和模型注册信息，不含 JWT、Device ID
   或 API Key；Start Plan 的模型目录读取不发 Billing 请求，也不从旧缓存推定可用。
4. Provider 注册失败、Billing 拒绝/未知、凭据改变或模型未注册时，不创建 Session、
   不发送模型请求、不发放 Private Credential Lease。Coding Plan 和其他 Provider
   的既有执行及注册行为保持不变。
5. Worker 请求私有凭据时，再对同一账户、Provider、模型执行一次新鲜 Billing 检查，
   并保留现有账号/turn/attempt/operation、HANDLE、单次 ACK 与租约有效期校验。
   预检结果不跨任务缓存，也不代替凭据交付前的复核。
6. 若预检拒绝发生在 AppServer 启动前，Adapter 可证明自身没有创建 AppServer 或
   Browser 资源，并返回明确的 `start_plan_preflight_rejected` 清理范围。Manager
   仍须单独验证 Worker 关闭与 SQLite Result/Cleanup/Release；此证明不替代 Worker
   身份关闭证据，也不制造进程树清理收据。

## Rationale

该运行时先验要求 entitlement 才允许模型进入可执行目录，因此必须先取得真实
Billing 证据。任务级预检只打开当前目标模型的注册门；租约签发时再次实时核验，
避免把一次预检当作后续模型调用的授权缓存。

## Consequences

- Start Plan 任务启动前可能多一次只读 Billing 查询；预检拒绝会形成普通 failed
  Result，不启动 ZCode AppServer。
- Start Plan Catalog 不表示实时权益；需要执行时以任务级 Billing verdict 为准。
- AppServer 0.17.1 的静态语义来自本机安装文件：
  `zcode.cjs` SHA-256
  `d9afd58d694f98a5279bf548cdc7646413c125762e86730605a6071f9e0346d6`。
  没有启动该 AppServer；不把该观测推广为其他版本的官方合同。
- 真实 Billing 和模型请求仍需单独授权；本 ADR 的实施验证使用受控 fake transport。

## Verification

覆盖任务级预检正反例、账号/模型绑定、无跨任务缓存、租约前二次 Billing、旧缓存
不可授权、AppServer 注册失败零 Session/Send、Coding Plan 不触发预检，以及拒绝后的
failed Result、Worker close 和 SQLite Release。真实 Start Plan E2E 不由合成结果替代。
