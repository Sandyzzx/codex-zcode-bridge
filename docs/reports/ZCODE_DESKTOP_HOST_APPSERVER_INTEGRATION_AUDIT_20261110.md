# ZCode Desktop Host to AppServer Integration Audit

> Status: RESEARCH
> Last updated: 2026-11-10
> Last verified: 2026-11-10，核对已安装 ZCode Desktop 3.17.2.9661、AppServer 0.17.1、官方公开源码 a9fe401e、Magpie 042e8517 与 Bridge 61c78b7c 的启动、RPC、Prompt、Tool、身份和请求序列化边界。
> Verified against: Bridge `61c78b7c637432d3d39768c48030609d6dbf253a`

## 结论

本次只读审计支持暂停原先的 Desktop 请求兼容模块实施。

- Prompt Composer、最终 System Prompt、Tool 注册与 Anthropic Tool 序列化、请求 attribution、Anthropic `metadata.user_id` 和实际 HTTP 请求构造均由官方 AppServer 负责。
- Desktop Host 没有在 RPC 中提交完整的最终 HTTP 请求。它提供官方启动上下文，包括 `--surface desktop`、ZCode 产品版本/构建身份、会话与工作区环境，以及面向桌面 UI 的 V4 命令/事件协议。
- Bridge 当前公开启动参数只有 `app-server --stdio`，且子进程环境白名单不保留 `ZCODE_APP_VERSION` 或 `ZCODE_BUILD_COMMIT_ID`。这构成已确认的 Host 接线差异。
- Magpie 的 `dress()`、三 System Block 重建、cache-control 改写、`queryOf()`、`sessionOf()`、固定的 Desktop headers 与 Tool 数量对齐，都是对 AppServer 已负责行为的独立重建。不得直接移植到 Bridge。
- 已安装 Desktop 和 Bridge 使用相同 Provider、模型与 endpoint family，但现有证据没有隔离出 HTTP 405 / Provider code 3012 的单一致因。`ROOT_CAUSE: UNCONFIRMED`。

因此，最小候选方向是补齐官方 Host 启动输入，而不是复制 AppServer 请求层。

## 范围与证据等级

本报告明确区分：

- **INSTALLED_RUNTIME**：当前安装 ZCode Desktop/AppServer 的直接观测。
- **OFFICIAL_PUBLIC_SOURCE**：本地只读克隆的官方公开源码。
- **MAGPIE_SOURCE**：Magpie 当前公开插件源码。
- **BRIDGE_SOURCE**：Bridge 当前审计基线。
- **INHERITED_HISTORICAL**：此前 Desktop/Bridge A/B 调查留下的历史证据。
- **NOT_RUN**：本轮没有执行的行为。

公开源码 HEAD 与安装产物版本不能默认视为完全一致。下表用安装运行时确认版本和关键行为，用公开源码定位实现语义；没有把公开源码当作安装版的逐字节证明。

## 运行时与源码基线

| 项目 | 观测值 | 等级 |
|---|---|---|
| ZCode Desktop | `3.17.2.9661` | INSTALLED_RUNTIME |
| Desktop executable | `C:\Users\Sandy\AppData\Local\Programs\ZCode\ZCode.exe` | INSTALLED_RUNTIME |
| Desktop executable SHA-256 | `7ACA3AEAB3D3B775A39CF9CBE048B30A80278D3527B6FBCFD0E7B00F79A2C326` | INSTALLED_RUNTIME |
| AppServer bundle | `C:\Users\Sandy\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs` | INSTALLED_RUNTIME |
| AppServer bundle SHA-256 | `D9AFD58D694F98A5279BF548CDC7646413C125762E86730605A6071F9E0346D6` | INSTALLED_RUNTIME |
| AppServer version | `0.17.1` | INSTALLED_RUNTIME |
| 官方公开源码 | `.run\zcode-official-source-20261110`，HEAD `a9fe401eede6e6e5e01be9048679c206fe6f02d9`，clean | OFFICIAL_PUBLIC_SOURCE |
| Magpie 公开源码 | `.run\magpie-plugins-source-20261110`，HEAD `042e8517b43174dca1214ddb296420a67a4b8fb8`，clean | MAGPIE_SOURCE |
| Bridge 审计基线 | `61c78b7c637432d3d39768c48030609d6dbf253a` | BRIDGE_SOURCE |

安装 Desktop Host bundle 中可直接观察到 `applyPresentationSurfaceToCommand`：当
`presentationSurface === "desktop"` 时，它会移除旧 `--surface` 参数并追加
`--surface desktop`。对应公开源码为
`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:488-513`。

CLI 将 `desktop` 规范化为 `zcode_desktop`：

- `apps/zcode-cli/packages/cli/src/run.ts:165-168`
- `apps/zcode-cli/packages/cli/src/run.ts:386-406`

该 surface 值进入 ContextBuilder 后只增加 Desktop Dynamic Context section：

- `apps/zcode-cli/packages/core/src/context/builder.ts:132-142`
- `apps/zcode-cli/packages/core/src/context/sections/desktop.ts`

没有证据表明 `--surface desktop` 本身选择 HTTP method、认证方式、Anthropic 序列化或 attribution headers。

## Desktop Host 实际提供的输入

### 1. 启动与 Surface

Desktop Host 启动 AppServer 时保留 `app-server --stdio`，并追加
`--surface desktop`。Bridge 当前启动参数没有 surface：

- `src/adapters/zcode-app-server-adapter.ts:1326`
- `src/runtime/model-settings.ts:324`

`--surface desktop` 是官方支持的启动输入，不是通过编辑请求头伪造 Desktop 身份。

### 2. 产品版本与构建身份

Desktop Host 向 host/agent 环境提供：

- `ZCODE_APP_VERSION=ZCODE_VERSION`
- `ZCODE_BUILD_COMMIT_ID=ZCODE_COMMIT`

证据：

- `packages/desktop/src/main/desktopRuntimeEnv.ts:571-588`

AppServer 的 source headers 从该环境读取版本：

- `User-Agent: ZCode/<appVersion>`
- `X-ZCode-App-Version: <appVersion>`
- `X-Title: Z Code@electron`（app-server 的 source title）

证据：

- `apps/zcode-cli/packages/bootstrap/src/model-config.ts:54-75`

Bridge 当前只构造最小 OS 环境，再只追加 Bridge/ZCode provider 数据路径：

- `src/runtime/child-env.ts:1-55`
- `src/runtime/model-settings.ts:307-320`
- `src/adapters/zcode-app-server-adapter.ts:2480-2490`

因此 Bridge 启动的 AppServer 退回自身 CLI 版本身份。与此前历史 A/B 观测到的
Desktop `3.17.2` 和 Bridge `0.17.1` family 差异一致。

这是 Host 环境差异，不证明它是 405 的原因。后续若实施，版本值必须从已验证的安装元数据取得，不能硬编码 `3.17.2`。

### 3. 会话、工作区与 UI 协议

官方 Desktop 的普通无附件发送走 V4 `sendText`：

- `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:389-479`

V4 新建会话使用 `createSession`：

- `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:1755-1810`

V4 命令最终由 agent service 转交 AppServer：

- `packages/services/src/zcode-agent/zcodeAgentService.ts:6660-6795`

Bridge 当前仍使用 legacy RPC：

- `session/create`
- `session/setModel`
- `session/subscribe`
- `session/send`

证据：

- `src/adapters/zcode-app-server-adapter.ts:721-910`
- `src/runtime/model-settings.ts:175`

官方源码显示部分附件发送路径仍保留 `session/send`，因此 legacy RPC 不是已证实的故障。Desktop 使用 V4 是已确认的 RPC 差异，但现有证据没有把该差异与 HTTP 405 建立因果。

## AppServer 已实现、Bridge 不应重复的行为

### Prompt Composer 与最终 System Prompt

AppServer 的 `ContextBuilder` 组装 system sections，并固定为：

1. CLI prefix；
2. stable body，带 ephemeral cache；
3. dynamic system content，带前导 `\n\n` 和 ephemeral cache。

证据：

- `apps/zcode-cli/packages/core/src/context/builder.ts:120-281`

Magpie 在 `packages/zcode/index.mjs:2609-2665` 重新构造三块系统文本。这复制了 AppServer 的职责，并与私有 Prompt 快照耦合。Bridge 不应实现第二个 Prompt Composer。

### Cache Control

AppServer 在 `provider-request-messages.ts` 清理非 system message 的旧 cache marker，并在请求上下文的最新非 system message 上设置 ephemeral cache：

- `apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts:502-543`

Magpie 的 `dress()` 再次移动 message/tool cache marker。Bridge 不应改写 AppServer 生成的 cache position。

### Tool Builder 与 Tool 序列化

Tool 定义、MCP 注册、provider-specific tool conversion 和 Anthropic messages tool 字段都在 AppServer/runtime 内完成。Desktop 暴露 56 个 Tool、Bridge 历史请求暴露 42 个 Tool，只能证明能力集合不同，不能证明数量必须一致，也不能证明 Tool 数量导致 405。

Bridge 应继续注册自身需要的 MCP tools，不通过增加 Tool 数量复制 Desktop UI。

### Attribution 与 Query Identity

AppServer 生成以下 request attribution headers：

- `x-request-id`
- `x-zcode-session-type`
- `x-zcode-trace-id`
- `x-query-id`（条件存在）
- `x-zcode-query-source`
- `x-session-id`（条件存在）

证据：

- `apps/zcode-cli/packages/adapters/src/model/runner-attribution.ts`

Magpie 的 `queryOf()`、`sessionOf()` 和硬编码 attribution headers 是独立重建。Bridge 不应重复生成 Session/Query identity。

### Anthropic Metadata

AppServer 构造 `metadata.user_id`：

```json
{"device_id":"<runtime device id>","account_uuid":"","session_id":"<runtime session>"}
```

证据：

- `apps/zcode-cli/packages/adapters/src/model/anthropic-request-metadata.ts`

Device identity 由官方 runtime 提供。Bridge 不得伪造或替换 Device ID。

### HTTP Serialization 与 Transport

HTTP endpoint、method、认证注入、streaming、SSE、anthropic headers、metadata 和 request body 由 AppServer/provider transport 负责。Bridge 的职责是提供官方运行时所需的 host inputs、runtime auth 与生命周期边界。

Magpie 的 `dress()`、`startHeaders()`、固定 `ZCode/3.17.2` 和 `ZCode@electron` 构造属于应用到已有 AppServer 请求之外的网关兼容层，不是 Bridge 当前架构应移植的模块。

## Bridge 现有边界

以下边界保持有效：

- Unified Account Snapshot 与 ADR-031 Model Routing。
- Start Plan live entitlement gate。
- `provider/updateAccountConfig` 的注册前置条件。
- Private Credential Lease 与 HANDLE 身份门禁。
- `interaction/requestProviderRuntimeHeaders` 的 runtime auth 回调。
- SQLite Result、Cleanup、Recovery、Release 生命周期。

证据：

- `src/adapters/zcode-app-server-adapter.ts:662-716`
- `src/adapters/zcode-app-server-adapter.ts:1710-1722`

本次审计没有发现应改变上述合同的理由。

## Reconciliation Table

| IMPLEMENTATION_MODULE | CURRENT_IMPLEMENTATION_STATUS | OFFICIAL_APPSERVER_ALREADY_HANDLES | DESKTOP_HOST_INPUT_REQUIRED | DECISION | REASON |
|---|---|---|---|---|---|
| AppServer launch / presentation surface | Bridge 以 `app-server --stdio` 启动，未传 surface | CLI 接受官方 `--surface desktop` 并切换 `zcode_desktop` context | 是：`--surface desktop` | MODIFY | 这是官方支持且可隔离的最小 Host 兼容输入 |
| App product version / build identity | Bridge 子进程环境过滤掉两个官方变量 | 从 `ZCODE_APP_VERSION` 构造 UA/source headers | 是：官方 Desktop 版本与构建身份 | MODIFY | 避免退回 CLI 版本身份；必须从安装元数据派生，不得硬编码 |
| Header Adapter | 未实现；原计划复制 Desktop headers | 是：source headers、attribution、auth injection 均由 AppServer 生成 | 仅需上述官方环境输入 | REMOVE | 独立 Header Adapter 会重复并可能覆盖 AppServer |
| System Prompt Composer | 未实现 | 是：三 system block、Desktop dynamic section、cache marker | 仅需 `--surface desktop` | REMOVE | 二次 compose 会产生版本漂移和私有 Prompt 复制 |
| Message Serializer | 未实现 | 是：Messages/tool/cache/streaming 序列化由 AppServer 完成 | 否 | REMOVE | Bridge 不应解析或重写 AppServer request body |
| Identity Adapter | 未实现 | 是：request/trace/session/query attribution 与 metadata 由 AppServer 生成 | 否；Device ID 继续由官方 runtime 提供 | REMOVE | 独立 identity 生成会制造第二事实源 |
| Cache Compatibility | 未实现 | 是：System 与 latest non-system cache position | 否 | REMOVE | Magpie 的 cache 改写不是必要 Host 兼容层 |
| Tool inventory parity | 未实现 | 是：Tool build、MCP 注册和 provider tool serialization | 否 | REMOVE | 56 对 42 的差异没有故障因果；不得为对齐而扩充 Tool |
| Runtime Auth / Private Lease / HANDLE | 已存在并有回归 | AppServer 发起 `interaction/requestProviderRuntimeHeaders`；Bridge 提供受控认证结果 | 是：现有 Host callback | KEEP | 这是 Bridge 的正确职责和 Start Plan 安全边界 |
| Start Plan provider registration | 已存在并有回归 | AppServer 消费 `provider/updateAccountConfig` | 是：已注册的 account provider snapshot | KEEP | 注册前置条件与 fail-closed 语义保持 |
| Session create/setModel/subscribe/send RPC | 已存在，使用 legacy RPC | AppServer 同时支持当前 RPC 路径；Desktop 主路径使用 V4 | 否，当前无证据要求切换 | KEEP | 没有把 RPC 差异与 405 建立因果；V4 migration 需独立决策 |
| Golden full-request fixtures | 未创建；仅有历史脱敏 A/B 证据 | AppServer 才拥有最终请求体 | 否 | REPLACE | 用小型 argv/env Host contract tests 替代复制完整 AppServer payload |
| Start Plan concurrency / 3012 cooldown | 未实现 | AppServer 不提供 Magpie 式网关冷却；当前 3012 因果未知 | 否 | REMOVE | 不应在无证据时增加第二套限流/分类系统 |
| Desktop V4 createSession/sendText migration | 未实现 | 支持 V4，但当前 legacy RPC 仍被兼容 | 协议级 Host 选择，不是本次最小修复 | KEEP for later decision | 需要独立兼容性决策与回归，不能与 surface 修复捆绑猜测 |

## 实施暂停盘点

审计 Worktree 开始时为 clean，HEAD 为
`61c78b7c637432d3d39768c48030609d6dbf253a`。本 Worktree 中未发现此前 Start Plan
Desktop 请求兼容任务的已完成生产模块、Golden Fixture 或新增测试文件；没有可列为
“已完成实现”的源码修改。

本次保留下来的已完成工作只有：

- 官方安装产物、公开源码和 Magpie 源码的只读研究；
- 历史 A/B 调查结论，位于主工作区未跟踪文件
  `docs/reports/STARTPLAN_DESKTOP_BRIDGE_AB_COMPARISON_20261110.md`；
- 本审计报告。

主工作区既有 WIP 原样保留，未暂存、未覆盖、未清理：

- `M .gitignore`
- `M test/helpers.ts`
- `M test/test-impact-map.json`
- `?? $null`
- `?? docs/reports/STARTPLAN_DESKTOP_BRIDGE_AB_COMPARISON_20261110.md`
- `?? docs/reports/sqlite-v14-production-upgrade-preflight-20261110.md`

待实施项目均已按上表重新裁决；未删除或改写任何既有实现。

## 历史证据边界

继承的历史 A/B 报告记录：

- Desktop Start Plan `GLM-5.3-Flash` 请求两次 HTTP 200；
- Bridge Gate E2 历史请求 HTTP 405，Provider code `3012`；
- 两者使用相同 account provider、模型和 endpoint family；
- Desktop 请求身份为 `3.17.2`，Bridge 请求身份为 `0.17.1` family；
- Desktop 与 Bridge Tool 数量分别为 56 和 42。

这些是历史运行时证据，不是本轮新执行结果。它们支持“存在 Host 上下文差异”，不支持把 405 归因于 app version、surface、Tool 数量或 RPC 路径。`ROOT_CAUSE` 仍为 `UNCONFIRMED`。

## 最小候选实施计划

只有在 Owner 另行授权后才实施：

1. 在 Bridge 的官方 AppServer 启动路径增加 `--surface desktop`，只对实际 Desktop compatibility 路径生效。
2. 通过可验证的已安装 Desktop 元数据派生官方 app version/build commit，并以显式 host input 注入 AppServer 子进程；禁止硬编码版本或伪造 Device ID。
3. 增加纯合成 argv/env contract tests，证明：
   - surface 恰好出现一次且不吞掉 `--stdio`；
   - app version 来自已验证输入；
   - 缺失元数据时 fail-closed 到 CLI identity，而不是猜值；
   - Coding Plan 行为不变；
   - Runtime Auth、Provider 注册、SQLite 生命周期没有变化。
4. 不修改 Prompt、tools、HTTP body/headers、session/query identity、Billing、Private Lease、HANDLE 或 SQLite。
5. 将 legacy RPC 到 V4 `createSession`/`sendText` 的迁移留给独立决策；除非新的官方/运行时证据证明当前兼容路径已失效。

该计划不能保证修复历史 HTTP 405。它只消除已确认的 Host 启动输入差异，并保持最小、可逆、可合成验证。

## 未运行与未知

- 本轮没有启动 Bridge，也没有发送 OAuth、Billing、Claim、Provider、Tool 或模型请求。
- 没有重新执行历史 Desktop 探测。
- 没有做逐字节安装版 AppServer 与公开源码 diff。
- 没有运行端到端网络抓包或 header/body equality 测试。
- 没有证明 `--surface desktop` 或 app version 能修复 405。
- 没有证明 legacy RPC 与 V4 RPC 在当前 Provider 上产生不同 HTTP 结果。
- 没有完成 Astra 独立审计。

## 最终状态

```yaml
IMPLEMENTATION_PAUSED: YES
WORKTREE_PRESERVED: YES
COMPLETED_WORK_RECORDED: YES
OFFICIAL_HOST_AUDIT: PASS
IMPLEMENTATION_RECONCILIATION: PASS

APPSERVER_OWNS_PROMPT_COMPOSER: YES
APPSERVER_OWNS_TOOL_BUILDER: YES
APPSERVER_OWNS_IDENTITY_AND_ATTRIBUTION: YES
APPSERVER_OWNS_HTTP_SERIALIZATION: YES

DESKTOP_SURFACE_INPUT_CONFIRMED: YES
DESKTOP_APP_VERSION_INPUT_CONFIRMED: YES
RPC_V4_DIFFERENCE_CONFIRMED: YES
V4_DIFFERENCE_CAUSALITY_FOR_405: UNCONFIRMED

MAGPIE_REQUEST_REWRITE_NECESSARY: NO_DEMONSTRATED
MINIMAL_CANDIDATE_SCOPE: HOST_ARGV_AND_VERSION_INPUTS
ROOT_CAUSE: UNCONFIRMED

REAL_MODEL_REQUESTS: 0
BILLING_REQUESTS: 0
OAUTH_REQUESTS: 0
PRODUCTION_CODE_MODIFIED: NO
PRODUCTION_CONFIG_MODIFIED: NO
PRODUCTION_SQLITE_MODIFIED: NO
GIT_PUSH: NO
MERGE: NO
RELEASE: NO
```

等待 Owner 的下一项实施裁决。
