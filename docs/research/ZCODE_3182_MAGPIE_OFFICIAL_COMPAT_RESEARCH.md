# ZCode 3.18.x 官方认证复用研究

> Status: RESEARCH
> Applicability: 当前认证架构研究对象；正式决定见 [ADR-037](../decisions/ADR-037-official-zcode-authentication-reuse.md)。该决定在原接受包中曾标记为 ADR-036，因最新 Preview 已使用 ADR-036 记录 Host 内中断重派发而按顺序重编号。
> Last updated: 2026-11-13
> Research basis: `zai-org/ZCode` `b95ebaffeab641907b38652f45c1502bd762972d`（3.18.0）、`c5904686ea8341826b3affe5d993d06a134fa779`（3.18.1）、`fec975905a2abd4c07e35c40d51fa097a2258ec9`（3.18.2）；Magpie `magpie-community/plugins` 0.1.55–0.1.61 与未合并 PR #956；Bridge research branch `d5c9cfedade9bc4bad69a7a3e873886e72843806`。
> Verification: 源码与固定制品为只读核对。真实 OAuth、Start Plan、Billing、模型请求和 3.18.x Desktop 安装矩阵均未运行。

## 结论

Bridge 不应继续实现自己的 ZCode 凭据解密、keyring 访问、账户 profile 解析和 Start Plan 身份 fallback。Coding Plan 已经通过 Official Host 中的官方 `CredentialService`、`OAuthCredentialRepo`、OAuth refresh 和 Account Provider Request Auth 完成认证；Start Plan 目前仍走 Bridge 私有读取器，是两条链不一致的根因。

官方 3.18.2 已提供复用 Start Plan 所需的核心官方语义：

```text
OAuthCredentialRepo.loadStartPlanMaterial("bigmodel")
  -> 当前登录主体 / session revision / 共享 zcodejwttoken

AccountProviderRequestAuthService
  -> 对 start-plan 只从 loadStartPlanZcodeJwt(family) 取共享 JWT

resolveStartPlanFamilyFromOAuthProvider("zai_cn")
  -> "bigmodel"
```

目标实现应更新固定 Official Host 到 3.18.2 或经新 ADR 批准的后续固定基线，并由 Host 暴露一个窄的 Start Plan 认证结果。Bridge 只消费结果，负责 Billing、任务 entitlement、Private Lease 和现有生命周期。

研究同时发现一个不能省略的兼容约束：官方 3.18.2 的普通 `CredentialService.load()` 在发现 `enc:v1` 时会迁移写回 v2，而 P0 Addendum 禁止 Bridge 触发自动迁移。官方当前没有公开的无迁移读取 API。因此，若固定版本仍无该 API，Host 侧必须增加一个只读适配层：文件快照读取可以很薄，但所有解密、key fingerprint、source 选择和身份语义必须继续调用官方模块，不能复制回 Bridge。

### Owner 问题的当前答案

| 问题 | 当前答案 | 证据等级 |
|---|---|---|
| 为什么 Coding Plan 能复用官方 Auth，而 Start Plan 没有？ | Coding Plan 已接到 Official Host 的官方 credential/repo/refresh/request-auth 工厂；Start Plan 的 entitlement 预检仍使用 Bridge 私有 reader、identity parser 和 device reader | **已核实（源码）** |
| 官方 3.18.2 是否提供完整可复用的 Start Plan 认证接口？ | **部分提供，不能直接作为完整入口。** `loadStartPlanMaterial`、共享 JWT request auth 和 `zai_cn → bigmodel` 已具备；没有公开的无迁移 credential snapshot、device identity 投影或完整 Host 导出 | **已核实（源码）；无迁移能力为 NOT_AVAILABLE** |
| 是否需要升级固定 Official Host？ | 首选升级到 3.18.2。它直接提供 Start material 和 `zai_cn` 语义；在 3.18.0 手工回移会形成持续维护的非上游分支 | **架构判断；升级未实施** |
| 如何保持 Desktop 3.18.0、3.18.1、3.18.2 兼容？ | 按格式与 source 解密，不按 Desktop 版本猜算法；固定 Host 与 Desktop 安装版本分别验收；三种 Desktop 和 v1/v2 组合逐项形成矩阵 | **目标；全部运行组合尚为 NOT_VERIFIED** |
| 哪些 Bridge 自建认证代码可删除？ | 私有 v1/v2 decrypt、keyring/fingerprint、credential sidecar、OAuth profile/关联身份、JWT exp 和 device identity 解析 | **待目标实现后删除；当前仍在生产代码中** |
| 哪些生命周期保护必须保留？ | Admission、Workspace、Attempt/generation/Claim、ADR-030 verdict、Private Lease、Events/Usage、Hold/Recovery/Cleanup/Release CAS 与 fail-closed | **已由 ADR-030、ADR-032、ADR-034 和 ADR-037 冻结** |

## 当前接线证据

### Host 实际导出

固定 Host：

```text
plugins/codex-zcode-bridge/worker/vendor/official-host/
  win32-x64-node24.16.0-zcode3.18.0-b95ebaff/official-host-runtime.mjs
```

实际导入检查仅见：

- `ZCodeAgentProcessManager`
- `ZCodeProtocolClient`
- `ZCodeStdioTransport`
- `createOAuthProviderRuntimeAuthService`

当前没有 Start Plan credential-material 专用导出。

### Coding Plan 路径

Worker 调用 `loadOfficialHostProviderRuntimeAuthFactory()`。固定 Host 工厂：

1. 用 `createCredentialService()` 读取官方 data root；
2. 用 `OAuthCredentialRepo` 读取家族材料；
3. 用官方 `OAuthService` 和 ADR-033 coordination 刷新过期 token；
4. 用官方 Account Provider Request Auth 构造 Project Token；
5. 只向 Worker 返回 request auth。

这条链路没有 Bridge 私有的明文解密、keyring 或 OAuth profile 实现。

### Start Plan 路径

`createProductionStartPlanAuth()` 直接读取 `<zcodeDataRoot>/v2/credentials.json`，解析：

- `zcodejwttoken`
- `oauth:...:user_info`
- `oauth:active_provider`
- `oauth:linked_bigmodel`
- JWT `exp`
- `telemetry-state.json` 的 `deviceMid`

并由 Bridge 自行构造 Billing issuer 和 `PrivateCredentialLease`。这是 ADR-037 要删除的第二套认证链。

### 当前协调工厂的 3.18.0 限制

Bridge 的 3.18.0 Host patch 新增了 `createOAuthProviderRuntimeAuthService`，但它是基于 3.18.0 组合：

- `needsOAuthRefresh()` 使用 `loadFamilyMaterial(family)`；
- `AccountProviderRequestAuthService` 的 Start 分支仍从家族 token set 取 `zcodeJwtToken`；
- 没有 `loadStartPlanMaterial(family)`；
- 没有 `zai_cn`-only Start 身份 fallback。

因此即使让 Start Plan 改走现有工厂，也不能覆盖 3.18.2 的新行为。

## 官方 3.18.0 → 3.18.2 认证边界

| 能力 | 3.18.0 | 3.18.1 | 3.18.2 | Bridge 当前 |
|---|---|---|---|---|
| `enc:v1` | 官方支持 | 官方支持 | 官方支持 | Bridge 私有解密 |
| `enc:v2:os` / `enc:v2:env` | 官方支持 | 官方支持 | 官方支持，并增加数据根复制等修复 | Bridge 私有解密 |
| 普通读取的 v1→v2 迁移 | 会写回 | 会写回 | 会写回 | P0 禁止 Bridge 触发 |
| 无迁移官方读取入口 | 未发现 | 未发现 | 未发现 | `NOT_AVAILABLE` |
| Start Plan 家族材料 | 仅套餐家族材料 | 仅套餐家族材料 | `loadStartPlanMaterial` | Bridge 私有 fallback |
| `zai_cn → bigmodel` | 无统一映射 | 无统一映射 | 官方统一映射 | 未验证 |
| Start request auth | 家族 `zcodejwttoken` | 家族 `zcodejwttoken` | 专用 `loadStartPlanZcodeJwt(family)` | Bridge Private Lease |
| Coding Plan request auth | 官方组合 | 官方组合 | 官方组合 | 已复用 Official Host |
| device identity | 官方 telemetry | 官方 telemetry | 官方 telemetry | Bridge 私有文件读取 |

表中 `3.18.0`、`3.18.1`、`3.18.2` 的源码能力不能直接推导 Desktop 运行矩阵为 PASS。

## 最小官方边界

建议 Host 对外提供：

```ts
interface OfficialStartPlanAuthentication {
  accountIdentity: string;
  sessionRevision: string | null;
  requestCredential: string;
  credentialExpiresAt: number | null;
  deviceMid: string;
}

resolveStartPlanAuthentication(input: {
  family: "bigmodel";
  signal: AbortSignal;
}): Promise<OfficialStartPlanAuthentication | null>;
```

边界要求：

- `requestCredential` 是当前官方共享 JWT，只用于 Billing 和现有 Private Lease；
- 不返回 access token、refresh token、Cookie、keyring key、密文或 credential file path；
- Host 内部可以读取完整的 `OAuthStartPlanMaterial`，Bridge 只收到投影字段；
- 返回 `sessionRevision`，用于同一 Task 内检测账户切换；
- 读取与导出不使用环境变量重定向官方 data root；
- 取消、损坏、身份冲突、过期且不可刷新时返回 null。

Host 内部推荐组合：

```text
official read-only credential adapter
  -> official cipher decrypt
  -> official OAuthCredentialRepo.loadStartPlanMaterial
  -> official device identity access
  -> transient Host result
```

禁止的替代：

```text
Bridge source
  -> AES-GCM
  -> @napi-rs/keyring
  -> oauth:* parsing
```

如果官方未来提供正式的无迁移 snapshot / material API，应删除上述 Host 适配层并直接消费官方入口。

## 为什么 Coding Plan 能复用，Start Plan 不能

Coding Plan 的装配点已经是 Official Host，官方工厂能从官方凭据得出 Project Token。Start Plan 的 entitlement preflight 历史早于这条 Host 接线，一直保留在 Bridge；后续 `enc:v2` 兼容也自然被加到 Bridge 私有 reader，而不是官方 repo。

这不是套餐协议要求的分叉。3.18.2 证明 Start 与 Coding 可以共享登录主体和 credential store，只是在 request auth 上：

- Start 使用共享 `zcodejwttoken`；
- Coding/Team 使用家族 OAuth/API key/Project Token 流程。

两条 request auth 投影不同，认证源头仍应共用官方模块。

## 固定 Host 方案比较

| 方案 | 内容 | 优点 | 代价 / 风险 | 结论 |
|---|---|---|---|---|
| A. 更新到 3.18.2 固定 Host | rebase 三项 Bridge upstream patch，暴露窄 Start auth | 使用正式 `loadStartPlanMaterial`、`zai_cn` 和共享 JWT 语义；无长期身份逻辑回移 | 需要重建 Host/AppServer/BOM、native/helper、许可与完整回归 | **ADR-037 首选目标** |
| B. 保留 3.18.0，回移 3.18.2 官方片段 | 将 repo/material/family/request-auth 的 exact upstream diff 进 Host patch | 制品变化较小；可快速合成验证 | 持续维护非上游 backport；后续官方修复仍会漂移 | 仅作显式临时研究 |
| C. 扩展现有 Bridge 私有解密 | 继续在 `start-plan-production-auth.ts` 处理 v2、identity、device | 看似改动最短 | 直接违反新架构要求，维护两条认证链 | **REJECTED** |
| D. 依赖用户 Desktop Main/安装目录运行时模块 | 调 Desktop 内部文件或进程 | 不必打包 | 违反固定制品和 Desktop Main 独立性 | **REJECTED** |

ADR-037 选择 A 作为正式目标。B 必须另立 ADR，不能以“兼容补丁”为名静默成为长期架构。

## Windows OS Keyring 与进程边界

固定 Windows x64 制品实际包含 `@napi-rs/keyring` 2.1.2 wrapper、Windows x64 Node-API binding 及许可文件。官方 `systemCredentialCipher.ts` 使用固定 service `ZCode Credential Encryption`，account 是规范化 `credentials.json` 绝对路径的 SHA-256，并通过 `AsyncEntry.getPassword()` / `setPassword()` 读取或写入系统密钥。

官方 3.18.2 的 Desktop 进程契约是：

```text
Desktop Main
  -> owns createSystemCredentialCipher()
  -> utility Host / bundled CLI send CredentialCipherRequest over the private channel
  -> Main binds the channel to the Main-selected credentials path
```

这条私有通道只解决官方 Desktop 内部进程委派。官方 `CONTRACT.md` 同时规定，Standalone CLI 和独立 Server 不经过 Desktop Main，而是作为本机 credential owner 直接使用同一 cipher/keyring 契约。Bridge Worker 是与 Desktop 分离的独立进程，不能取得 Desktop Main 已经建立的 utility-process channel；若新增 IPC 去借用它，会违反 ADR-032/ADR-037。

2026-11-13 使用固定制品内的官方 keyring 模块做了独立 Node 进程只读探针：同一 Windows 用户下成功读取到 32-byte key，`D:\Program Files\.zcode\v2\credentials.json` 的 `zcodejwttoken` 为 `enc:v2:os` 且密文 fingerprint 与 keyring key 一致。探针只输出布尔值和 fingerprint，不输出 key、JWT 或用户资料，进程退出时不继续持有密钥。这证明“独立 Bridge 进程在技术上可访问 Windows Credential Manager”，也证明桌面 Main 的进程隔离是官方 Desktop 的应用边界，不是操作系统禁止其他同用户进程读取。

该能力不改变架构所有权：

- Bridge source 仍不得直接导入 keyring、解密 v2 或解析账户；
- 目标 Official Host 作为独立进程的 local credential owner 可以使用官方 cipher/repo，但必须提供只读路径；
- 若未来要求严格复刻 Desktop Main 独占边界，只能在新的 ADR 中设计官方 Host→Main 协调；本轮不新增 Companion、IPC 或服务进程；
- 同用户可访问不等于多账户、多 Worker、锁屏、凭据轮换、数据根复制或跨机器迁移已经安全。上述组合继续保持 `NOT_VERIFIED`。

## 只读兼容问题

3.18.2 `credentialService.ts` 的 `readCurrent()` 会在任一值满足 `needsMigration` 时取得 mutation lock、迁移整份容器并写回。Bridge 读取 v1 时调用该普通入口会改变生产凭据，违反 P0 Addendum。

现状：

- 官方存在 `createSystemCredentialCipher()` 的 decrypt 能力；
- `OAuthCredentialRepo` 在加载时又要求 Host 私有 `loadMany()`；
- 官方没有现成的只读 `CredentialService` 构造器；
- 3.18.2 `createSystemCredentialCipher().decrypt()` 在未钉住 source 但存在 v2:os 时仍可能补写 `credential-source`。

因此 POC 必须验证一个更严格的 Host 路径：

1. 只读取 `credentials.json` 快照和必要的 source/sidecar；
2. 所有 per-value 解密继续调用官方 cipher 或经官方新增的 read-only API；
3. 不调用 `migrateCredentialRecord()`；
4. 不调用 keyring `set`，不写 source marker、secret 或容器；
5. 通过注入式 `loadMany()` 将解密快照交给官方 `OAuthCredentialRepo`；
6. 如果官方 repo 在读损坏数据时尝试清理，Host 包装层将它变成 fail-closed，而不是写操作。

这里需要一个新 ADR 或 Host API 评审来确认“只读 adapter”是否足够窄。不能把这段逻辑放回 Bridge。

## 生命周期分配

| 事实 | Owner |
|---|---|
| 登录入口、credential format、keyring、OAuth profile、账户切换 | Official Host |
| Start / Coding 家族映射和请求认证投影 | Official Host |
| Task Admission、Workspace、Attempt、Claim、generation | Bridge |
| 单次任务权威 Billing verdict | Bridge + ADR-030 |
| Private Lease/HANDLE/ACK、secret redaction | Bridge |
| AppServer、工具、模型请求 | Official AppServer |
| Result、Events/Usage、Hold、Recovery、Cleanup、Release | Bridge Authority |

官方 Host 认证成功不能作为 Task entitlement、Result、Cleanup 或 Release 的替代证据。

## Bridge 删除清单

在目标实现完成后应删除：

1. `start-plan-production-auth.ts` 内 AES-GCM、legacy key candidate、v2 fingerprint/source 解析；
2. `@napi-rs/keyring` 的 Bridge 加载、文件 hash 与 service/account 计算；
3. `credential-secret` / `credential-source` 私有发现与缓存；
4. `oauth:active_provider`、`oauth:*:user_info`、`oauth:linked_bigmodel` parser；
5. JWT payload / `exp` 私有解析；
6. `telemetry-state.json` 的私有 device identity parser；
7. 与官方 repo 重复的 account fallback 和登录家族选择。

保留：

- `StartPlanBillingEntitlement` 的请求、一次 GET、脱敏和 verdict 分类；
- `PrivateCredentialLease` 与 private channel；
- exact Worker identity、Claim/Attempt/generation；
- Billing 只对 entitlement 负责，不推导 auth 或 account。

## Magpie 对照

Magpie 0.1.55–0.1.61 与未合并 PR #956 只作为故障和第三方行为案例：

- 自行读取 `enc:v1`；
- 用硬编码版本和请求头构造私有的 Start Plan 请求；
- 用逐字节 Prompt 复刻规避风控。

其 `dress()`、固定 `X-ZCode-App-Version`、伪造 `X-Title` / `x-query-id` / `x-session-id` 等做法不得移植。官方 AppServer 继续拥有模型请求形状。

Magpie 的案例说明私有认证/请求链会随官方版本快速漂移，不能作为本架构权威。

## 3.18.x 兼容矩阵

下表中的 PASS 是后续验收目标，不是当前结论。

| 场景 | Desktop 3.18.0 | Desktop 3.18.1 | Desktop 3.18.2 |
|---|---|---|---|
| Desktop metadata 读取 | `NOT_VERIFIED` | `NOT_VERIFIED` | `NOT_VERIFIED` |
| Desktop Main / Host credential 边界 | `NOT_VERIFIED` | `NOT_VERIFIED` | `NOT_VERIFIED` |
| `enc:v1` 只读兼容 | `NOT_VERIFIED` | `NOT_VERIFIED` | `NOT_VERIFIED` |
| `enc:v2:os` 只读兼容 | `NOT_VERIFIED` | `NOT_VERIFIED` | `NOT_VERIFIED` |
| `enc:v2:env` 只读兼容 | `NOT_VERIFIED` | `NOT_VERIFIED` | `NOT_VERIFIED` |
| BigModel Start identity | `NOT_VERIFIED` | `NOT_VERIFIED` | `NOT_VERIFIED` |
| 已关联 `zai` Start identity | `NOT_VERIFIED` | `NOT_VERIFIED` | `NOT_VERIFIED` |
| 未关联 `zai_cn → bigmodel` | `NOT_VERIFIED` | `NOT_VERIFIED` | `NOT_VERIFIED` |
| 账户注销、切换与凭据不可用 | `NOT_VERIFIED` | `NOT_VERIFIED` | `NOT_VERIFIED` |
| 同 profile 多 Worker 并发 | `NOT_VERIFIED` | `NOT_VERIFIED` | `NOT_VERIFIED` |
| Coding Plan 回归 | `NOT_VERIFIED` | `NOT_VERIFIED` | `NOT_VERIFIED` |
| Official Host 生命周期 | `NOT_VERIFIED` | `NOT_VERIFIED` | `NOT_VERIFIED` |
| R7 Events / Usage | `NOT_VERIFIED` | `NOT_VERIFIED` | `NOT_VERIFIED` |
| SQLite Cleanup / Release | `NOT_VERIFIED` | `NOT_VERIFIED` | `NOT_VERIFIED` |

当前本机只读版本观察为：

- Desktop 安装：3.18.2，build commit `2681f4af`；
- 安装 `resources/glm/zcode.cjs --version`：`0.17.1`；
- Bridge 固定 Official Host：ZCode 3.18.0 / `b95ebaff`，AppServer `0.17.1`。

这些值不能互相替代。

## 已核实、未运行与未知

### 已核实

- 当前 Host 只有四个导出的能力，没有 Start material API；
- Coding Plan 通过 Official Host factory 使用官方 credential/repo/refresh；
- Start Plan 通过 Bridge 私有 credential reader 和 identity parser；
- 3.18.2 源码增加 `loadStartPlanMaterial`、共享 JWT request auth 和 `zai_cn → bigmodel`；
- 3.18.1 与 3.18.2 的相关认证差异可由 exact commit diff 追踪；
- ordinary `CredentialService.load()` 存在 v1→v2 写时迁移；
- 独立 Node 进程可通过固定制品内的官方 keyring 模块读取同用户 Windows Credential Manager 条目，并匹配实际 `enc:v2:os` 密文 fingerprint；
- 官方 Desktop 采用 Main 独占 keyring、utility Host 经私有通道请求加解密；Standalone CLI/Server 作为本机 credential owner；
- 官方 Provider Registry 在 3.18.0→3.18.2 保持 revision 44 且规则无变化；
- Billing、AppServer command surface 和 R7/SQLite 的现有合同没有由本研究改写。

### 未运行

- 3.18.2 固定 Host/AppServer 构建；
- 新 Host 认证边界 POC；
- 真实 OAuth、refresh、Start Plan、Billing 或模型请求；
- Desktop 3.18.0/3.18.1/3.18.2 安装矩阵；
- Desktop Main→Host 私有 credential 通道与 Bridge 独立 owner 的差分运行；
- v1/v2 真实存储只读字节不变验证的新实现；
- 同 profile 多 Worker、账户切换、注销、锁屏和 keyring 不可用组合；
- 官方 Host 升级/回滚、BOM、许可和资源闭包；
- Coding Plan 在三个 Desktop 版本上的真实回归。

### 未知

- 官方是否会在后续版本提供正式 read-only credential snapshot；
- Host read-only adapter 是否能在不复制身份逻辑的前提下覆盖全部损坏和 sidecar 边界；
- 3.18.2 固定 Host 是否与三个 Desktop 数据版本在所有组合上兼容；
- `zai_cn` 真实账户的身份、切换和 mutation 行为；
- Billing 源码少 `mid` query 与实机需要 `mid` 的差异原因。

## POC-1 成功与停止门槛

成功门槛：

- Host 方法通过官方 repo 解析 `bigmodel`、linked `zai`、unlinked `zai_cn`；
- Bridge 不再链接私有 decrypt/keyring/profile parser；
- v1 与 v2 隔离样本读取前后字节、source marker、secret 文件和 keyring 写入计数均不变；
- 过期 JWT 的合成 refresh 只调用一次且经 ADR-033；
- Billing 与 request auth 使用同一 account/session/credential generation；
- 每 Task 一次 verdict，Lease 绑定不可跨 Attempt；
- 失败全部 fail closed，不重试 unknown acceptance。

停止门槛：

- 需要 Bridge 解密密文或读取 keyring；
- 必须触发 v1→v2 生产迁移才能读；
- 认证结果无法与账户/session 切换隔离；
- fixed Host 版本只能用未记录的 Desktop 运行时模块补齐；
- 无法证明 sidecar/keyring 无写入；
- 改动扩张到 Companion、共享 AppServer Pool、第二 Task Authority 或新 Recovery。
