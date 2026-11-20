# ADR-040：优先复用已安装官方 ZCode AppServer，并显式区分优惠兼容状态

> Status: DECISION
> Date: 2026-11-18
> Decision: Accepted — Owner 在 `BRIDGE_OFFICIAL_RUNTIME_INTEGRATION_COSTLAB_WEB_AND_STARTPLAN_COMPATIBILITY` 中批准生产 Runtime Resolver、官方 AppServer Worker Adapter、版本兼容 Manifest 与显式 fallback。
> Applicability: ACTIVE CANDIDATE。生产代码只存在于独立集成分支，尚未合并或发布。
> Verified against: V5 `8da4e61a79137dece48300ef6664ccc1ea4836db`；Preview.8 `02cf2fa92c8235370fe7a883d4c5b30d93a8ab33`；统一候选基线 `f5390897978be995b3a942feaeaac0170e8849fa`。

## Context

V5 真实计费实验确认：安装版 ZCode `3.18.2.10443` 的
`resources/glm/zcode.cjs` 经官方 `app-server --stdio --surface desktop`
执行时，连续四次取得约 `0.67` 的 Coding Plan 额外积分倍率。实验同时确认，
安装 Bundle 会执行官方 `OfficialRequestSecurity` 和
`POST /api/paas/c1f3a7e2/v2/client` signing handshake。

Preview.8 的 `OfficialHostAdapter` 已复用固定官方 Host 的认证、进程管理和
任务协议，但其 AppServer、Provider 配置和 runtime-host 来自插件打包资产，
不是本机已安装 Desktop 的完整 AppServer Bundle。研究不能把“协议成功”与
“官方优惠兼容”混为一谈，也不能在未知 Bundle 上静默声明 `0.67`。

## Decision

### 1. 安装版 AppServer 是 Coding Plan 的首选执行运行时

生产 Worker 在 Windows x64 上选择 Coding Plan 执行时，优先使用通过本机
路径发现找到、并通过版本兼容 Manifest 校验的官方安装版 AppServer：

```text
Bridge Worker
  -> Installed Official AppServer Resolver
  -> unchanged installed resources/glm/zcode.cjs
  -> installed same-root Provider config
  -> installed zcode-runtime-host.exe
  -> existing Official Host process manager and auth service
  -> official AppServer protocol / Request Security / Model transport
```

Resolver 必须从现有 `src/runtime/paths.ts` 安装发现出发，不硬编码用户目录，
并分别验证：

- Desktop 产品版本和 AppServer Bundle SHA-256；
- Bundle 与 builtin Provider 配置来自同一安装根；
- runtime-host 的来源、大小和摘要；
- Node 主次版本兼容性；
- AppServer 协议和 Request Security 能力的已知兼容声明。

路径发现、版本读取、摘要校验和 Process Manager 构造都不能拼接 Shell
命令。模型子进程必须使用参数化 `spawn`/官方 Process Manager。

### 2. 兼容 Manifest 是优惠声明的门禁

已知兼容项至少记录：

```text
desktop_version
bundle_sha256
bundle_bytes
runtime_host_sha256
node_compatibility
appserver_protocol
request_security_capability
coding_plan_discount_verified
start_plan_static_compatibility
verification_date
```

首个已验证项为：

```text
desktop_version: 3.18.2.10443
bundle_bytes: 15675386
bundle_sha256: 08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c
node_compatibility: >=24.16.0 <25
```

版本、大小或 SHA-256 任一不匹配时返回可诊断的
`OFFICIAL_RUNTIME_UNVERIFIED`，不得返回“已知优惠兼容”。

### 3. Fallback 必须显式且不继承优惠结论

找不到安装版或未知版本时：

- 任务失败要保留现有 fail-closed 和生命周期语义；或
- 用户显式选择既有兼容运行时后，才允许使用打包/vendored 路径；
- 该路径必须显示 `OFFICIAL_DISCOUNT_NOT_VERIFIED`；
- 执行成功、HTTP 200 或 Token 对上都不能单独证明额外 `0.67`。

其他 Provider 的既有 Runtime 选择规则不变。本决定只约束需要“已安装官方
AppServer 优惠兼容”声明的 Coding Plan 执行。

### 4. 官方认证与 Bridge 生命周期保持原所有权

复用安装版 AppServer 不等于复制其认证或请求安全实现。Bridge 继续：

- 通过现有官方 Host 模块读取官方认证材料；
- 保留 Coding Plan Provider Runtime Headers callback；
- 保留 Start Plan 独立 Provider、Billing verdict、Private Lease 和失败语义；
- 不伪造 Device ID、权益 Header、OAuth、Project Token 或 signing；
- 不实现自定义 signing fetch；
- 不修改官方安装文件。

Task Admission、Claim、Manager、SQLite Authority、Hold、Cancel、Recovery、
Result、Cleanup 与 Release 仍由现有生产链拥有。安装版 AppServer 只替换模型
执行 Runtime，不建立第二套 Worker 生命周期。

### 5. Start Plan 只做离线兼容研究

本轮不得发起真实 Start Plan 模型、认证或权益请求。Start Plan 与 Coding Plan
可以共用 AppServer/Runtime 能力，但任何共用事实都不能推断其 Provider Auth、
Request Security、Gateway 或优惠资格也相同。

### 6. Coding Plan 与 BigModel Start Plan 共用安装版执行 Runtime

生产 Worker 对两个精确官方 Provider 统一选择
`OfficialAppServerWorkerAdapter`：

```text
account:bigmodel-individual-coding-plan
account:bigmodel-start-plan
  -> OfficialAppServerRuntimeResolver
  -> installed resources/glm/zcode.cjs
  -> installed same-root builtin provider config
  -> installed zcode-runtime-host.exe
  -> existing Official Host process manager / protocol / lifecycle
```

Runtime 身份校验是共用门禁，但 Provider Capability 分开判断：

- Coding Plan 要求 `OFFICIAL_DISCOUNT_VERIFIED`；
- Start Plan 要求 `start_plan_static_compatibility = OFFLINE_COMPATIBLE`；
- Start Plan 不读取、也不依赖 Coding Plan 的 `0.67` 优惠结论；
- 任一能力未满足时，在创建模型 Session 和构造 AppServer Process Manager 前失败。

这不是认证统一。Start Plan 继续使用精确 Provider registry 校验、Live
Entitlement、Private Credential Lease、Worker-parent authorization、设备身份绑定、
过期/取消和 secret redaction；不得回退到 Coding Plan OAuth、Project Token 或
Provider Runtime Auth。其他 Provider 的执行路由不变。

本轮只完成离线实现和合成生命周期验证。`STARTPLAN_REAL_ENTITLEMENT`,
`STARTPLAN_REAL_E2E`, `BILLING_OBSERVATION` 与真实 Native A/B 仍为 `NOT_RUN`。

## Consequences

正面结果：

- Coding Plan 的优惠执行路径来自用户已安装、官方签名发布的完整 AppServer；
- Bundle 未验证时不会再把普通协议成功误报为 `0.67` 兼容；
- Bridge 继续复用官方认证、官方 signing 和现有任务生命周期；
- 版本升级可以通过 Manifest、Smoke 和定向真实计费验证逐步扩展。

代价与风险：

- 生产正确性依赖本机安装版本和文件完整性；
- 官方升级会先进入 `OFFICIAL_RUNTIME_UNVERIFIED`，直到更新兼容证据；
- 安装版与插件打包 Runtime 的协议差异仍需 AppServer Adapter 回归；
- `0.67` 目前只对个人 Coding Plan 的 `GLM-5.3-Flash` 一部分已测窗口成立，
  不能推广到所有模型、账户或时段。

## Required Verification

- Resolver：发现、同根验证、摘要、未知版本、缺失安装、Node 不兼容、路径注入。
- Adapter：Process Start、Provider Update、Session Create/Subscribe/Send、
  Turn Completion、Runtime Headers、Auxiliary Request、Cancel、Timeout、
  Process Exit 与 Cleanup。
- 生产 Coding Plan E2E：必须证明实际使用安装版 Bundle，并取得 fresh
  before/after 官方账单、Token 分类和约 `0.67` 的有效额外倍率。
- Start Plan：只允许静态/模拟测试，`LIVE_E2E: NOT_RUN`，
  `DISCOUNT: NOT_VERIFIED`。

## Relationship To Existing Decisions

- [ADR-001](ADR-001-appserver-as-production-execution-path.md) 的 AppServer
  唯一执行路径保持有效。
- [ADR-009](ADR-009-windows-identity-bound-tree-termination.md)、
  [ADR-034](ADR-034-normal-cleanup-worker-tree-proof.md) 的清理证明保持有效。
- [ADR-037](ADR-037-official-zcode-authentication-reuse.md) 的官方认证所有权
  保持有效；本决定只调整官方 AppServer 资产的 Runtime 选择来源。
- [ADR-038](ADR-038-preview6-minimum-architecture-remediation.md) 的
  SQLite/Worker/Official Host 核心边界保持有效。
