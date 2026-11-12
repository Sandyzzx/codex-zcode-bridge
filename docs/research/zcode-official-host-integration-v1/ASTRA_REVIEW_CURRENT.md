# Astra 独立审查：ZCode Official Host Integration v1 当前候选

> Status: RESEARCH
> Date: 2026-11-12，Asia/Shanghai
> Reviewer: Astra Candidate Final
> Candidate verdict: `APPROVED`
> PR readiness: `YES`

## REVIEWED_AGAINST

- Repository: `D:\codex-zcode-bridge`
- Review worktree: `D:\codex-zcode-bridge\.run\official-host-integration-v1-20261111`
- Branch: `codex/official-host-integration-v1-20261111`
- Base: `origin/preview` = `e444ad0d3ce5df342a7f4d104b19816f1af1dda5`
- Reviewed implementation commit: `ba25f83722094ef3428a04202749377cc9b6e643`
- Reviewed implementation tree: `b4573bb6f1143ce6a3081a56ce2fbf968a243e35`
- Preceding pushed candidate: `8e8966d5ec7539a2d8575fc748871a9641fe0a2d`
- Clean checkout: `D:\codex-zcode-bridge\.run\official-host-final-clean-20261112`
- Clean checkout HEAD/tree: `ba25f83722094ef3428a04202749377cc9b6e643` / `b4573bb6f1143ce6a3081a56ce2fbf968a243e35`
- Fixed upstream: ZCode `3.18.0` / `b95ebaffeab641907b38652f45c1502bd762972d`; AppServer `0.17.1`
- Fixed verification platform: Windows x64 / Node `24.16.0`

本审查覆盖上述提交中的生产接线、固定制品、Windows cleanup 路径、账户与 frame patch、Worker 路由、测试及文档声明。`ba25f837` 之后的工作树增量是证据文档刷新；`plugins/codex-zcode-bridge/dist/bridge.mjs` 只有 Git 提示的 CRLF 状态变化，`git diff` 没有内容差异。若这些事实在合并前改变，本结论失效。

## 裁决

```text
VERDICT: APPROVED
P0_FINDINGS: 0
P1_FINDINGS: 0
P2_FINDINGS_ATTRIBUTABLE_TO_CHANGE: 0
PR_READY: YES
```

批准仅针对固定 Windows x64 / Node `24.16.0` 制品的工程源码候选，以及已明确声明的 synthetic、isolated 和 clean-checkout 证据。它不代表真实 OAuth、账户轮换、模型、Start Plan、Billing、生产数据迁移、跨上游版本升级或安装级回滚已经验收。

## 具体发现

未发现由本候选引入的 P0、P1 或 P2 缺陷。以下两项是需要保留的风险披露，不改变本次 PR 裁决：

1. **生产依赖安全基线。** `npm audit --omit=dev` 报告 `2 high` 个包级漏洞：`@modelcontextprotocol/server@2.1.0` 和 `zod@4.6.5`；其中前者通过多条 advisory 汇总。相对 `origin/preview`，本分支没有改变这两个依赖版本或已解析依赖树，`package-lock.json` 只改变根包版本，`package.json` 只新增 `build:official-host`。因此这是既有基线的独立发布安全待办，不是本 PR 引入的架构阻断项。合并前或后续发布流程必须跟踪；不得声称当前依赖树零高危。
2. **Node 证据边界。** 生产 SQLite Gate 接受 `>=24.16.0 <25`，而固定 Host bundle 的构建与 native/Host clean-checkout 加载只在 Node `24.16.0` 上验证。JS bundle 和 Node-API binding 没有显示不兼容，但其他 Node 24 patch-level 仍未认证。文档已经将该矩阵列为 `PARTIAL`，因此这里不构成隐藏合同或虚假 PASS；若要宣称完整 Node 24.x 支持，必须另行验证。

## 固定制品与原始字节

从 clean checkout `ba25f837` 读取 `ARTIFACT_BOM.json`，逐项核对 13 个 BOM 文件：

- worktree bytes 与 BOM 的 byte length、SHA-256 一致；
- worktree Git blob 与 `HEAD` blob 一致；
- 所有入口均为普通 `100644`，没有 symlink 或用户环境路径重定向；
- `npm run validate:plugin` 在实际最终提交的 clean checkout 中通过。

四个曾经受 Git 行尾转换影响的关键文本制品现已保持原始字节：

| Path | Bytes | SHA-256 | Git blob |
|---|---:|---|---|
| `app-server/provider/zcode-builtin.json` | 265,884 | `BC760A3B0C6D096EA07EE4E963471F135AE75AB207DB6ED4C372E1B183C856CD` | `2d12eaf65fa34271302200cab8600a9bbbf92803` |
| `app-server/THIRD-PARTY-NOTICES.md` | 3,465,209 | `C4CC6DC747EB6026E41D2CEFC6679392C33E1192629EA96DC0DC702BCFE7C51C` | `a8a5d996ac2facf53a2494be4bf0124e7651968d` |
| `LICENSE` | 11,546 | `FA36DC312BC4946B1C22DBA3C726AD8D3052B353F81424E7B997DBB3D9B40A49` | `56c92095eee582d4b899398dc6bb32d4af7a882a` |
| `NOTICE.md` | 29,012 | `9225442463AD06327B4149E1FA740981E4E2AB8855B237AF8BE44765CCD08DBC` | `445d20182b7ab73020791ed6bd8db9fdb72de0c9` |

Host module 和 BOM 的两项主身份也匹配：

```text
official-host-runtime.mjs  1,821,168 bytes
3F481AAE16EFF9912DAF17178B49491BD64E67C4419BFFDB59EB4B78E85EB537

ARTIFACT_BOM.json          7,260 bytes
B9A7104DAB3B10250CA93899324C0B33966E64C0BE02F279A1353BABBA8F129C
```

三个 patch 的顺序、bytes、SHA-256 和 aggregate diff SHA-256 均由 plugin validator 与 provenance 记录校验。same-source-tree 两次构建的 Host module byte-identical；这不等于从空缓存和不同机器也能完全复现，后者仍为 `PARTIAL`。

## Native 与 Host 闭包

从 `ba25f837` 新建的 clean checkout 已完成：

- `npm ci`、typecheck、build 和 `validate:plugin`：`PASS`；
- 六文件 `@napi-rs/keyring` closure 路径存在且 bytes/SHA-256 匹配 BOM；
- `keyring.win32-x64-msvc.node` 的 Node-API binding 实际加载：`PASS`；
- `ZCodeAgentProcessManager`、`ZCodeProtocolClient`、`ZCodeStdioTransport` 和 `createOAuthProviderRuntimeAuthService` 从固定 Host module 动态导入：`PASS`；
- Host/AppServer/helper/provider 的固定入口没有被任务输入、环境变量或持久设置重定向。

该证据闭合当前 shipped Windows x64 binary set 的入库和加载问题。一般 Browser、WASM、字体、MCP/tool 后代、不同机器/VC runtime 与长时间 soak 的资源闭包仍为 `PARTIAL`。

## Adapter 选择与测试 seam

生产选择只依赖不可变运行时事实：

| Platform/architecture | Production adapter |
|---|---|
| `win32/x64` | `official_host` |
| `linux/x64`, `linux/arm64`, `darwin/x64`, `darwin/arm64` | `direct_app_server` |
| Windows ARM64/ia32 与其他平台 | fail closed，`unsupported_worker_platform` |

`ZCODE_BRIDGE_ADAPTER`、任务输入和持久设置不能改变选择。direct Adapter 的回滚测试通过测试自有的 Worker/composition wrapper 注入；生产公共 MCP schema 和生产入口没有新增 `test_fake` 或可序列化 Adapter mode。该边界与 ADR-035 一致。

## Process 与 Cleanup 证明

正常生命周期仍由固定官方 `ZCodeAgentProcessManager` 拥有。Bridge 没有把官方 `close()` resolved 直接当成 Release：

- Worker exact identity 必须匹配持久 Claim；
- Windows recorded-tree scanner 从已记录 root identity 出发，能够发现 root 已退出后仍存活的后代；真实测试观察到 child/grandchild 存活时 `clean=false`，全部退出后 `clean=true`；
- runtime generation 变化、PID reuse、identity 未知、scan error/incomplete、resource facts 缺失或 close-time race 都会保留 `cleanup_unverified`/Hold；
- close result、close failure 与独立 cleanup verdict 分开记录；
- 只有 exact Result 坐标、cleanup evidence、Cleanup Digest 和 CAS 全部满足时才进入 Release；
- Manager restart 和无 Result Recovery 继续读持久事实，不猜 Result、不重派任务、不自行释放路径。

因此，官方 close 成功是生命周期事实，但不是单独的 Bridge Capacity Release 授权。该组合保留 ADR-009、ADR-018、ADR-024、ADR-030 和 ADR-034 的既有 fail-closed 语义。

## Frame 与账户合同

固定 upstream frame patch 使用 raw-byte `maxFrameBytes`，配置为恰好 16 MiB。测试覆盖 exact limit、`+1`、partial frame、UTF-8、CR/LF、EOF 和 pending RPC；超限产生明确失败，不裁剪成伪成功。

账户 refresh patch 在 profile 范围内使用锁、锁内 reread、dispatch marker、一次网络 refresh、expected-snapshot/CAS publishing，并处理 timeout、stale writer 和 unknown outcome。相同 profile 的 refresh transaction 串行化；不同 profile 和无 refresh 的 Worker 不因全局锁失去并发。真实 OAuth rotation 与远端服务语义仍为 `NOT_RUN`。

## Worker 与任务权威

候选没有引入独立 Companion 服务、Companion IPC、第二套业务 SQLite、平行 RuntimeAdapter、Shared AppServer Pool 或第二套 Task/Recovery 状态机。现有 Worker、Manager、SQLite Task Authority、Capacity、Claim、Result、Hold、Recovery、Cleanup、Release CAS 和 Worker slot 合同保留；ADR-030 的每任务单次权威 entitlement/Billing verdict 没有被此集成替换。

每个 Worker 的 AppServer 生命周期仍然隔离，没有把无关 Task 放进共享执行池。账户 refresh 的同一 profile 协调没有扩展成 task-long 账户锁。

## 验证结果

| Check | Result |
|---|---|
| Reviewer focused Adapter/platform tests | `18/18 PASS`，0 skip |
| 当前 Adapter/Worker directed suite | `32/32 PASS` |
| 路由、SQLite、影响选择 directed suite | `64/64 PASS` |
| SQLite real-adapter | `47/47 PASS` |
| upstream frame | `7/7 PASS` |
| upstream account | `12/12 PASS` |
| SQLite stress | `3/3 PASS` |
| 最终完整隔离回归 | 936 tests，935 pass，0 fail，1 skip，0 cancelled |
| Final log marker | `FULL_REGRESSION_PASS` |
| Clean checkout npm ci/typecheck/build | `PASS` |
| Clean checkout plugin validation | `PASS` |
| Clean checkout Host exports/keyring native load | `PASS` |

唯一 skip 是现有平台条件测试。`git diff --check` 没有 whitespace failure；Windows 的 CRLF normalization warning 不等于内容错误。未运行项继续明确保留：

```text
REAL_OAUTH_OR_ACCOUNT_OPERATION: NOT_RUN
REAL_MODEL_PROVIDER_E2E: NOT_RUN
REAL_START_PLAN_REQUEST: NOT_RUN
REAL_BILLING_REQUEST: NOT_RUN
PRODUCTION_DATA_MIGRATION: NOT_RUN
CROSS_UPSTREAM_VERSION_UPGRADE: NOT_RUN
PRODUCTION_INSTALL_ROLLBACK_DRILL: NOT_RUN
FULL_NATIVE_RESOURCE_LONG_SOAK_MATRIX: PARTIAL
FULL_REDISTRIBUTION_LEGAL_APPROVAL: PARTIAL
```

## 合并前条件

1. 将最新证据文档刷新与本审查文件一起提交，且不得改变 `ba25f837` 已审查的生产源码和固定制品 bytes。
2. 合并前确认最终 docs-only 提交仍包含 `ba25f837` 的生产源码与制品内容；若任何源码、测试合同、BOM、patch 或 bundle 再变化，重新审查并重跑相应门禁。
3. 对最终文档提交运行 `git diff --check` 和文档影响选择；完整 936 项回归与 `ba25f837` clean checkout 不能覆盖后来新增的非文档代码。
4. 把 `@modelcontextprotocol/server` 与 `zod` 的基线高危 advisory 继续作为独立安全发布待办，不能因本 PR 已审查而关闭。

满足以上条件后，本候选可以进入提交、Push、PR 和正常审查流程。提交、Push、PR、Merge 与 Release 仍需按外部授权单独执行。

VERDICT: APPROVED
PR_READY: YES
