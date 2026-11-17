# Start Plan 与官方 AppServer 离线兼容性研究

> Status: RESEARCH
> Last updated: 2026-11-18
> Last verified: 2026-11-18
> Verified against: `02cf2fa92c8235370fe7a883d4c5b30d93a8ab33`
> Observed product: ZCode Desktop `3.18.2.10443`

## 1. 范围与结论

本轮只做离线源码、安装版 Bundle、Provider Registry 和现有 Adapter 合同分析。
没有执行 Start Plan 或 Coding Plan 的真实模型请求、认证、Billing、权益或网络探测。

核心结论：

1. 安装版 ZCode 只有一个官方 AppServer Bundle，Bundle 内同时包含 Coding Plan
   与 Start Plan 的 Provider 规则，因此可以确认“同一 AppServer 制品可承载两类
   Provider”这一静态条件。
2. Start Plan 与 Coding Plan **不共用**模型请求的 Client Signing 分类。
   安装版 `createModelRequestSecurityState` 明确将 `start-plan` 排除在
   `OfficialRequestSecurity` 的签名 transport 之外。
3. Start Plan 不应执行 `get_sign_key` 或
   `/api/paas/c1f3a7e2/v2/client` Signing Handshake。对 Start Plan 模型请求，
   `SIGNING_HANDSHAKE: NOT_APPLICABLE`。
4. 两类套餐使用不同 Gateway：
   - Start Plan：`https://zcode.z.ai/api/v1/zcode-plan/anthropic`
   - Individual Coding Plan：`https://open.bigmodel.cn/api/anthropic`
5. 两类套餐使用同一
   `interaction/requestProviderRuntimeHeaders` AppServer RPC 机制，但凭据来源不同：
   Coding Plan 使用 Official Host Provider Runtime Auth；Start Plan 当前仍使用
   Bridge 私有 credential reader、任务级 Billing verdict 和一次性 Private Lease。
6. 现有 Adapter 具备 Start Plan 的离线协议门禁：
   Provider Registry 校验、任务级 entitlement、`provider/updateAccountConfig`、
   精确 Session/Turn/Model Runtime Headers 绑定，以及不向 Coding Plan 静默回退。
7. 当前没有 Start Plan 额度，因此以下结论没有被扩大：
   - 真实 Start Plan AppServer E2E：`NOT_RUN_BY_OWNER_CONSTRAINT`
   - 真实 Start Plan Auth/Billing/Model 行为：`NOT_VERIFIED`
   - Start Plan 积分优惠：`NOT_VERIFIED`

## 2. 基线与只读证据

### 2.1 安装版制品

本轮只读取文件元数据和静态内容，没有复制或输出凭据。

```yaml
ZCODE_VERSION: 3.18.2.10443
APPSERVER_BUNDLE: resources/glm/zcode.cjs
APPSERVER_BUNDLE_SIZE: 15675386
APPSERVER_BUNDLE_SHA256: 08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c
RUNTIME_HOST: resources/tools/runtime-host/zcode-runtime-host.exe
RUNTIME_HOST_SIZE: 179608
RUNTIME_HOST_SHA256: c2c8ff5ff28cbddc4f177c094aa67c322830889612251bd173baaabc89379ab4
BUILTIN_PROVIDER_CONFIG: resources/config/provider/zcode-builtin.json
BUILTIN_PROVIDER_CONFIG_SIZE: 261659
BUILTIN_PROVIDER_CONFIG_SHA256: ef3d64656cb5281cce292b77ef12e96b5251582cfb00cdf9eb08e3d4565abb69
```

安装版 Bundle 是唯一 AppServer 程序制品。静态源码显示：

```text
createModelRequestSecurityState()
  -> OfficialRequestSecurity
  -> protectTransport(...)
  -> requiresClientRequestSigning(providerConfig)
```

仓库内 packaged official-host Bundle 的
`createModelRequestSecurityState` 行为与安装版不同，本轮没有使用 packaged Bundle
推断安装版的签名或优惠行为。

### 2.2 Provider Registry

安装版和仓库 packaged registry 中，以下两个 Provider 的关键规则一致。

```yaml
providerId: account:bigmodel-start-plan
providerName: Start Plan
access:
  type: zhipu-account
  mode: start-plan
  accountType: bigmodel
api:
  type: anthropic-messages
  baseUrl: https://zcode.z.ai/api/v1/zcode-plan/anthropic
builtinModelIds:
  - GLM-5.3-Flash
  - GLM-5.2
  - GLM-5-Turbo
```

```yaml
providerId: account:bigmodel-individual-coding-plan
providerName: BigModel Individual Coding Plan
access:
  type: zhipu-account
  mode: individual-coding-plan
  accountType: bigmodel
api:
  type: anthropic-messages
  baseUrl: https://open.bigmodel.cn/api/anthropic
```

这证明两者可以在同一个 AppServer Provider Registry 中同时注册，但不证明
认证、请求安全、Gateway、赠额或优惠资格相同。

## 3. Request Security 与 Signing

安装版 Bundle 的静态分类逻辑等价于：

```text
if access.type == "zhipu-account"
   and access.mode in ("start-plan", "off-peak", "highspeed"):
     requiresClientRequestSigning = false

if access.type == "zhipu-coding-plan-api-key"
   or (
     access.type == "zhipu-account"
     and access.mode in ("individual-coding-plan", "team-coding-plan")
   ):
     requiresClientRequestSigning = true
```

`OfficialRequestSecurity.protectTransport(...)` 只有在分类结果为 `true` 时才包装
Client Signing Fetch。Start Plan 的 `access.mode` 为 `start-plan`，分类结果明确为
`false`。

因此：

```yaml
START_PLAN_REQUEST_SECURITY_CLASSIFIER: UNSIGNED
START_PLAN_GET_SIGN_KEY: NOT_APPLICABLE
START_PLAN_C1F3A7E2_HANDSHAKE: NOT_APPLICABLE
```

这里的结论限定于安装版 3.18.2.10443 的模型 transport 分类。不能把它扩大为
“Start Plan 没有其他认证”，也不能反推 Start Plan 因此具有 Coding Plan 的优惠。

## 4. Gateway 差异

| 项目 | Coding Plan | Start Plan |
|---|---|---|
| Provider ID | `account:bigmodel-individual-coding-plan` | `account:bigmodel-start-plan` |
| Access mode | `individual-coding-plan` | `start-plan` |
| Base URL | `open.bigmodel.cn/api/anthropic` | `zcode.z.ai/api/v1/zcode-plan/anthropic` |
| Client Signing | 适用 | 不适用 |
| 当前 Bridge Runtime Auth | Official Host Provider Runtime Auth | Bridge Private Lease |

Start Plan 不使用 Coding Plan 的 BigModel Ultra Anthropic Gateway。相同
`anthropic-messages` API 类型只说明协议序列化类别相同，不说明上游路由相同。

## 5. Runtime Auth 与 Provider Runtime Headers

### 5.1 当前 Bridge 调用顺序

Start Plan 在
[`src/adapters/zcode-app-server-adapter.ts`](../../src/adapters/zcode-app-server-adapter.ts)
中的离线控制顺序是：

```text
task provider selection
  -> exact Start Plan registry validation
  -> task-scoped live entitlement flag
  -> provider/updateAccountConfig
  -> session/create + session/subscribe + session/send
  -> interaction/requestProviderRuntimeHeaders
  -> exact session/turn/model validation
  -> one-shot PrivateCredentialLease
  -> requestAuth.apiKey reply
```

关键门禁：

- 只有 `account:bigmodel-start-plan` 且 Registry access 为
  `zhipu-account/start-plan/bigmodel` 时才进入 Start Plan 分支。
- 未取得任务级 live entitlement 时，在 AppServer 启动前失败。
- `provider/updateAccountConfig` 被拒绝时不创建 Session。
- Runtime Header 请求必须匹配当前 Session、Turn、Provider 和 Model。
- Start Plan 分支失败时返回 `headersApplied:false`，不会改用 Coding Plan API key。
- 非 Start Plan 的 account Provider 才进入
  `resolveProviderRuntimeAuth`。

### 5.2 凭据链差异

Coding Plan 已通过 Official Host Provider Runtime Auth 解析请求凭据。
Start Plan 当前仍由
[`src/runtime/start-plan-production-auth.ts`](../../src/runtime/start-plan-production-auth.ts)
负责：

- Bridge 私有 credential reader
- account / session revision / credential expiry 校验
- Device Identity 上下文
- Start Plan Billing entitlement
- `PrivateCredentialLease`
- Worker 内一次性交付和撤销

这意味着：

```yaml
APPSERVER_RUNTIME_AUTH_RPC: SHARED_MECHANISM
CODING_PLAN_AUTH_SOURCE: OFFICIAL_HOST
START_PLAN_AUTH_SOURCE: BRIDGE_PRIVATE_LEASE
CREDENTIAL_CHAIN_PARITY: DIFFERENT
```

“使用同一个 RPC”不等于“使用同一凭据源或同一官方装配”。

## 6. CAPTCHA 与失败分类

现有离线合同将 Start Plan Billing 的官方业务失败码分类为：

| Provider code | 结论 | 行为 |
|---|---|---|
| `3007` | `captcha_required` | fail-closed，不自动重试 |
| `3012` | `unusual_activity` | fail-closed，不自动重试 |
| `3001` | `billing_parameter_error` | fail-closed |

当前 Bridge Adapter 没有桌面交互 CAPTCHA 回调或自动验证参数。
是否需要 Aliyun CAPTCHA 才能完成新的 Start Plan 模型请求，本轮为：

```yaml
ALIYUN_CAPTCHA_REQUIRED_FOR_MODEL_REQUEST: NOT_VERIFIED
```

现有 Private Lease 路径历史上曾有真实成功记录，但本轮没有重新执行，因此不能用
历史成功代替当前安装版 E2E。

## 7. 能力矩阵

| 能力 | Coding Plan | Start Plan |
|---|---|---|
| Official AppServer | 真实验证 | 离线分析 |
| Provider Registry | 真实验证 | 离线分析 |
| Request Security | 真实验证 | 静态核实为 unsigned |
| Signing Handshake | 真实验证 | `NOT_APPLICABLE` |
| Runtime Auth | Official Host 真实验证 | Bridge Private Lease；本轮未实跑 |
| Provider Runtime Headers | 真实验证 | 同一 RPC；Mock/合成测试 |
| Gateway | Ultra Anthropic 真实验证 | `zcode-plan/anthropic`；离线确认 |
| Billing Discount | 真实验证约 `0.67` | `NOT_VERIFIED` |

## 8. 离线测试

新增
[`test/start-plan-official-appserver-offline.test.ts`](../../test/start-plan-official-appserver-offline.test.ts)，
覆盖：

1. packaged official Provider Registry 中 Start Plan 与 Coding Plan 的身份、
   access mode、模型和 Base URL 独立。
2. 仅选择 Start Plan 不等于已取得 entitlement；必须存在任务级 verified
   selection。
3. 未注册的 Start Plan 模型在 AppServer 启动前 fail-closed。
4. `runtimeAuthReply` 即使能看到同名 BigModel Coding Plan API key，也不会把它用于
   Start Plan。
5. `3007`、`3012`、`401`、`403` 保持 fail-closed 分类。

执行命令与结果：

```text
npm run build:test
PASS

node --test dist-test/test/start-plan-official-appserver-offline.test.js
3 tests / 3 PASS / 0 FAIL
```

## 9. 现有兼容性判断

```yaml
START_PLAN_SOURCE_AUDIT: COMPLETE
START_PLAN_APPSERVER_COMPATIBILITY: OFFLINE_VERIFIED
START_PLAN_AUTH_PATH: DOCUMENTED
START_PLAN_REQUEST_SECURITY: DOCUMENTED
START_PLAN_RUNTIME_HEADERS_PROTOCOL: COMPATIBLE
START_PLAN_SIGNING_HANDSHAKE: NOT_APPLICABLE
START_PLAN_LIVE_E2E: NOT_RUN_BY_OWNER_CONSTRAINT
START_PLAN_DISCOUNT: NOT_VERIFIED
```

`OFFLINE_VERIFIED` 的含义仅限于：

- 官方 AppServer 制品包含 Start Plan Provider；
- 协议 schema 和现有 Adapter 的 Mock 路径能够完成注册与精确 Runtime Header 回调；
- 当前实现不会在失败时静默回退 Coding Plan。

它不表示真实 Start Plan 凭据、Billing、CAPTCHA、Gateway 和模型请求已经通过。

## 10. 剩余不确定项

1. Start Plan 当前任务级 Billing verdict 是否能稳定支持新的真实调用。
2. Bridge Private Lease 与安装版 3.18.2 AppServer 的完整实时组合尚未验证。
3. Aliyun CAPTCHA 是否会在真实账户、模型和时段触发。
4. 官方 3.18.2 已有 `loadStartPlanMaterial` 等能力，但尚无公开的无迁移
   credential snapshot API；本轮没有扩大为 Official Host 认证重构。
5. Start Plan 是否存在任何积分优惠、赠额加成或活动权益，均不能从 Coding Plan
   的约 `0.67` 实验推广得到。

以上任一项都需要未来额度恢复后重新授权真实测试，不属于本轮离线研究。
