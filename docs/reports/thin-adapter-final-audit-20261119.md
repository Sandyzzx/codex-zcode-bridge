# Thin Adapter Final Audit

> Status: RESEARCH
> Date: 2026-11-19
> Branch: `codex/unified-official-appserver-startplan-20261119`
> Baseline: `b022673a006fb191b011514bb26c3885314830a0`
> Baseline tree: `a3f561594cb0a2b599477a7e2a9c5b3d55326fe4`
> Preview parent: `f5390897978be995b3a942feaeaac0170e8849fa`
> Scope: read-only source, build, asset and architecture-contract audit; no production code changed.

## 1. Executive conclusion

**Thin Adapter 化：PARTIAL，尚未完成。**

本分支已经完成一个重要收敛：Coding Plan 与 BigModel Start Plan 通过同一个 `OfficialAppServerWorkerAdapter` 使用本机安装版 ZCode AppServer，并分别执行 `OFFICIAL_DISCOUNT_VERIFIED` 与 `OFFLINE_COMPATIBLE` 能力门禁。Start Plan 认证仍保留独立的 Live Entitlement、Private Credential Lease、Worker-parent authorization 和 secret redaction；没有把 Coding Plan 的优惠或认证结论套用到 Start Plan。

但当前还不能称为完整 Thin Adapter，主要原因不是 SQLite 任务引擎，而是仍存在多个 AppServer 入口和运行时资产来源：

1. `zcode_model_catalog` 仍然自行 spawn AppServer，并实现自己的 JSON-RPC、认证回调和进程清理。
2. 只有 Coding Plan 与 Start Plan 进入安装版 AppServer；其他 Provider 仍走固定打包 AppServer。
3. `ZCodeAppServerAdapter` 仍包含一套 direct AppServer 实现，并作为公共 Core API 导出。
4. Official Host 仍由固定上游源码、三项 Patch、Keyring native closure 和构建制品组成。
5. 浏览器能力仍嵌入通用 Adapter；它是可选功能，但与任务协议耦合。

**重要边界：Thin Adapter 不等于删除 Bridge 自己的任务系统。** 当前没有已验证的 ZCode 官方接口可以替代 Bridge 的持久 Task/Attempt、幂等、Workspace Admission、永久 Claim、Result Commit、Cleanup Proof 和 Release CAS。SQLite Authority、Worker 与必要的进程身份/清理证明应继续保留，不应为减少 LOC 重写或删除。

## 2. 当前实际架构

当前分支相对 `preview` 的状态已核实：`preview` HEAD 为 `f5390897978be995b3a942feaeaac0170e8849fa`；指定分支 HEAD 为 `b022673a006fb191b011514bb26c3885314830a0`，ahead 1 / behind 0。最新提交只增加了 Coding Plan / Start Plan 的统一安装版 Runtime 能力门禁与对应测试/报告。

### 2.1 任务执行

```text
Codex Host / MCP
  -> SqliteLifecycleMcpAuthority
  -> SQLite Lifecycle Gate / Store
  -> one claim-only Worker per Attempt
  -> OfficialHostAdapter
       |-- Coding Plan / Start Plan:
       |     OfficialAppServerWorkerAdapter
       |     -> installed ZCode AppServer + same-root provider config + runtime-host
       |
       |-- other Providers:
             OfficialHostAdapter
             -> packaged ZCode AppServer + packaged provider config
  -> TaskResult
  -> SQLite Result / Cleanup evidence / Release CAS
```

`src/worker/production-adapter-selection.ts` 只把精确 Coding Plan Provider IDs 与精确 `account:bigmodel-start-plan` 选择到安装版 Runtime。其他 Provider 仍使用 `OfficialHostAdapter`。`OfficialHostAdapter` 的固定资产路径来自 `plugins/codex-zcode-bridge/worker/vendor/official-host/...`。

### 2.2 官方资产边界

`OfficialAppServerWorkerAdapter` 复用安装版 AppServer，但仍从插件内固定 Official Host bundle 加载 `ZCodeAgentProcessManager`、`ZCodeProtocolClient` 和官方认证工厂。因此当前准确描述是：

- AppServer 执行制品：Coding Plan / Start Plan 使用已安装官方 Bundle。
- Official Host ProcessManager / Protocol / 部分认证工厂：仍使用固定、版本锁定的官方源码构建制品。
- Start Plan Billing verdict 与 Private Lease：仍由 Bridge 持有，符合 ADR-030 / ADR-037。

## 3. 审计发现

### P0 — 模型目录仍使用第二套 AppServer 启动与认证路径

**状态：确认，优先整改。**

`src/runtime/model-settings.ts` 的 `ZCodeModelSettings.#readLiveCatalog()` 调用本文件内的 `startAppServer()`。该函数直接 spawn `config.zcodeEntrypoint`，自己实现 stdout JSON-RPC framing、pending request、timeout、stderr 收集、close 和进程树终止；它不经过 `OfficialHostAdapter` 的 `ZCodeAgentProcessManager`。

这条路径还通过 `src/runtime/account-provider.ts` 的 `runtimeAuthReply()` 响应 `interaction/requestProviderRuntimeHeaders`，直接读取 Coding Plan API Key。任务执行路径则已经使用 Official Host 的 Provider Runtime Auth 工厂。

影响：

- 模型目录与实际任务执行可能使用不同的 Runtime 选择和版本验证。
- 同一 AppServer 的 ProcessManager、认证、超时和关闭逻辑被维护两次。
- `runtimeAuthReply()` 留下了不应继续存在的 Bridge 侧 Coding Plan 静态认证路径。

**建议：** 提供一个共享的 Official Host Session/Client Factory，供任务执行和模型目录共同使用；模型目录保留现有 MCP 输入/输出、缓存、默认模型配置和 alias 语义，只替换底层 AppServer 装配。完成后移除 model-settings 的直接 spawn/RPC/close 实现及 `runtimeAuthReply()` 的生产调用。不得改变公开 MCP Schema。

### P1 — 安装版 AppServer 尚未成为所有 Provider 的统一运行时

**状态：确认；是否扩大支持范围需要兼容矩阵。**

当前 Worker 选择器只对三个 Coding Plan ID（含兼容别名）和精确 Start Plan ID 使用 `OfficialAppServerWorkerAdapter`。其他 Provider 继续走 `OfficialHostAdapter` 的固定打包 AppServer。

当前插件 Vendor 共 18 个文件、约 46.19 MB。其中：

- 打包 AppServer：31,009,692 bytes。
- Official Host bundle：1,829,872 bytes。
- Browser backend bundle：7,335,238 bytes。
- 其余包括 provider config、官方签名 runtime-host、Keyring native closure、许可和 BOM。

**建议：** 建立 Provider 类别 × Runtime 来源 × Request Security × Auth × Session/Turn 的兼容矩阵。先验证目前支持的其他 Provider 是否可以在同一个已安装 3.18.2 AppServer 上运行。若通过，扩大安装版 Runtime 的选择范围，并评估删除 31 MB 打包 AppServer 与随附 builtin config；若未通过，保留显式、可诊断的兼容路径，不得静默回退或把未验证 Runtime 标为兼容。

这不是直接删除 Vendor 的授权。只有每类现有 Provider 的真实/合成证据足够后，才可移除打包 Runtime。

### P1 — 通用 Adapter 仍保留 direct AppServer 实现，并泄漏到公共 Core API

**状态：确认；可作为第二阶段整改。**

`src/adapters/zcode-app-server-adapter.ts` 当前约 2,985 行 / 142 KB。它包含协议/Session/Turn 适配、Usage 与 Runtime Event 映射、交互、Provider retry、Cleanup，以及 Browser reverse-RPC。其 `#startDirectAppServer()` 位于约 1542–1927 行，是一套独立 direct AppServer 启动实现。

正式 Worker 在 Windows x64 上选择 Official Host Adapter；direct Adapter 主要用于测试/旧行为隔离，但 `src/core.ts` 仍公开导出 `ZCodeAppServerAdapter`，允许外部消费者绕过 Official Host 装配。

**建议：**

- 将 direct AppServer 路径收敛为明确的 test-only harness，不作为生产/公共 Core 的可选执行入口。
- 评估从公共 Core 移除 `ZCodeAppServerAdapter` 导出；若存在外部消费者，先标记弃用并安排 Preview 主版本迁移。
- 保留通用协议映射与 `CodingAgentAdapter` 合同，不重写已验证的 Session/Turn/Interaction/Result/Cleanup 逻辑。

### P1 — Official Host 仍是固定上游源码 + Patch 的维护面

**状态：当前必须保留；长期应上游化。**

`scripts/build-official-host-runtime.mjs` 固定 ZCode 3.18.2 源码提交 `fec975905a2abd4c07e35c40d51fa097a2258ec9`，构建 14 个官方源文件，并重放三项有序 Patch：

- `0001-stdio-max-frame-bytes.patch`：16,482 bytes。
- `0002-oauth-refresh-coordination.patch`：60,872 bytes。
- `0003-read-only-official-start-plan-auth.patch`：51,480 bytes。

构建产物 `official-host-runtime.mjs` 约 1.83 MB，另含官方 Keyring native closure 和签名 Runtime Host。

这些 Patch 当前承载真实的 Frame 限额、OAuth Refresh 并发正确性、只读 Start Plan 认证边界，不能为追求“零 Patch”直接删除。

**建议：** 分别推动三项能力进入 ZCode 上游；每项上游版本有等价接口和回归证据后，单独删除对应 Patch。Bridge 不复制 AES、Keyring、OAuth、账户身份或官方 Request Signing。短期接受固定版本构建，不做第二套 Host 实现。

### P1 — 权威架构文档没有跟上 11 月 19 日分支

**状态：确认。**

当前分支已更新 `docs/ZCODE_RUNTIME.md` 与 ADR-040，但以下文档仍记录较早状态：

- `docs/ARCHITECTURE.md`：Last updated 11-18，仍描述只有 Coding Plan 使用安装版 AppServer，Start Plan 不应用该选择。
- `docs/PROJECT_STATE.md`：Last updated 11-18，仍把 2.0.0-preview.9 描述为旧候选状态。
- `docs/SHARED_CORE.md`：Last updated 11-15。
- `docs/INTERFACES.md`：Last updated 11-16。
- `docs/README.md`：索引仍把安装版 AppServer 描述为 Coding Plan 专用；未区分历史 Start Plan 核心 E2E 与本分支新 Runtime 的真实 Start Plan E2E。

分支交付报告明确记录 Start Plan 真实 Entitlement、真实 E2E、Native A/B 和 Billing Observation 均为 NOT RUN，完整 CI 也 deferred。不能把之前 Start Plan 核心功能路径的历史 PASS 扩大为本次安装版 Runtime E2E PASS。

**建议：** 本次审计结论确定后，按 ADR-040 更新架构、项目状态和文档索引，并明确所有 NOT RUN 项。不要将研究建议直接写成已接受的架构合同。

### P2 — Browser Host 是可选能力，但嵌入通用 Adapter

**状态：确认；不是当前 P0。**

`zcode-app-server-adapter.ts` 内含 Browser reverse-RPC、workspace/session scope 和 Browser cleanup。Browser 默认关闭，后端采用惰性加载，但插件仍分发约 7.34 MB 的 `browser-host.cjs` 和 Playwright registry 资源。

**建议：** 将 Browser Host 作为可选 Adapter Extension 或独立模块，不让它继续扩大通用 AppServer Adapter 的责任面。只有在确认产品仍需要 ZCode Browser RPC 后再决定是否从默认插件分发中拆出；不要在本轮直接删除。

### P2 — 历史迁移与旧版本残留需要单独的数据退役裁决

**状态：部分保留有理由，不应混为旧 JSON 生产链。**

当前仍有：

- SQLite v13 Schema 与 v13→v14 升级路径；
- `upgrade-sqlite-v14` 运维 CLI；
- `json-history-result-exceptions.mjs` 的历史异常清单；
- SQLite Store 对旧迁移表/Artifact 的完整性验证。

这些不等于旧 JSON TaskStore/Manager/Worker 已恢复。当前 Store 仍需要识别并保留既有 v14 历史字节，不能直接删除相关校验。应先盘点实际 Authority 是否还包含 v13 或迁移历史数据，再决定是否退役升级/异常清单。不得通过删除表、重建数据库或丢弃历史数据来达到代码减量。

另外，`upstream/zcode-3.18.0/patches` 仍存在于仓库；当前 Official Host 构建脚本的 Patch Root 已固定为 `upstream/zcode-3.18.2/patches`。3.18.0 Patch 可在全仓引用核对后归档/删除，但它不是当前构建输入。

## 4. 必须保留的最小 Bridge 核心

以下模块承担的是 Bridge 自己的合同，不应作为“重复 ZCode Runtime”删除：

| 职责 | 当前实现 | 结论 |
|---|---|---|
| MCP Host / 工具协议 | `src/host/stdio.ts`、`src/mcp/*` | 永久保留 |
| 单一任务权威、幂等、队列 | `src/manager/sqlite-lifecycle-mcp-authority.ts` | 永久保留 |
| Admission、Launch Intent、Claim、Result、Recovery、Release | `src/store/lifecycle-gate.ts`、`src/sqlite-candidate/wp6b2b1/*` | 永久保留 |
| Worker 私有握手、执行封装、Result/Runtime Event | `src/manager/spawn-worker.ts`、`src/worker/worker-main.ts` | 永久保留 |
| Result canonicalization | `src/result-contract.mjs` | 永久保留 |
| OS identity、进程树与 Cleanup Proof | `src/runtime/process-probe.ts`、`src/adapters/process-spawn.ts`、`src/adapters/windows-process-cleanup.ts` | 保留；只在有等价官方证明时替换 |
| Official Host / AppServer 协议适配 | `src/adapters/official-host-adapter.ts`、`src/adapters/official-app-server-adapter.ts`、`src/adapters/zcode-app-server-adapter.ts` | 保留适配边界；移除重复启动入口 |
| Start Plan Live Billing / Private Lease / HANDLE / ACK / redaction | `src/runtime/start-plan-production-auth.ts`、`start-plan-private-*.ts`、`start-plan-handle-gate.ts` | 按 ADR-030 / ADR-037 保留 |
| Workspace/本地信任/超时 | `src/runtime/trusted-local-*.ts`、`src/runtime/task-timeout.ts` | 永久保留 |

Bridge 仍需独立持有 Task Admission、Workspace 占用、Attempt/Claim、Result 与 Cleanup/Release 事实。Official Host ProcessManager 的正常进程关闭不能单独授权 SQLite Release。生产 Result-less Recovery 目前缺少可消费的 Adapter Cleanup Proof，必须继续保留 Hold，不能把 Fake Adapter 的合成重派能力当成生产能力。

## 5. 目标最小拓扑

```text
Codex Host
  -> MCP / Host Adapter
  -> SQLite Task Authority + Workspace Admission
  -> one Worker / Attempt
  -> Thin ZCode Adapter
       -> Official Host ProcessManager / Protocol / Auth
       -> installed Official AppServer
  -> normalized Result / Usage / Events
  -> Bridge Cleanup Proof + SQLite Release CAS
```

Bridge 不再维护 ZCode AgentRuntime、Provider OAuth、Request Signing、Keyring、模型工具实现或第二套 AppServer ProcessManager。Bridge 只保留 Host/Task 边界适配、必要的 Provider entitlement 投影，以及自己的任务持久性和资源释放证明。

## 6. 建议实施顺序

| 顺序 | 任务 | 预期结果 | 门禁 |
|---|---|---|---|
| 0 | 修正 ARCHITECTURE / PROJECT_STATE / README 文档索引 | 文档与 11-19 代码一致 | docs-only T0 |
| 1 | 统一模型目录与 Official Host ProcessManager | 任务执行与模型目录只剩一套 AppServer 工厂；移除 `runtimeAuthReply` 生产路径 | 定向 + MCP model catalog E2E |
| 2 | 建立全 Provider Runtime 兼容矩阵 | 决定是否可把安装版 AppServer 扩展为默认 Runtime | 每类 Provider 的 registry/auth/session/request-security 测试 |
| 3 | 限制 direct AppServer Adapter | direct path 仅测试使用，Core 不再暴露可绕过 Official Host 的执行入口 | Core API / fork contract tests |
| 4 | 上游化 Official Host Patch | 每项 Patch 在上游具备等价能力后独立删除 | 固定源码重放、Host/Auth/Frame 回归 |
| 5 | Browser 与迁移残留分开退役 | 可选功能与一次性迁移责任不再污染主 Adapter | 功能使用情况、Authority 数据盘点 |

**不建议：** 重写 SQLite Store、Lifecycle Gate 或 Worker；新增 Companion Service；增加第二数据库/第二状态机；把 Start Plan 的 Billing/Lease 与 Coding Plan 合并；在没有兼容证据时删除固定 Runtime 或历史迁移校验。

## 7. 本轮验收与限制

- 分支 HEAD、父提交、Preview HEAD 与 ahead/behind 已核验。
- 已检查源码树、核心 Adapter、Worker、Manager、SQLite Store、Runtime Resolver、模型目录实现、Official Host 构建脚本、Patch 清单和权威文档。
- 本报告是只读架构审计；本轮没有运行测试、CI、模型请求、认证请求、Billing 请求或真实 Start Plan E2E。
- 分支自身的 2026-11-19 统一 Runtime 交付报告记录：typecheck/build/plugin validation 与定向测试通过；真实 Start Plan Entitlement/E2E、Native A/B、Billing Observation 未运行；完整 CI deferred。此为分支交付报告，不是本轮独立复验。

## 8. 最终结论

当前项目已经从“自建 ZCode Runtime + 自建认证 + 自建任务系统”收敛为“官方 Host/AppServer + Bridge 自有 SQLite 任务权威”。但模型目录仍保留第二套 AppServer 启动/认证路径，其他 Provider 仍使用打包 AppServer，通用 Adapter 也保留 direct AppServer 实现。

因此下一项实际代码任务应明确为：

**P0 — Unify Model Catalog with Official Host ProcessManager and Runtime Resolver.**

先完成这项，再决定是否把所有 Provider 迁移到安装版 AppServer。SQLite/Worker 核心不重写，Start Plan 私有授权边界不删除，Official Host Patch 逐项上游化。这条路线能真正减少重复维护面，而不会破坏项目已经建立的任务持久性和工作区安全合同。
