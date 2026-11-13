# ZCode Official Host Integration v1：最终验收报告

> Status: RESEARCH — CURRENT CANDIDATE ACCEPTED / PR-READY
> Last updated: 2026-11-12
> Last verified: 2026-11-12，最终完整隔离回归、提交后 clean checkout 和当前快照独立 Astra 审查均已通过
> Verified against: `ba25f83722094ef3428a04202749377cc9b6e643`（tree `b4573bb6f1143ce6a3081a56ce2fbf968a243e35`）；后续仅有文档证据刷新

## 裁决

```text
SOURCE_IMPLEMENTATION: PRESENT
TARGET_TOPOLOGY: EXISTING_WORKER_OFFICIAL_HOST
DIRECTED_SYNTHETIC_VERIFICATION: PASS
FIXED_ARTIFACT_BUILD: PASS
SAME_SOURCE_TREE_REPRODUCIBILITY: PASS
FULL_ISOLATED_REGRESSION: PASS
FINAL_COMMIT_CLEAN_CHECKOUT: PASS
REAL_ACCOUNT_MODEL_E2E: NOT_RUN
CURRENT_CANDIDATE_ASTRA_REVIEW: APPROVED
PR_READY: YES
```

当前候选已经实现 ADR-032/ADR-035 的目标执行链：

- Windows x64 Worker 默认装配 `OfficialHostAdapter`。
- 官方 `ZCodeAgentProcessManager` 独占正常 Runtime、AppServer 和 helper 生命周期。
- Bridge 继续持有 SQLite Authority、Claim、Result、Hold、Recovery、Cleanup 和 Release CAS。
- 16 MiB raw frame、账户 refresh 协调和正常 Cleanup 映射已进入候选或固定上游 patch。
- Preview.4 生产 Lifecycle Gate 自动处理 v13→v14 升级。
- 没有 Companion 进程、Companion IPC、第二套业务数据库、平行 RuntimeAdapter 或 Shared AppServer Pool。

## 验收矩阵

| 维度 | 状态 | 证据边界 |
|---|---|---|
| ADR-032 拓扑与 ADR-035 平台选择 | `PASS` | 现有 Worker 内官方 Host；Windows x64 固定制品，其他平台按决定 fail closed 或保持 CI/合成路径 |
| 固定来源与制品 | `PASS` | ZCode `3.18.0` / `b95ebaff`、AppServer `0.17.1`、Windows x64、Node `24.16.0`；source/commit/tree/patch/BOM hash 已记录 |
| 同源制品双建 | `PASS` | Host module 两次 byte-identical：1,821,168 bytes，SHA-256 `3F481AAE16EFF9912DAF17178B49491BD64E67C4419BFFDB59EB4B78E85EB537` |
| Adapter/Worker 定向 | `PASS` | current official-host/plugin/platform 32/32；focused contract 64/64 |
| SQLite real-adapter | `PASS` | 47/47；覆盖 Worker 私有管道、Claim、Result、Crash、large Result、deadline 与 routing |
| 16 MiB raw frame | `PASS` | 7/7 固定上游合成矩阵 |
| 账户 refresh 协调 | `PASS` | 12/12 合成矩阵；真实 rotation 仍为 `NOT_RUN` |
| 完整隔离回归 | `PASS` | 最终 `test:affected` 选择 `FULL_SUITE`：936 项，935 pass、0 fail、1 skip、0 cancel |
| SQLite stress | `PASS` | 3/3 |
| 自动 v13→v14 | `PASS_TEST_SCOPE` | 中断恢复、occupied Attempt、Recovery Hold、events 与 digest 保持 |
| native/Host closure | `PASS_FOR_SHIPPED_BINARY_SET` | 6 个 keyring 文件与 Host exports 已在提交后的全新 checkout 复原、解析和加载 |
| 许可与再分发 | `PARTIAL` | BOM/NOTICE 已纳入；逐项发布许可结论仍需 Owner/法律审查 |
| 既有依赖安全基线 | `KNOWN_RISK` | `@modelcontextprotocol/server@2.1.0` 与 `zod@4.6.5` 的 high advisories 与 `origin/preview` 相同；本候选未改变依赖树 |
| Official Host 下一版本升级 | `DEFERRED` | 当前只批准固定 3.18.0；没有第二个制品，不伪造升级成功 |
| 当前固定制品部署安全 | `PASS_TEST_SCOPE` | exact path/manifest、generation/close fence；test-only direct rollback smoke 1/1 |
| 真实 OAuth/account/model/Start Plan/Billing | `NOT_RUN` | 本候选没有真实服务请求；Provider 仅 loopback Mock |
| 生产数据迁移 | `NOT_RUN` | 只执行隔离 SQLite v13→v14 |
| 产品性能 | `UNKNOWN` | 3 个顺序 Mock 样本，路径语义不同，不能推导总体性能 |
| 当前快照独立 Astra review | `APPROVED` | 审查实际 diff、BOM、原始 Git bytes、Host/native 加载和 936 项回归；未发现本候选引入的 P0/P1/P2 |

## Owner 验收合同

```text
GOAL: ZCODE_OFFICIAL_HOST_INTEGRATION_V1

ARCHITECTURE:
  ADR_032_COMPLIANCE: PASS
  ADR_030_PRESERVED: YES
  INDEPENDENT_COMPANION: ABSENT
  NEW_IPC: NONE
  NEW_DATABASE: NONE
  NEW_COMPONENTS: NONE

ACCOUNT:
  REFRESH_LOCK: PASS
  ONE_TIME_TOKEN_RACE: PASS
  ATOMIC_PUBLISH: PASS
  CRASH_RECOVERY: PASS
  LIVE_REVISION_PROPAGATION: PASS
  SAME_PROFILE_MULTIWORKER: PASS_SYNTHETIC
  DIFFERENT_PROFILE_PARALLELISM: PASS_SYNTHETIC
  REAL_ACCOUNT_E2E: NOT_RUN

TRANSPORT:
  OFFICIAL_MAX_FRAME_BYTES: PASS
  RAW_UTF8_BYTE_LIMIT: PASS
  PARTIAL_FRAME_LIMIT: PASS
  PENDING_RPC_REJECTION: PASS
  PATCH_HASH_0001: 80E77CA5D322141B93D6B035BDB8A7903F575BF78012FABA5B701B0541B29844
  PATCH_HASH_0002: 7AD85F0403CFA6AE55DAFDACE79FBB26C8970E758CEBE2496C4344A2108C651F
  PATCH_HASH_0003: BD0A891EC19AD98571CEE053930BA9A45DFE879204436B377C5D56D66F5EC35D
  SOURCE_AGGREGATE_DIFF_HASH: 39D980C47C553B39D91F73748B63B794FAB18360B008728233B4C5BA70D7495F
  PATCH_REPRODUCIBILITY: PASS

CLEANUP:
  OFFICIAL_CLOSE: PASS
  EXACT_WORKER_IDENTITY: PASS
  RECORDED_TREE_EMPTY: PASS
  HELPER_EXIT: PASS
  APPSERVER_EXIT: PASS
  RESOURCE_FACTS: PASS
  CLEANUP_DIGEST: PASS
  HOLD_RECOVERY: PASS
  RELEASE_CAS: PASS

ADAPTER:
  OFFICIAL_HOST_ADAPTER: PASS
  SESSION: PASS
  EVENTS: PASS
  TOOLS: PASS
  MODEL_ROUTING: PASS
  TOKEN_USAGE: PASS
  CANCELLATION: PASS
  ERROR_MAPPING: PASS
  TERMINAL_MAPPING: PASS

WORKER:
  EXISTING_WORKER_INTEGRATION: PASS
  WORKER_CONCURRENCY: PRESERVED
  SQLITE_AUTHORITY: PASS
  HOLD: PASS
  RECOVERY: PASS
  CLEANUP: PASS
  RELEASE: PASS

QUALITY:
  TARGETED_TESTS: PASS
  INTEGRATION_TESTS: PASS
  WINDOWS_LIFECYCLE: PASS
  BROWSER_MCP: PARTIAL
  STRESS_TESTS: PASS
  FULL_REGRESSION: PASS
  BOM: PASS
  LICENSE: PARTIAL
  PERFORMANCE: UNKNOWN
  UPGRADE_ROLLBACK: PARTIAL
  ASTRA_REVIEW: APPROVED

DELIVERY:
  PR_READY: YES
  UNRESOLVED_BLOCKERS: 0
  KNOWN_LIMITATIONS: 9

  PRODUCTION_SQLITE_MODIFIED: NO
  REAL_ACCOUNT_REQUESTS: 0
  REAL_MODEL_REQUESTS: 0
  STARTPLAN_REQUESTS: 0
  BILLING_REQUESTS: 0
  DESKTOP_INTERRUPTED: NO
  CURRENT_FINAL_COMMIT_PUSHED: NO
  MERGED: NO
  RELEASED: NO

NOTE:
  The earlier candidate 8e8966d5 was pushed after separate user authorization.
  The current final candidate remains local in this goal.
```

## Owner 问题

**是否已构建独立官方 Host 制品？** 是，限 Windows x64、Node `24.16.0`；同源双建 byte-identical，BOM/provenance 一致。

**是否已接入现有 Worker？** 是，Preview.4 源码候选的 Windows x64 默认路径已接入；尚未发布。

**是否复用官方 AgentRuntime、Prompt、Tools、Provider？** 执行路径复用固定官方 Host module 与 AppServer；Bridge 没有复制这些实现。真实 Provider 请求未运行。

**是否保留 Worker 并发合同？** 是。SQLite Admission/Capacity、Claim、Hold、Recovery、Cleanup、Release 和 Worker slot 语义未由 Companion 或 Pool 替代；same-profile 并发只在 refresh transaction 上协调。

**Cleanup 是否闭合？** 正常 close、exact identity、recorded-tree、resource facts、Digest 和 Release CAS 已接线并有定向测试；一般 helper/后代/第三方资源组合与长时间 soak 仍为 `PARTIAL`。

**SQLite 是否自动升级？** 生产 Lifecycle startup 会自动升级 v13；直接 Store 打开 v13 仍要求离线工具。

## 最终门禁

以下候选级门禁已完成：

1. 最终完整隔离回归通过：936 项，935 pass、0 fail、1 skip。
2. 从候选提交新建 detached clean checkout，并通过 `npm ci`、typecheck、build、
   plugin validation、Host exports import 与 keyring native load。
3. 四个原始字节文本制品和全部 BOM 文件与 Git blob/工作树 bytes、SHA-256 一致。
4. 当前快照独立 Astra review 为 `APPROVED`，P0/P1/P2 均为 0。
5. `package.json`、`package-lock.json`、插件 manifest 与 MCP server version 均为
   `2.0.0-preview.4`。

## PR-ready 结论

该候选可以进入提交、Push、PR 和正常代码审查流程。本次本地交付不自动创建
PR、Merge、Tag 或 Release。真实账户、生产迁移、安装级回滚和逐项再分发许可
仍是独立发布门禁，不影响本次架构候选的 PR-ready 结论。

## 明确未完成

- 不把 `NOT_RUN` 的真实账户、模型、Start Plan 或 Billing 写成 PASS。
- 不把测试范围 SQLite 验证写成生产数据迁移。
- 不把固定 3.18.0 制品的部署测试写成跨版本升级。
- 不把逐项 BOM/NOTICE 存在写成完整再分发法律批准。
- 不把真实服务 `NOT_RUN`、生产迁移或发布许可 `PARTIAL` 升级为已完成事实。
