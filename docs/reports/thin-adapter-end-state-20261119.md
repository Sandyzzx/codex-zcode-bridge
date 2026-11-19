# Thin Adapter End-State 收敛报告

> Status: RESEARCH
> Date: 2026-11-20
> Branch: `codex/unified-official-appserver-startplan-20261119`
> Baseline: `5501c60ecf3f1812a3d3170a670ab0031ea784d8`
> ADR-041 implementation: `a676c6cd14573f2620339f992a345ed0715541ff` / tree `4d1b54835d4ebe1e1ae15113d5a152130a98480c`
> Final Closure implementation: `f19ab1d75dcced7613bfe6e12c84d780d01f7127` / tree `dab3db21e5f51eb764ff421ab31901981964c3c2`
> Verification follow-up: same branch, isolated fixture correction, Cost Lab production-runner repair, and current-tree verification
> Final evidence commit: `657849f0c` (Cost Lab failed-result usage preservation)
> Scope: Thin Official Host architecture convergence, dynamic Provider gate, Runtime Auth fail-closed, and local verification

## 1. 结论

本轮在现有分支上依次完成了四个阶段，形成以下候选架构：

```text
Codex Host
  -> Bridge MCP / Host Adapter
  -> SQLite Task Authority
  -> Worker
  -> OfficialAppServerWorkerAdapter
  -> createInstalledOfficialHostSessionFactory
  -> installed Official ZCode AppServer
  -> Result / Cleanup Proof
  -> SQLite Release CAS
```

实现结果：

- Model Catalog 与任务执行共用 Runtime Resolver、Official Host module、ProcessManager、ProtocolClient、Provider Runtime Auth 和 Close 所有权。
- Model Catalog 不再自行 spawn AppServer、实现 JSON-RPC framing、pending request、timeout、进程树清理或持久化 Coding Plan API Key 回包。
- 所有 Provider 统一选择安装版 Official AppServer；Coding Plan 与 Start Plan 仍保留各自独立的能力门禁与认证边界。
- `session/create` 后以 Runtime 实际报告的 Provider/Model 执行最终 capability gate；Coding Plan、Start Plan 与其他 Provider 的分类读取官方 registry 和当前账户配置，并在 send 前 fail closed。
- 生产 Official Host 的 Provider Runtime Auth resolver 缺失或拒绝时只返回不可用，不读取持久化 API Key 回退；静态凭据回包只保留给显式 Test Adapter。
- 打包的 `app-server/zcode.cjs` 与随附 builtin Provider 配置已删除，Plugin Validator 会拒绝其重新进入发布包。
- Direct stdio 只能通过显式 `ZCodeAppServerTestAdapter` 使用，公共 Core 不再导出 `ZCodeAppServerAdapter`，生产 Worker 不存在打包 Runtime fallback。
- 三项 Official Host Patch 仍为 `UPSTREAM_PENDING`，没有把未上游化状态写成完成。

真实执行补充结果：Start Plan 已通过一次隔离的生产链路 code-edit E2E，
Token 用量与官方 token-unit bucket 精确对齐；但其官方接口没有请求级价格账本，
因此 Start Plan 模型倍率仍为 `NOT_VERIFIED`。Coding Plan 当前候选共有
`3` 次独立 dispatch 尝试，发生在约 `01:22`、`01:38` 与 `04:06`
（Asia/Shanghai）。第三次已保留 `turn_started` / `turn_failed` 和
`USAGE_MISSING` Evidence，但官方小时桶仍没有可关联模型行，积分上限保持
`0` / `4129`，因此仍不能证明一次模型 HTTP 请求或计算倍率，结果保留
`INCONCLUSIVE`。
其他 Provider E2E、真实 OAuth refresh、Preview 合并和发布验收仍未完成。

## 2. 阶段 0：基线核验

已核实：

- 分支保持 `codex/unified-official-appserver-startplan-20261119`。
- HEAD 为 `5501c60ecf3f1812a3d3170a670ab0031ea784d8`。
- 起始工作区没有需要丢弃的已提交历史；本 Goal 的变更以未提交 working tree 保留。
- 已阅读 `AGENTS.md`、`docs/PROJECT_STATE.md`、`docs/ARCHITECTURE.md`、`docs/SHARED_CORE.md`、`docs/ZCODE_RUNTIME.md` 和 `docs/reports/thin-adapter-final-audit-20261119.md`。
- 未切换分支、未重置历史、未修改其他 Worktree、Host Wake、Start Plan 或生产 SQLite Authority。

## 3. 阶段 1：统一 Model Catalog 与 Official Host

### 实现

`src/adapters/official-host-adapter.ts` 新增
`createInstalledOfficialHostSessionFactory()`，统一负责：

- 安装版 Runtime Resolver 与 Manifest/资产校验；
- Official Host module 加载；
- `ZCodeAgentProcessManager` 与 `ZCodeProtocolClient` 构造；
- reverse-RPC transport；
- timeout、进程身份和 Close 所有权。

`src/runtime/model-settings.ts` 改为通过该 factory 创建短生命周期 Catalog 会话。原文件内的 `startAppServer()`、JSON-RPC pending map、framing、timeout、stderr 收集和进程树终止实现已删除。Model Catalog 的操作仍由自身拥有，但底层生命周期与任务执行使用同一官方 Host 装配。

`src/runtime/official-provider-runtime-auth.ts` 提取了 Coding Plan 的 Official Provider Runtime Auth resolver。该 resolver 仅接受官方 builtin registry 中分类为 `individual-coding-plan` 且当前请求 entitlement 一致的 Provider；Start Plan 仍返回不可用并继续由 Private Credential Lease 负责。

`src/host/stdio.ts` 将 Host 实际 Worker 入口转换为 Worker-shaped module URL，保证发布包中的 Official Host 资产从 `worker-main.mjs` 所在树解析。

最终审计修复了一个模型未显式指定时的回归：当 ZCode 自行选择 Coding Plan 时，
原 Worker 只会在 Provider 已预先解析的情况下初始化 Official Provider Runtime
Auth。现在 `src/worker/worker-main.ts` 在非 direct Adapter 中按回调实际配置惰性
构造 resolver；Adapter 仍会核对回调的 Provider/Model 与最终 Session 选择。
Final Closure 进一步把 capability 判定移动到 Runtime 报告实际选择之后，并增加
隐式 Coding Plan、隐式 Start Plan、其他 Provider、Coding Plan 未验证和 Start
Plan 非离线兼容的 Adapter 级回归。显式 Provider 既有路径继续由原测试覆盖。

模型列表缓存、默认模型、Provider 识别、Start Plan alias 和 MCP 返回结构未改变。新增 `test/model-settings-official-auth.test.ts` 验证：

- Catalog 使用官方 Provider Runtime Auth factory；
- Start Plan 不通过 Coding Plan runtime-header 路径授权；
- 响应中不出现持久化 Coding Plan API Key。

## 4. 阶段 2：统一 Provider Runtime 与退役打包 AppServer

`src/worker/production-adapter-selection.ts` 现在对所有 Provider 返回 `installed_runtime`，只有精确 Coding Plan 与 Start Plan Provider 分别保留：

- `coding_plan_discount`；
- `start_plan_static`。

Provider 选择不再等同于认证选择。实际认证仍由官方 Provider registry、账户配置、Task entitlement 和 AppServer 自己的 Provider 路径决定。

### Provider 兼容矩阵

| Provider 类型 | Runtime | Auth / Capability | 本地证据 | 真实 E2E |
|---|---|---|---|---|
| Coding Plan | Installed Official AppServer | Official Provider Runtime Auth；要求 `OFFICIAL_DISCOUNT_VERIFIED` | 定向、Provider capability、Model Catalog 合成测试 PASS；历史构建后 Coding Plan E2E PASS | 当前候选三次 dispatch 尝试均无可关联 Usage/积分；第三个 attempt 以 `turn_failed` / `USAGE_MISSING` 结束，`INCONCLUSIVE` |
| Start Plan | Installed Official AppServer | Official Host 只读投影 + Bridge Live Entitlement/Private Lease/HANDLE/ACK；要求 `OFFLINE_COMPATIBLE`，不依赖 Coding Plan discount | 离线 Start Plan、Private Auth 与 capability 测试 PASS | 一次真实 code-edit E2E `PASS`；Token 对账 `PASS`；倍率 `NOT_VERIFIED` |
| Team Coding Plan / 其他 Zhipu account Provider | Installed Official AppServer | 官方 account/provider registry 与现有 account payload；不套用个人 Coding Plan 优惠结论 | 路由与 account payload 定向测试 PASS | `NOT_RUN` |
| 内置或个人 API Key Provider | Installed Official AppServer | 官方 provider personal config / AppServer Provider 实现 | 路由选择 PASS；旧打包配置已移除 | `NOT_RUN` |
| 自定义 Provider | Installed Official AppServer | 官方 provider 配置；缺失、不兼容或未知时由官方 AppServer 或 Runtime gate fail closed | 路由选择 PASS；不静默回退打包 Runtime | `NOT_RUN` |

对安装版
`resources/config/provider/zcode-builtin.json`（revision 44，261,659 bytes，SHA-256
`EF3D64656CB5281CCE292B77EF12E96B5251582CFB00CDF9EB08E3D4565ABB69`）
的只读盘点得到 10 个 `zhipu-account` Provider：

| 官方 Provider IDs | Runtime 路由 | 认证 / 权益边界 |
|---|---|---|
| `account:bigmodel-individual-coding-plan` | `coding_plan_discount` | 官方 OAuth Provider Runtime Auth；要求 `OFFICIAL_DISCOUNT_VERIFIED` |
| `account:bigmodel-start-plan` | `start_plan_static` | Bridge Live Entitlement / Private Lease / HANDLE / ACK；不读取 Coding Plan 折扣字段 |
| `account:zai-individual-coding-plan`、`account:zai-team-coding-plan`、`account:bigmodel-team-coding-plan` | `installed_runtime` | 官方 account/provider registry；不继承个人 Coding Plan 优惠结论 |
| `account:zai-start-plan` | `installed_runtime` | 官方 account/provider registry；不是当前 Bridge BigModel Start Plan Private Lease 路径 |
| `account:zai-offpeak-idle-plan`、`account:bigmodel-offpeak-idle-plan` | `installed_runtime` | 官方 account/provider registry |
| `account:zai-highspeed-card`、`account:bigmodel-highspeed-card` | `installed_runtime` | 官方 account/provider registry |

API Key、内置非账户 Provider 与自定义 Provider 不在上述 10 项账户 registry 内；
它们同样只能进入安装版 AppServer。该静态盘点证明选择器没有漏掉已安装 registry
条目，但不替代每类 Provider 的真实认证、模型请求和账单 E2E，后者仍为 `NOT_RUN`。

因此当前准确状态是 `OFFLINE_ROUTED / LIVE NOT RUN`，不能把静态路由测试扩大为所有 Provider 的真实兼容认证。

### 删除的重复 Runtime

已删除：

- `plugins/codex-zcode-bridge/worker/vendor/official-host/win32-x64-node24.16.0-zcode3.18.2-fec97590/app-server/zcode.cjs`
- `plugins/codex-zcode-bridge/worker/vendor/official-host/win32-x64-node24.16.0-zcode3.18.2-fec97590/app-server/provider/zcode-builtin.json`
- 旧 `app-server/THIRD-PARTY-NOTICES.md`

许可材料移动到 Official Host artifact 根目录，`ARTIFACT_BOM.json`、`BUILD_PROVENANCE.json` 和 `scripts/validate-plugin.mjs` 已同步。Validator 新增：

- 要求根级 `THIRD-PARTY-NOTICES.md`；
- 拒绝任一已退役 `app-server` 资源重新出现；
- 要求 Worker bundle 使用共享 Official Host session factory；
- 拒绝 Worker bundle 中出现打包 AppServer fallback 路径。

## 5. 阶段 3：Direct AppServer 收缩为测试 Harness

`src/adapters/zcode-app-server-adapter.ts` 现在要求生产构造必须提供 `externalHostClientFactory`。只有显式 `ZCodeAppServerTestAdapter` 可以开启 direct stdio 测试路径。

同时：

- `src/core.ts` 不再导出 `ZCodeAppServerAdapter`；
- 生产 Worker 对非测试执行只实例化 `OfficialAppServerWorkerAdapter`；
- 原 `OfficialHostAdapter` 类已删除，统一使用共享 session factory；
- `runtimeAuthReply()` 已更名并收敛为 `testOnlyRuntimeAuthReply()`；生产 Adapter 缺少 resolver 或 resolver 拒绝时 fail closed；
- `CodingAgentAdapter` 合同、Session/Turn、Interaction、Usage/Events、Result 和 Cleanup 映射保持不变。

## 6. 阶段 4：Official Host Patch 上游化状态

固定上游为 ZCode `3.18.2`，commit
`fec975905a2abd4c07e35c40d51fa097a2258ec9`。本轮对照围栏内上游 `main`
与 tag `v3.18.2` 未发现三项 Patch 的等价官方实现，三项均保留。

本轮再次查询公开远端，`HEAD`、`refs/heads/main` 与 `refs/tags/v3.18.2`
均解析到同一提交。对干净上游 index 原样应用三项 Patch 均成功；上游基线
tree 为 `5e90fec80706b8381f94e4eef48cf821b9868916`。源码对照同时确认：

- 上游 `PROTOCOL_V4_LIMITS.maxFrameBytes` 仍为 1 MiB，且没有向
  ProcessManager/StdioTransport 注入 Bridge 所需 16 MiB 上限的等价入口；
- 上游尚不存在 `model-provider/oauthProviderRuntimeAuthService.ts`；
  `oauthService.refreshTokenInternal()` 仍在凭据文件锁之外读取快照、执行远端
  refresh 后以原快照写回，没有 profile-scoped cross-process single-flight；
- 上游尚不存在 `official-host/runtimeHostEntry.ts` 或
  `official-host/startPlanAuthentication.ts` 的只读 Start Plan 认证投影。

| Patch | 当前作用 | 上游状态 | 最小上游化请求 |
|---|---|---|---|
| `0001-stdio-max-frame-bytes.patch` | 将 stdio 单帧上限提升到 Bridge 所需的 16 MiB，并覆盖 exact/+1、partial、UTF-8 和 pending RPC | `UPSTREAM_PENDING` | 官方暴露可配置且有界、按原始 UTF-8 字节计数的 stdio frame limit |
| `0002-oauth-refresh-coordination.patch` | profile-scoped lock、lock-time reread、单次远端 refresh 与 CAS 发布 | `UPSTREAM_PENDING` | 官方实现跨进程 refresh 协调并返回明确的 stale/clobber 结果 |
| `0003-read-only-official-start-plan-auth.patch` | 为 Bridge 提供只读 Start Plan account/session/request/device 投影 | `UPSTREAM_PENDING` | 官方提供不导出秘密、不重写签发流程的窄认证投影 |

不能将三项 Patch 当作一个整体删除。只有官方接口、固定源码重放和对应回归同时具备时，才可逐项移除。

## 7. 保留的 Bridge 核心

本 Goal 未重写或外包以下职责：

- SQLite Task Authority、Task/Attempt/Claim 与 Task ID 幂等；
- Workspace Identity、Admission 与 Occupancy；
- 单 Worker / Attempt、Launch Intent 与 Recovery；
- Result Commit、Cleanup Proof 与 Release CAS；
- Worker 进程身份、进程树与资源释放事实；
- Start Plan Live Entitlement、Private Credential Lease、Worker-parent binding、HANDLE/ACK、expiry、cancellation 与 redaction；
- Coding Plan 与 Start Plan 分离的认证和权益语义；
- 公共 MCP Schema。

## 8. 体积变化

Official Host artifact：

| 状态 | 文件数 | Bytes |
|---|---:|---:|
| HEAD baseline | 15 | 38,850,985 |
| Candidate | 13 | 7,574,338 |

减少 `31,276,647` bytes，约 `29.83 MiB`。其中直接删除的打包 AppServer 与 builtin Provider 配置共 `31,275,576` bytes，也约 `29.83 MiB`。

插件树（主口径为 Git Tree，可跨 checkout 重复计算）：

| 状态 | 文件数 | Bytes |
|---|---:|---:|
| Baseline Git Tree `5501c60...` | 55 | 51,429,420 |
| ADR-041 Git Tree `a676c6c...` | 53 | 19,378,497 |
| Final Closure Git Tree `f19ab1d...` | 53 | 19,382,606 |

Final Closure 相对 baseline 减少 `32,046,814` bytes，约 `30.56 MiB`。统计命令为
`git ls-tree -r -l <commit> plugins/codex-zcode-bridge`，对 blob size 求和；
该口径包含生成 Bundle、Browser backend、Official Host closure、许可和元数据，
不是只看源码 LOC 的收益。

当前 Windows 工作区同一目录为 `19,384,405` bytes，比 Final Closure Git Tree 多
`1,799` bytes，
原因是本机 `core.autocrlf=true` 将文本文件展开为 CRLF。ZIP、Git Tree 与
checked-out worktree 的统计口径不同，报告不得混用。

源码与测试行数变化（包含新增文件）：

| 范围 | 增加 | 删除 | 净变化 |
|---|---:|---:|---:|
| `src/` | 503 | 455 | +48 |
| `test/` | 536 | 134 | +402 |
| `scripts/` | 21 | 5 | +16 |

源码净行数没有显著下降，因为共享工厂、Provider Runtime Auth 和更明确的失败/测试边界增加了 Bridge 侧必要的协议适配代码。真实收益是删除约 `32 MB` 的第二套 Runtime 分发面和消除重复生命周期实现，而不是追求 LOC 数字。

## 9. 测试与验证

已执行：

- `npm run typecheck`：PASS。
- `npm run build`：PASS。
- `npm run validate:plugin`：PASS。
- 最终修复前定向测试：Test Impact Selector、Validator 合成根、Model Catalog
  Official Auth 共 `31/31` PASS。
- 模型未指定时的 Official Provider Runtime Auth 惰性修复后定向套件：`77/77` PASS。
- Final Closure `npm run typecheck`：PASS。
- Final Closure `npm run build:test`：PASS。
- Final Closure `npm run build`：PASS。
- Final Closure 定向套件：`66` tests，`65` PASS、`0` FAIL、`1` SKIP；覆盖
  account-provider、Official AppServer Adapter、ZCode AppServer Adapter 和
  Official Host Adapter。
- 新增的生产 Runtime Auth 测试同时布置了合成 Coding Plan 持久化 API Key 与
  available cache entry；resolver 缺失、拒绝，以及 external-host 请求携带
  test-only 标志的三条路径均只返回不可用，未泄漏该 Key。
- Final Closure `npm run test:clean-entrypoints`：PASS；`4/4`。
- Final Closure `npm run test:inventory`：PASS；`882` declarations / `91` mapped files。
- Final Closure `npm run validate:plugin`：PASS。
- Final Closure `git diff --check`：PASS；仅报告 `LF -> CRLF` 工作区警告。
- Final Closure 修正 fixture 后，在正式隔离执行器中运行完整
  `mvp-real-adapter` fixture：`56/56 PASS`，包含 ADR-031 post-startup login、
  Start Plan fallback 与 Coding Plan explicit-provider 路径。
- `npm run test:affected`：早先一次 `FULL_SUITE` 运行在 ADR-031 的
  post-startup login 用例上失败；该用例随后在正式隔离器单独运行
  `1/1 PASS`，完整 fixture 串行运行亦为 `56/56 PASS`。
- 最终 `npm run test:affected`：PASS；受影响选择命中 `854` tests，
  `853` PASS、`0` FAIL、`1` SKIP，`1,448,053.9254 ms`。同一命令完成
  typecheck、build、Plugin Validator、生成物 Freshness 与 `git diff --check`，
  并命中并通过 SQLite stress gate：`STRESS_TEST_REQUIRED_AND_PASS`。
- Final `npm run test:full`：PASS；`942` tests，`940` PASS，`0` FAIL，`2` SKIP，
  `1,347,468.6958 ms`。
- `npm run test:clean-entrypoints`：PASS；`4/4` tests，覆盖 bundled Core、compiled stdio、marketplace launcher 与 compiled Worker 拒绝路径。
- `npm run test:inventory`：PASS；`879` declarations / `91` mapped files。
- 确定性重建：`12` generated artifacts，`0` changed。
- `git diff --check` 与 staged diff check：PASS；仅报告 `LF -> CRLF` 工作区警告。
- 真实模型请求：`0`。
- 真实 OAuth/Billing 请求：`0`。
- Stress gate：`STRESS_TESTS_NOT_APPLICABLE`；本轮没有声称压力测试 PASS。

真实 E2E 补充前执行的实验工程测试：

- `npm run cost-lab:test`：`84/84 PASS`。
- 新增未修改结果证据与错误消息保留测试后，定向
  `production-verification-runner.test.mjs`：`7/7 PASS`。
- 随后再次运行完整 `npm run cost-lab:test`，结果见最终交付记录。
- 实验执行器与测试变更触发 FULL impact 后，最终 `npm run test:affected`：
  PASS；`945` tests，`943` PASS、`0` FAIL、`2` SKIP，
  `1,475,030.4823 ms`。同一命令完成 typecheck、build、Plugin Validator、
  生成物 Freshness 与 `git diff --check`，并输出 `FULL_REGRESSION_PASS`。

第一次完整回归暴露并已修复的两项候选集成问题：

- 新测试未进入 `test/test-impact-map.json`；
- Validator 合成 baseline 仍使用 shorthand `workerModuleUrl`，与当前 Worker-shaped `workerModuleUrl:` 结构不一致。

修复没有删除测试、增加 SKIP 或降低 Validator 断言。

第一次完整回归还出现一次未复现的
`compiled stdio entry speaks pure JSON-RPC on stdout and diagnostics on stderr`
失败：`SQLITE_INITIALIZATION_FAILED: ENOENT ...\local-app-data\...\state`。失败位置为
`assertFreshBootstrapRootPath`。随后单独重跑 `mcp-stdio-entry` 为 `4/4 PASS`，
`test:clean-entrypoints` 在修复前后均为 `4/4 PASS`，最终完整回归也通过。由于
未取得可复现根因，仍将其记录为测试套件顺序或环境交互风险，而不是宣称已定位修复。

## 10. 与原始审计基线的差异

相对 `thin-adapter-final-audit-20261119.md`：

- P0“Model Catalog 第二套 AppServer 启动与认证”已收敛。
- P1“安装版 AppServer 尚未成为所有 Provider Runtime”已改为统一安装版路由；真实兼容性仍待 live 验证。
- P1“Direct Adapter 泄漏到公共 Core”已收敛为 test-only harness。
- P1“Official Host Patch 维护面”已确认全部 `UPSTREAM_PENDING`，尚未消除。
- 权威架构、运行配置、共享核心、项目状态和文档索引已同步。
- Browser extension 与历史迁移残留不在本 Goal 范围内，未借机重构。

## 11. 未完成与限制

- 其他 Provider 的真实模型 E2E：`NOT_RUN`。
- Start Plan 使用当前安装版 Runtime 的 live Entitlement、Private Lease、
  code-edit、Usage 和 token-unit 对账：`PASS`。
- Start Plan 请求级信用倍率：`NOT_VERIFIED`；官方当前仅返回 token-unit
  balance，没有可用于推导 credit multiplier 的请求级价格账本。
- Coding Plan 当前候选的真实 E2E：`INCONCLUSIVE`；三次独立 dispatch
  尝试后都没有观察到可关联模型小时桶行或积分变化。第三次保留了
  `turn_failed` / `USAGE_MISSING` 的失败证据，但仍不能证明模型 HTTP 请求，
  也没有可归因积分。
- 真实 OAuth refresh/账户轮换：`NOT_RUN`。
- 外部 fork 对移除 `ZCodeAppServerAdapter` Core 导出的兼容性：`NOT_RUN`。
- Windows x64 / Node `24.16.0` 以外的 Runtime 组合：`NOT_VERIFIED`。
- 发布安装、Marketplace、Tag、Release 与 Preview：`NOT_RUN`。
- 三项 Patch 尚未被官方上游等价实现替代。
- Final Closure 的 OAuth refresh 与 CAPTCHA E2E：`NOT_RUN`。
- 第一次完整回归的 compiled stdio 临时失败未复现；最终全套 PASS，但套件顺序/
  环境交互风险仍保留。

## 12. 最终架构差异

审计基线仍允许：

```text
Model Catalog -> direct AppServer
Other Provider -> packaged AppServer
Public Core -> direct ZCodeAppServerAdapter
```

本轮候选改为：

```text
Model Catalog ─┐
Task Provider ─┴-> shared Official Host session factory
                    -> installed Official AppServer

Direct stdio -> ZCodeAppServerTestAdapter only
Packaged AppServer -> absent + validator rejection
```

因此架构收敛的实现主体已完成。Start Plan 的真实执行和 Token 对账已补齐；
剩余风险集中在 Coding Plan 当前候选的不可归因结果、Start Plan credit 倍率
缺失、其他 Provider/OAuth live 验证、外部 fork 兼容性、上游 Patch 和发布流程。

## 13. 真实 Plan E2E 补充（2026-11-20）

### 13.1 Cost Lab 生产执行器修复

真实执行前定位到一个实验执行器缺陷：

- Runner 默认启动 `dist/src/mcp/main.js`，但没有设置
  `ZCODE_BRIDGE_PLUGIN_MODE=1`。
- Worker 入口因此解析为 `dist/src/worker/worker-main.js`，该目录没有
  `vendor/official-host` 资产。
- Start Plan issuer 的只读认证初始化因此返回 `null`，Task Admission 报
  `TASK_INVALID`，且 MCP 结构化错误消息未进入实验 Evidence。

修复仅限 Cost Lab 实验执行器：

- 默认改为启动生产使用的
  `plugins/codex-zcode-bridge/dist/bridge.mjs`；
- 隔离子进程显式设置 `ZCODE_BRIDGE_PLUGIN_MODE=1`；
- 保留 MCP 结构化错误消息；
- 在结果校验前附加 partial runtime evidence，避免无文件修改或终端失败丢失
  Session、事件、Result 和 Usage 证据。

最终补充只修复实验端生命周期，不改变生产执行路径：

- `web-server` 将 `task_mode` 从请求记录传递到 production runner；
- runner 在 result validation 失败时保留 `model_requests`、`usage` 和 `hour`；
- failed task evidence 仍经过 `redactValue`，不会向浏览器或历史导出凭据；
- Coding Plan 的空小时桶不能使用模型过滤快照（`model_not_found`），因此
  本次保存 before/after 时直接复用现有官方 accessor 的无模型过滤只读快照；
  没有创建第二套认证或 Billing Client。

证据：

- `.run/cost-lab-e2e/final-coding-e2e-20261120.json`
- `.run/cost-lab-e2e/final-coding-before-v2-20261120.json`
- `.run/cost-lab-e2e/final-coding-v2-20261120.json`
- `.run/cost-lab-e2e/final-coding-after-failure-v2-20261120.json`
- `.run/cost-lab-e2e/final-startplan-before-20261120.json`
- `.run/cost-lab-e2e/final-startplan-e2e-20261120.json`
- `.run/cost-lab-e2e/final-shared-before-20261120.json`
- `.run/cost-lab-e2e/final-shared-after-20261120.json`

### 13.2 Coding Plan

- 第一次 dispatch：`2026-11-19T17:22:39.678Z` 至
  `17:23:14.019Z`（Asia/Shanghai `2026-11-20 01:22:39` 至 `01:23:14`）。
  before snapshot 为 `17:22:39.679Z`；Runner 报
  `bridge_code_edit_unverified`，没有保留 Session、Result 或 Usage。
- 第二次 dispatch：`2026-11-19T17:38:26.356Z` 至
  `17:41:59.939Z`（Asia/Shanghai `2026-11-20 01:38:26` 至 `01:41:59`）。
  fresh before snapshot 为 `2026-11-19T17:37:36.188Z`；Runner 再次报
  `bridge_code_edit_unverified`。该次执行发生在 evidence-ordering 修复前，
  因此也没有保留 Session、Result 或 Usage。
- 两个窗口的立即与延迟 after snapshot 均未出现可关联模型行；两条
  `CREDIT_LIMIT` 的 `currentValue` 保持 `0` 和 `4129`，没有可观察积分增量。
- 第三次 dispatch（本轮）：`2026-11-19T20:06:16.669Z` 至
  `20:06:48.512Z`（Asia/Shanghai `2026-11-20 04:06:16` 至 `04:06:48`）。
  before snapshot 为 `20:06:16.670Z`；after snapshot 为 `20:07:30.016Z`。
  两者都是 fresh official accessor 结果，但 `models=[]`、模型小时桶为空，
  `CREDIT_LIMIT.currentValue` 仍为 `0` 和 `4129`。
- 第三次 attempt 的 production Evidence：Session
  `sess_91fcb1f9-8d73-4e52-a10e-a03e39597738`，Provider
  `account:bigmodel-individual-coding-plan`，Model `GLM-5.3-Flash`；
  `turn_started` 两次，随后 `turn_failed`，错误为
  `zcode_nonzero_exit`。`model_requests=1` 只是 runner 的逻辑 terminal
  attempt 计数，`usage=null`、`model_http_requests=null`、
  `auxiliary_usage_coverage=USAGE_MISSING`，目标文件未改变，因此不能证明
  模型 HTTP 请求成功，也不能计算 Token 或积分。
- 本轮没有重试该失败 task，也没有启动第四个 Coding Plan dispatch。

结论：

```yaml
CODING_PLAN_REAL_E2E: INCONCLUSIVE
CODING_PLAN_DISPATCH_ATTEMPTS: 3
CODING_PLAN_MODEL_REQUESTS_PROVEN: 0
CODING_PLAN_LAST_TERMINAL: zcode_nonzero_exit
CODING_PLAN_LAST_USAGE: null
CODING_PLAN_OFFICIAL_CREDIT_DELTA: NOT_OBSERVED
CODING_PLAN_MULTIPLIER: NOT_VERIFIED
```

不能把三次 dispatch 写成三次已证明模型请求，不能把“未观察到积分”写成
“零积分请求”，也不能用缺失 Usage 推断 0.67。第三次失败的精确外部原因仍是
`UNKNOWN`：当前 MCP Evidence 只暴露 `zcode_nonzero_exit`，没有 401、403、
3012 或其他可归因 Provider 错误；因此不能据此宣称账户风控，也不能重试。

### 13.3 Start Plan

- 新鲜 before snapshot：`2026-11-19T17:43:08.463Z`
  （Asia/Shanghai `2026-11-20 01:43:08`）；Plan `active`、
  `ZCODE GLOBAL BUILD`、entitlement `entitled`、bucket 初始
  `used_units=0`。
- 一次真实 production code-edit task：
  Session `sess_3599a52f-06d1-420b-9060-a2e0f72c07c3`；
  Provider `account:bigmodel-start-plan`；
  Model `GLM-5.3-Flash`；Reasoning `low`。
- 模型请求 1 个逻辑 turn，4 个实际工具调用（Write/Read/Write/Read），目标文件
  内容发生预期修改并完成回读。
- Runtime Usage：`input_tokens=113947`、`cached_input_tokens=90688`、
  `output_tokens=415`、`total_tokens=114362`。
- Fresh after snapshot：同一 bucket `used_units` 增加 `114362`，
  `remaining_units` 减少 `114362`；Token 对账精确一致。
- 读取前后凭据文件元数据不变，Keyring Lock 不存在，任务后无残留实验进程。
- 该 Start Plan E2E 产生于生产执行路径未再变化的候选上；后续提交只修改
  Cost Lab 实验执行器的失败 Evidence 与测试，不改变 Start Plan 运行时代码。

结论：

```yaml
START_PLAN_REAL_E2E: PASS
START_PLAN_TOKEN_RECONCILIATION: PASS
START_PLAN_MULTIPLIER: NOT_VERIFIED
```

Start Plan 官方响应只提供 token-unit balance，未提供本次请求的 credit
价格或倍率账本，因此不能把 token-unit 扣减换算成 `0.67` 或 `1.0`。

### 13.4 共享状态、Host Wake 与发布

- 凭据、`config.json`、`provider_config.json` 和 Keyring Lock 的路径级元数据
  前后完全一致。
- 未向 Host Wake、ZCode、Magpie 或其他 Agent 进程发送信号，也未修改其文件。
- 此前 `TASK_INVALID` 遗留的两个精确验证根目录已确认无进程占用并清理；
  成功 Start Plan task 的验证根目录由 Runner 自动释放。
- 第三次 Coding Plan 失败后没有残留 verification roots、Cost Lab server 或
  runner 进程；未创建或合并 Preview PR。

```yaml
SHARED_PERSISTENT_STATE_UNCHANGED: PASS
HOST_WAKE_CONFLICT: NONE
PREVIEW_MERGED: NO
RELEASED: NO
```

### 13.5 最终门禁

以下 `PRODUCTION_CODE_CHANGED: NO` 仅指本轮 Final Billing E2E 延续没有修改
生产执行路径；本分支此前的 Thin Adapter Final Closure 仍包含已提交的生产架构
收敛。

```yaml
GOAL: THIN_ADAPTER_FINAL_CLOSURE_AND_REAL_E2E

FINAL_CLOSURE: PASS
KEYRING_LOCK_SEMANTICS: PASS
SHARED_PERSISTENT_STATE_UNCHANGED: PASS
OFFICIAL_BILLING_ACCESS: PASS
OFFICIAL_ASSEMBLY_INIT: PASS
APPSERVER_LIFECYCLE: PASS

B_REAL_TASKS: 1
B_MODEL_REQUESTS_PROVEN: 0
B_HTTP_REQUESTS: UNKNOWN
B_TOTAL_TOKENS: null
B_ACTUAL_CREDITS: null
B_EXPECTED_NORMAL: null
B_EXPECTED_WITH_0_67: null
B_DISCOUNT: INCONCLUSIVE
BILLING_RECONCILIATION: NOT_POSSIBLE_USAGE_MISSING
PROJECT_IDENTITY_PARITY: UNKNOWN

CODING_PLAN:
  REAL_E2E: INCONCLUSIVE
  ACTUAL_MODEL: GLM-5.3-Flash
  PROVIDER_ID: account:bigmodel-individual-coding-plan
  RUNTIME_VERSION: 3.18.2.10443
  CAPABILITY_GATE: PASS
  AUTH: INCONCLUSIVE
  USAGE: USAGE_MISSING
  OFFICIAL_MULTIPLIER: 0.67_DECLARED_NOT_OBSERVED
  OBSERVED_MULTIPLIER: null
  BILLING_RECONCILIATION: NOT_POSSIBLE_USAGE_MISSING

START_PLAN:
  REAL_E2E: PASS
  ACTUAL_MODEL: GLM-5.3-Flash
  PROVIDER_ID: account:bigmodel-start-plan
  RUNTIME_VERSION: 3.18.2.10443
  LIVE_ENTITLEMENT: PASS
  PRIVATE_LEASE: PASS
  CAPABILITY_GATE: PASS
  AUTH: PASS
  USAGE: input=113947; cached_input=90688; output=415; total=114362
  OFFICIAL_MULTIPLIER: NOT_EXPOSED_BY_TOKEN_UNIT_BALANCE
  OBSERVED_MULTIPLIER: NOT_VERIFIED
  BILLING_RECONCILIATION: PASS_TOKEN_UNITS_DELTA_114362

TESTS:
  TYPECHECK: PASS
  BUILD: PASS
  VALIDATE_PLUGIN: PASS
  TEST_AFFECTED: PASS
  CHECK_GENERATED: PASS
  COST_LAB: PASS_84_OF_84
  FULL_OR_REQUIRED_REGRESSION: PASS_945_TESTS_943_PASS_0_FAIL_2_SKIP
  CI: NOT_RUN

REAL_CODING_PLAN_E2E: BLOCKED
REAL_START_PLAN_E2E: PASS
CODING_PLAN_MULTIPLIER: NOT_VERIFIED
START_PLAN_MULTIPLIER: NOT_VERIFIED

RESOURCE_CLEANUP: PASS
HOST_WAKE_CONFLICT: NONE
PRODUCTION_CODE_CHANGED: NO
START_PLAN_LIFECYCLE_CHANGED: NO

FINAL_BRANCH: codex/unified-official-appserver-startplan-20261119
FINAL_COMMIT: 657849f0cccc082a4bcc22ef128b1f7d249539304
TREE: 28bc6fadb3dc3e6b80d954bf792c780ef1e5e20b
PREVIEW_BASE: f5390897978be995b3a942feaeaac0170e8849fa
MERGE_COMMIT: null
PREVIEW_MERGED: NO
POST_MERGE_CI: NOT_RUN
RELEASED: NO

REPORT: docs/reports/thin-adapter-end-state-20261119.md
NEXT_ACTION: STOP_AND_INVESTIGATE_CODING_PLAN_TERMINAL_FAILURE
FINAL_VERDICT: BLOCKED
```
