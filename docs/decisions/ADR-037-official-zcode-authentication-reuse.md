# ADR-037：复用官方 ZCode 认证，不在 Bridge 建立第二套身份系统

> Status: DECISION
> Date: 2026-11-13
> Decision: Accepted — Owner 在“GOAL REVISION — Reuse Official ZCode Authentication”中明确冻结该架构要求。
> Applicability: ACTIVE IMPLEMENTATION。拓扑、职责和认证所有权已接受并冻结；当前候选已完成固定 Host 3.18.2 接线与合成验证，并通过真实 Coding Plan 完整 E2E 和真实 Start Plan 核心功能路径。候选已推送为 Draft PR #94，远端 Ubuntu/Windows CI 已通过；尚未 Merge、Tag 或 Release。历史 Start Plan 完整 E2E 因 Workspace 内额外 PowerShell cache 保持 `FAIL`。Desktop 3.18.0/3.18.1 实机安装组合、真实 OAuth refresh/账户轮换与其他未实测边界仍为 `NOT_VERIFIED`。
> Renumbering: 原接受包曾将该决定标为 ADR-036；迁移到最新 `origin/preview` 时，仓库已有独立的 [ADR-036](ADR-036-host-native-interruption-requeue.md)，为避免重复编号，本决定按顺序改为 ADR-037，内容与 Owner 授权不变。
> Verified against: Bridge research branch `d5c9cfedade9bc4bad69a7a3e873886e72843806`；官方 ZCode `b95ebaffeab641907b38652f45c1502bd762972d`（3.18.0）、`c5904686ea8341826b3affe5d993d06a134fa779`（3.18.1）、`fec975905a2abd4c07e35c40d51fa097a2258ec9`（3.18.2）。

## Context

Coding Plan 已通过 Worker 内的 Official Host 工厂复用官方 `CredentialService`、`OAuthCredentialRepo`、OAuth refresh 和 Account Provider Request Auth。Start Plan 仍由 Bridge 自行读取 `credentials.json`、解析 `enc:v1`/`enc:v2`、识别用户与关联身份、读取 device identity、解析 JWT，并生成私有 Lease。

这形成两条认证事实链：

```text
Coding Plan:
  Worker -> Official Host -> official CredentialService/OAuthCredentialRepo -> request auth

Start Plan:
  Worker -> Bridge credential reader -> Bridge identity parser -> Bridge lease
```

第二套链会随着官方 `enc:v2`、账户关联、国内入口和 refresh 规则变化继续漂移，也会让 Bridge 承担不属于自己的加密、登录和账户身份维护责任。Owner 已要求冻结以下方向：

```text
Official ZCode credential store / OAuth / account provider
  -> Official Host authentication boundary
  -> transient Start Plan material
  -> Bridge entitlement + Attempt/Lease lifecycle
  -> Official AppServer
```

## Decision

### 1. 官方模块拥有认证与账户身份

以下能力只能由固定官方 Host 中的官方模块拥有：

- 官方凭据容器与 `enc:v1` / `enc:v2:os` / `enc:v2:env` 解密；
- Windows Credential Manager、managed-secret 和其他官方密钥来源；
- `oauth:active_provider`、用户资料、BigModel 关联、`zai_cn` 映射和账户身份选择；
- OAuth access/refresh/JWT 的合法读取、刷新、CAS 发布与 session revision；
- Start Plan 与 Coding Plan 使用的官方 Request Auth 投影。

Bridge 不得自行实现上述逻辑，也不得直接消费凭据密文或自行维护账户 profile。

Windows x64 上，Bridge 独立进程与 Desktop 使用同一用户时，技术上可以经官方 `@napi-rs/keyring` 读取 Windows Credential Manager；这已经由固定制品内的官方模块只读验证。但“可访问”不等于“授权 Bridge 实现第二套认证”。官方 Desktop Main 对 utility Host 使用私有 `CredentialCipherRequest` 通道，而独立 Bridge 无法复用该通道且不得新增 IPC。因此目标 Official Host 在 Bridge Worker 中应作为 standalone local credential owner，在 Host 内部组合官方 cipher/repo，并向 Bridge 只投影一次任务所需的认证材料；Bridge source 不直接访问 keyring。

### 2. 固定 Host 暴露窄的 Start Plan 认证边界

Official Host 模块新增或等价替换为一个窄方法，语义如下：

```ts
resolveStartPlanAuthentication({
  family: "bigmodel",
  signal,
}): Promise<{
  accountIdentity: string;
  sessionRevision: string | null;
  requestCredential: string;
  credentialExpiresAt: number | null;
  deviceMid: string;
} | null>
```

结果只存在于当前进程内存。除了执行 Billing 所需的 `requestCredential` 和 `deviceMid`，不得向 Bridge 返回 access token、refresh token、Cookie、keyring key、密文或原始凭据容器。

该方法必须：

1. 使用官方 3.18.2 `OAuthCredentialRepo.loadStartPlanMaterial("bigmodel")` 或经新 ADR 批准的后续官方等价入口；
2. 使用官方同一登录主体、session revision、共享 `zcodejwttoken` 和 Start 家族映射；
3. 对 `bigmodel` 直登、已关联 BigModel 的 `zai`、以及 `zai_cn → bigmodel` 采用官方身份语义；
4. 使用官方 telemetry device identity，不从 Bridge 另建设备身份；
5. 在取消、凭据不可读、身份缺失、过期且不可安全刷新时返回 null；
6. 不在请求期切换登录入口、Provider 或账户。

Bridge 可以消费该结果完成 ADR-030 的实时 Billing 检查，并通过现有 Private Lease/HANDLE/ACK 向 Worker 私有交付 `requestCredential`。这不改变“一次任务一次权威 entitlement verdict”的规则。

### 3. 读兼容必须只读

官方 `CredentialService` 的普通读取在发现 `enc:v1` 时会执行读时迁移。P0 Addendum 禁止 Bridge 因认证兼容而自动迁移、覆盖、清理或重新生成生产凭据，因此 Bridge 不能以“直接调用官方 `CredentialService.load()`”作为完整实现。

目标 Host 必须提供一个只读官方兼容入口：

- 解密算法、历史 key candidates、`enc:v2` source 与 fingerprint 校验使用官方 cipher，不在 Bridge 复制；
- 读取 `enc:v1` 时不得写回 v2；
- 读取 v2 时不得创建新的 key、keyring entry、`credential-source` 或 `credential-secret`；
- 损坏、缺密钥、格式未知或无法证明无写入时 fail closed；
- 只有当前请求确实需要过期凭据时，才可经过 ADR-033 的官方 refresh 事务提交正常 token rotation；格式迁移和请求期 refresh 是两件不同的事。

决定作出时，官方 3.18.2 没有公开的“无迁移 credential snapshot”接口。实现时优先推动一个可复用的官方读接口；若固定源码仍无该入口，可以在 Official Host patch 中加入窄适配层，但适配层也只能组合官方 cipher 与官方 repo，不得把 AES、keyring 或身份解析移入 Bridge。当前候选采用后一种方式：固定 Host patch 增加只读 credential snapshot 和窄 Start Plan resolver；它仍组合官方 cipher/repo，未在 Bridge 复制认证实现。

### 4. 固定 Host 版本策略

正式目标是将固定 Official Host 源码基线更新到 ZCode `3.18.2` / `fec975905a2abd4c07e35c40d51fa097a2258ec9`，因为该版本已经包含：

- `OAuthCredentialRepo.loadStartPlanMaterial`；
- 共享 JWT 的 Start request auth；
- `resolveStartPlanFamilyFromOAuthProvider("zai_cn") -> "bigmodel"`；
- 需要一并验证的官方凭据存储增强。

不能只把 `3.18.2` 写死为 Desktop 或 Billing 版本。以下三个值必须独立观察：

```text
Desktop installation version
Official Host / AppServer artifact version
Runtime-reported Billing app version
```

模型请求的启动上下文遵循同一“制品来源与用途分离”原则：

- 若固定 AppServer 源旁存在有效安装版 Desktop `app.asar` metadata，则该 metadata 的应用版本与 build commit 优先；
- 独立 Host 没有相邻 `app.asar` 时，模型请求的应用版本取自 Official Host module 编译导出的 `ZCODE_PRODUCT_VERSION`；
- `ZCODE_BUILD_COMMIT_ID` 只能来自可验证的 Desktop build metadata；缺失时保持缺失，不得用 Official Host 源码提交号、AppServer `0.17.1` 或其他版本冒充；
- 不得把 Desktop 版本、Official Host 产品版本和 AppServer CLI 版本拼成同一个身份的字段；
- Start Plan 与 Coding Plan 使用同一官方 AppServer 启动上下文，不按 Provider 分叉请求版本。

保留 `3.18.0` Host patch 并手工回移身份逻辑只可作为明确标注的临时兼容研究。它需要维护一套非上游认证回移，不能成为默认长期方案。若 `3.18.2` 升级在实践中被证明不兼容，必须先形成新的 Host 升级 ADR，说明 exact patch、BOM、回滚和版本矩阵，再替代本决定。

### 5. Desktop 3.18.x 兼容是矩阵，不是版本猜测

Bridge 的固定 Host 不按 Desktop 版本选择认证算法，也不通过读取 Desktop 版本号猜测凭据格式。凭据由格式、source marker、ciphertext fingerprint 和官方解密结果决定。

发布验收至少覆盖 Desktop `3.18.0`、`3.18.1`、`3.18.2`。没有实际样本或隔离等价证据的组合必须标为 `NOT_VERIFIED`，不得由相邻版本推断为 PASS。不得要求所有用户先升级到 `3.18.2`。

### 6. 保留 Bridge 生命周期保护

以下 Bridge 责任不迁移到官方 Host：

- Task Admission、Permission、Workspace Admission；
- Attempt、generation、permanent Claim、spawn claim-only Worker 与精确 OS identity；
- ADR-030 的单次权威 entitlement verdict；
- Private Lease/HANDLE/ACK、一次性交付、secret redaction 和过期检查；
- Result Commit、Runtime Events/Usage、Hold、Recovery、Cleanup、Release CAS；
- fail-closed、unknown acceptance 不重试和 Cleanup 未证明不 Release。

官方 Host 只返回认证材料。它不能决定 Bridge Task 是否 entitled、完成、可清理或可释放。

### 7. 必须删除的 Bridge 认证实现

最终生产实现不得继续包含：

- Bridge 内 `enc:v1` / `enc:v2` AES-GCM 解密和 key candidate；
- Bridge 内 `@napi-rs/keyring` 读取、hash 或 account 计算；
- `credential-secret` / `credential-source` 私有发现；
- `oauth:active_provider`、`oauth:linked_bigmodel`、`oauth:*:user_info` 私有解析；
- Bridge 侧 JWT payload/exp 解析；
- Bridge 侧 telemetry device identity 解析；
- 与上述重复的凭据 schema、身份 fallback 或账户选择器。

允许保留 `StartPlanBillingEntitlement` 的 Billing 请求、脱敏分类和 verdict 映射；它消费官方认证结果，不拥有账户认证。`readOfficialCliVersion` 可继续读取固定官方制品的真实运行版本。

## Why Coding Plan Already Reuses Official Auth

Coding Plan 的 Worker 路径调用 `loadOfficialHostProviderRuntimeAuthFactory()`，再由官方工厂解析当前 account access、读取官方 OAuth 材料、按需刷新、获得家族 Project Token 并返回 request auth。

决定作出时，Start Plan 没有走该路径。旧 `createProductionStartPlanAuth()` 直接读取官方数据根并构造 Billing issuer；AppServer 的 Start request auth 由 Bridge 的 Private Lease 供给。当时固定 3.18.0 Host 中的协调工厂通过 `loadFamilyMaterial()` 读取 Start JWT，无法表达 3.18.2 的 `loadStartPlanMaterial` 和 `zai_cn` fallback。

当前候选已把 Start Plan 改为消费固定 3.18.2 Host 的窄认证投影；Billing verdict、Private Lease/HANDLE/ACK 和任务生命周期仍由 Bridge 持有。该差异来自旧接线与固定版本，不是 Coding Plan 与 Start Plan 本质需要两套凭据系统。

## Consequences

正面结果：

- 官方加密、登录与账户语义只有一份；
- `zai_cn`、关联账户和未来登录修复可由官方 Host 演进承载；
- Bridge 不再随 `enc:v2` 或 keyring 实现漂移；
- ADR-030 与现有任务生命周期保持不变。

代价与风险：

- 必须重建并重新验证固定 Official Host/AppServer/BOM；
- 官方 3.18.2 没有现成的无迁移读取入口，需要在固定 Host patch 中维护窄适配层；
- 3.18.0/3.18.1/3.18.2 和 v1/v2 兼容矩阵仍需隔离验证；
- 固定 Host 升级本身不等于 Desktop 兼容或真实 Start Plan 成功。

## POC-1 Entry Conditions

本 ADR 不授权 POC 执行。后续 POC-1 至少应满足：

1. 固定 Host、AppServer、Node/native/helper 与资源版本已形成候选 BOM；
2. `resolveStartPlanAuthentication` 的输入、输出和错误分类冻结；
3. bridge source tree 不再包含私有 decrypt、keyring 或账户 profile 解析路径；
4. 使用隔离 credential-store 镜像覆盖 v1、v2:env、v2:os，并证明只读路径前后字节与 sidecar 完全一致；
5. 合成覆盖 `bigmodel`、已关联 `zai`、未关联 `zai_cn`、未关联 `zai`、账户切换、refresh、取消、损坏和未知格式；
6. Start request auth 和 Billing 读取同一 account/session/credential generation；
7. 每个 Task 仍只产生一次 Billing verdict，Lease 绑定仍旧不可跨 Attempt 复用；
8. 未触发真实 OAuth、Start Plan、Billing 或模型请求；
9. Desktop `3.18.0` / `3.18.1` / `3.18.2` 的未实测项被明确列为 `NOT_VERIFIED`。

任一条件无法满足时停止，不进入生产接线。

## Relationship To Existing Decisions

- [ADR-030](ADR-030-start-plan-provider-preflight.md) 保持有效：任务级权威 entitlement、Private Lease/HANDLE/ACK 和 fail-closed 不变。
- [ADR-032](ADR-032-existing-worker-official-host-integration.md) 保持有效：现有 Worker 内装配 Official Host，不新增 Companion 或第二套任务系统。
- [ADR-033](ADR-033-official-account-refresh-coordination.md) 保持有效：refresh 仍由官方 profile-scoped 事务协调。
- [ADR-034](ADR-034-normal-cleanup-worker-tree-proof.md) 与 [ADR-035](ADR-035-worker-platform-adapter-selection.md) 保持有效。
- 本文不把任何账户或 Cleanup Proposed 草案提升为 Accepted，也不从本决定推导真实账户、模型、R7 或 SQLite 已验证。
