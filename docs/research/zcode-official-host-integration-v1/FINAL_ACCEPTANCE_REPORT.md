# ZCode Official Host Integration v1：最终验收报告

> Status: RESEARCH — CURRENT CANDIDATE ENGINEERING ACCEPTANCE IN PROGRESS
> Last updated: 2026-11-12
> Last verified: 2026-11-12，最终完整隔离回归已通过；提交后的 clean checkout 与当前快照独立审查属于最后门禁
> Verified against: `8e8966d5ec7539a2d8575fc748871a9641fe0a2d`（tree `4e9b0a005e4802cb4247582dbf1b7369498cb966`）+ final candidate worktree changes

## 裁决

```text
SOURCE_IMPLEMENTATION: PRESENT
TARGET_TOPOLOGY: EXISTING_WORKER_OFFICIAL_HOST
DIRECTED_SYNTHETIC_VERIFICATION: PASS
FIXED_ARTIFACT_BUILD: PASS
SAME_SOURCE_TREE_REPRODUCIBILITY: PASS
FULL_ISOLATED_REGRESSION: PASS
FINAL_COMMIT_CLEAN_CHECKOUT: PENDING
REAL_ACCOUNT_MODEL_E2E: NOT_RUN
CURRENT_CANDIDATE_ASTRA_REVIEW: PENDING
PR_READY: PENDING
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
| native/Host closure | `PENDING_FINAL_COMMIT` | 6 个 keyring 文件与 Host exports 必须在提交后的全新 checkout 再次解析和加载 |
| 许可与再分发 | `PARTIAL` | BOM/NOTICE 已纳入；逐项发布许可结论仍需 Owner/法律审查 |
| Official Host 下一版本升级 | `DEFERRED` | 当前只批准固定 3.18.0；没有第二个制品，不伪造升级成功 |
| 当前固定制品部署安全 | `PASS_TEST_SCOPE` | exact path/manifest、generation/close fence；test-only direct rollback smoke 1/1 |
| 真实 OAuth/account/model/Start Plan/Billing | `NOT_RUN` | 本候选没有真实服务请求；Provider 仅 loopback Mock |
| 生产数据迁移 | `NOT_RUN` | 只执行隔离 SQLite v13→v14 |
| 产品性能 | `UNKNOWN` | 3 个顺序 Mock 样本，路径语义不同，不能推导总体性能 |
| 当前快照独立 Astra review | `PENDING` | 旧 `ASTRA_REVIEW.md` 只适用于更早快照 |

## Owner 问题

**是否已构建独立官方 Host 制品？** 是，限 Windows x64、Node `24.16.0`；同源双建 byte-identical，BOM/provenance 一致。

**是否已接入现有 Worker？** 是，Preview.4 源码候选的 Windows x64 默认路径已接入；尚未发布。

**是否复用官方 AgentRuntime、Prompt、Tools、Provider？** 执行路径复用固定官方 Host module 与 AppServer；Bridge 没有复制这些实现。真实 Provider 请求未运行。

**是否保留 Worker 并发合同？** 是。SQLite Admission/Capacity、Claim、Hold、Recovery、Cleanup、Release 和 Worker slot 语义未由 Companion 或 Pool 替代；same-profile 并发只在 refresh transaction 上协调。

**Cleanup 是否闭合？** 正常 close、exact identity、recorded-tree、resource facts、Digest 和 Release CAS 已接线并有定向测试；一般 helper/后代/第三方资源组合与长时间 soak 仍为 `PARTIAL`。

**SQLite 是否自动升级？** 生产 Lifecycle startup 会自动升级 v13；直接 Store 打开 v13 仍要求离线工具。

## 最终门禁

1. 把文档、测试、精确 `.gitignore` 例外和四个原始字节 BOM 文件提交为一个明确候选。
2. 从该提交创建全新 detached clean checkout，执行 `npm ci`、typecheck、build、plugin validation、Host export import 与 keyring native load。
3. 独立审查当前 diff、测试、BOM、原始 Git blob bytes 和声明边界。
4. 解决审查发现的问题后，才把 `PR_READY` 改为最终结论。

## 明确未完成

- 不把 `NOT_RUN` 的真实账户、模型、Start Plan 或 Billing 写成 PASS。
- 不把测试范围 SQLite 验证写成生产数据迁移。
- 不把固定 3.18.0 制品的部署测试写成跨版本升级。
- 不把逐项 BOM/NOTICE 存在写成完整再分发法律批准。
- 不在独立审查前声称 `PR_READY: YES`。
