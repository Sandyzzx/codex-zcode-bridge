# ZCode Official Host Integration v1：最终验收报告

> Status: RESEARCH — FINAL CANDIDATE ASSESSMENT
> Date: 2026-11-11，Asia/Shanghai
> Bridge candidate: `codex/official-host-integration-v1-20261111`
> Bridge baseline: `9710303397fe2d544c75698f783a8174404b2d51`
> Official source: `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d` / `3.18.0`
> Architecture authority: [ADR-032 Accepted](../../decisions/ADR-032-existing-worker-official-host-integration.md)

## 1. 最终结论

本轮完成了固定官方源码构建、最小 Host module、Windows runtime-host helper、官方 ProcessManager/AppServer 隔离 Mock、账户双进程合成竞争、现有 Bridge 定向回归和交付研究报告。它证明目标技术路线的若干关键组件可以工作，但没有完成 Worker 内生产集成，也没有满足 PR-ready 条件。

```text
GOAL: ZCODE_OFFICIAL_HOST_INTEGRATION_V1

ARCHITECTURE:
  ADR_032_COMPLIANCE: PASS_FOR_RESEARCH_AND_ISOLATED_POC
  INDEPENDENT_COMPANION: REMOVED
  NEW_IPC: NOT_REQUIRED
  NEW_DATABASE: NOT_REQUIRED
  UPSTREAM_BINDING: DESIGNED / NOT_IMPLEMENTED

OFFICIAL_SOURCE:
  SOURCE_BASELINE: b95ebaffeab641907b38652f45c1502bd762972d
  SOURCE_TREE: d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d
  SOURCE_BUILD: PASS
  ARTIFACT_CLOSURE: PARTIAL
  NODE_ABI: PARTIAL
  REDISTRIBUTION: PARTIAL / OWNER_APPROVAL_NOT_GRANTED

HOST:
  MINIMAL_HOST_ASSEMBLY: PASS_FOR_ISOLATED_MOCK
  DESKTOP_MAIN_INDEPENDENCE: NOT_RUN
  OFFICIAL_PROCESS_MANAGER: PASS_FOR_ISOLATED_MOCK
  AGENT_RUNTIME: PASS_FOR_ISOLATED_MOCK
  MOCK_AGENT_E2E: PASS_FOR_ISOLATED_MOCK
  TOOL_ROUNDTRIP: PASS_FOR_ISOLATED_MOCK
  SESSION_RESUME: PASS_FOR_ISOLATED_MOCK
  CANCELLATION: PASS_FOR_ISOLATED_MOCK

LIFECYCLE:
  PROCESS_OWNERSHIP: PARTIAL
  WINDOWS_JOB: PASS_FOR_HELPER_ACCEPTANCE_AND_OBSERVED_MOCK
  HELPER_CLEANUP: PASS_FOR_OBSERVED_MOCK
  CLEANUP_PROOF: BLOCKED / PROPOSED_CONTRACT
  HOLD_RECOVERY: PASS_IN_EXISTING_PATH
  RELEASE: PASS_IN_EXISTING_PATH / BLOCKED_FOR_NEW_PATH

ACCOUNT:
  OFFICIAL_ACCOUNT_SERVICE: PARTIAL / NOT_FULLY_ASSEMBLED
  SYNTHETIC_CREDENTIAL_FLOW: PARTIAL
  SAME_ACCOUNT_MULTIWORKER: FAIL
  TOKEN_REFRESH_RACE: FAIL
  TOKEN_ROTATION: PASS_SYNTHETIC
  REVISION_PROPAGATION: FRESH_PROCESS_READ_PASS / LIVE_CACHE_NOT_PROVEN
  ACCOUNT_FAILURE_ISOLATION: PASS_SYNTHETIC
  CRASH_LOCK_RELEASE: PASS_SYNTHETIC
  EXISTING_CONCURRENCY: PRESERVED_IN_EXISTING_PATH
  CREDENTIAL_BROKER_NECESSITY: PROPOSED_BY_SYNTHETIC_EVIDENCE_ONLY
  REAL_ACCOUNT_E2E: NOT_RUN

INTEGRATION:
  CODING_AGENT_ADAPTER: NOT_IMPLEMENTED
  MODEL_ROUTING: NOT_RUN_FOR_NEW_PATH
  TOOL_EXECUTION: PASS_IN_ISOLATED_PROBE / NOT_RUN_IN_WORKER
  EVENT_MAPPING: NOT_IMPLEMENTED
  TOKEN_USAGE: PASS_IN_ISOLATED_PROBE / NOT_IMPLEMENTED_IN_BRIDGE
  TERMINAL_MAPPING: NOT_IMPLEMENTED
  SQLITE_AUTHORITY: PRESERVED / NEW_PATH_NOT_INTEGRATED
  RAW_STDOUT_FRAME_GUARD: BLOCKED

QUALITY:
  TARGETED_TESTS: PASS_HISTORICAL
  INTEGRATION_TESTS: NOT_RUN
  STRESS_TESTS: NOT_APPLICABLE_TO_DOCS_ONLY / NOT_RUN_FOR_NEW_PATH
  FULL_REGRESSION: NOT_RUN
  PERFORMANCE: UNKNOWN
  UPGRADE_TEST: NOT_RUN
  ROLLBACK_TEST: NOT_RUN
  ASTRA_REVIEW: PENDING_FINAL_FILE

DELIVERY:
  PRODUCTION_CONTRACTS_PRESERVED: YES
  PRODUCTION_CODE_CHANGED: NO
  PR_READY: NO
  UNRESOLVED_BLOCKERS: 8
  KNOWN_LIMITATIONS: 10

  PRODUCTION_DATA_MODIFIED: NO
  REAL_MODEL_REQUESTS: 0
  REAL_ACCOUNT_REQUESTS: 0
  STARTPLAN_REQUESTS: 0
  BILLING_REQUESTS: 0
  DESKTOP_INTERRUPTED: NO_OBSERVED_INTERRUPTION
  PUSHED: NO
  MERGED: NO
  RELEASED: NO
```

`DESKTOP_INTERRUPTED: NO_OBSERVED_INTERRUPTION` 的边界是隔离环境没有显式启动 Desktop，也没有观察到 Desktop 中断；该实验没有对 Desktop Main 的全部读取和调用路径插桩，因此一般 Desktop 独立性仍为 `NOT_RUN`。

## 2. Owner 问题回答

### 2.1 官方 ZCode 3.18.0 是否已经成功构建为独立制品？

是，限定范围成立。固定 commit/tree 的 CLI/AppServer、自包含 Host module 和 Windows helper 均已生成；复制 `dist`、去除源码 `node_modules` 后，官方 ProcessManager 可执行隔离 Mock。跨 clean-install 的首次 build 不是逐字节相同，完整 native/resource closure 仍为 `PARTIAL`，所以不能称为完全可复现的发行制品。

### 2.2 Worker 是否已经成功装配官方 Host？

否。隔离 probe 装配了官方 ProcessManager、Protocol Client 和 AppServer，但现有 Worker、Manager、SQLite Authority 与 `CodingAgentAdapter` 尚未接入该 Host。

### 2.3 是否完全复用了官方 AgentRuntime、Prompt、Tools 和 Provider？

在隔离 Mock 路径中，AgentRuntime、Prompt、工具编排和 Provider 接入由官方源码制品执行；测试 Provider 是项目内 loopback Mock。生产 Worker 尚无候选接线，不能把隔离行为扩展成生产完成。

### 2.4 是否仍有不必要的官方实现重复代码？

生产代码没有新增平行 RuntimeAdapter，也没有复制 AgentRuntime、Prompt 或 Tool Builder。`UPSTREAM_BINDING_DESIGN.md` 给出的是最小内部适配设计；实现尚未开始，因此该问题只能判为设计合规、实现未验收。

### 2.5 是否保留现有 Worker 并发？

现有代码、Capacity、路径 admission、Claim 和 Worker slots 未被修改，历史 139 项 lifecycle/cleanup 回归仍通过。新官方账户路径尚未接入，而且其 same-profile refresh 合成测试失败；生产残留合同虽保留，但新路径不能宣称支持现有并发。

### 2.6 同账户多 Worker 是否经过验证？

经过合成验证，结论是失败。两个真实 Node 子进程在 barrier 后使用同一一次性 refresh token，两个网络请求都到达 loopback Mock；第一次完成 rotation，第二个收到 `409 rotation_reuse_rejected`。

### 2.7 官方 ProcessManager 与 Bridge Cleanup 是否正确衔接？

正常 Mock 关闭与目标 AppServer/helper PID 清理已观察，但尚未正确衔接 Bridge 的持久 Cleanup Proof 与 Release。官方公开结果没有向 Bridge 提供已接受 schema 所需的持久 Job identity/kernel-empty/helper-exit receipt。`dispose()` 成功不能推出 `cleanup_verified`。

### 2.8 是否保留了 SQLite、Hold、Recovery 和 Release 合同？

现有合同未被修改，历史定向测试通过。由于新路径尚未集成，不能说新路径未来继续满足这些合同；Cleanup 新路径目前必须 fail closed。

### 2.9 相比原 Companion 方案减少了哪些组件和维护工作？

目标不再增加独立 Companion 进程、Companion IPC、业务 SQLite、平行 RuntimeAdapter、Shared AppServer Pool、第二套 Task 状态机或 Recovery。实现只允许在现有 Worker 内增加普通 Upstream Binding，并复用官方 ProcessManager/AppServer。

### 2.10 相比原直接 AppServer 方案减少了哪些上游兼容负担？

设计上由官方 ProcessManager 负责正常 AppServer/helper 生命周期，官方 AppServer 负责 AgentRuntime、Prompt、Tools 和 Provider；Binding 不再维护官方私有 RPC 执行逻辑。实际收益仍待 Worker 接线与完整 parity 测试证明。

### 2.11 当前还有哪些真实账户和发布限制？

真实 OAuth、真实账户、Start Plan、Billing 和真实模型请求均未执行；same-profile 多 Worker 有可复现反例；完整 Desktop 独立性、真实 entitlement 收敛、BOM/许可、native/resource closure 和 rollback 仍未完成。

### 2.12 是否已经达到 PR-ready？

否。没有 `OfficialHostAdapter`、Worker 接线、raw-frame 等价边界、Cleanup Proof mapping、账户协调合同、候选路径回归、完整发布门禁、性能比较、升级/回滚演练和 Astra 最终批准。

### 2.13 如果现在提交 PR，最需要关注的三个风险是什么？

1. 两次 refresh 可消耗同一一次性 token family，导致同账户其他 Worker 失败或账户状态异常。
2. 官方 transport 没有等价 16 MiB raw stdout frame 上限，可能违背现有资源防护合同。
3. 官方正常关闭事实不能被安全映射成 Bridge Cleanup/Release proof，存在错误释放 Capacity 的风险。

## 3. 接受、阻断与延后

### ACCEPTED

- ADR-032 的现有 Worker 内官方 Host 目标拓扑已被遵守。
- 固定 3.18.0 源码、自包含 Host module 和 Windows helper 已在限定环境生成。
- official ProcessManager/AppServer 在 localhost Mock 中完成 session、两次主 Turn 请求、官方 Read、same-session resume、cancel、usage 和目标 PID 清理。
- credential file RMW lock、session revision CAS、fresh-process revision/token 读取、failure isolation 和 crash-lock release 的窄合成路径可运行。
- 现有 Bridge 的 33 项 auth 和 139 项 lifecycle/cleanup 定向回归保留通过，ADR-030 与 Proposed 状态未被改写。

### BLOCKED

1. General account cross-process refresh single-flight 未解决。
2. 官方 transport 的 16 MiB raw stdout frame 等价边界未解决。
3. 官方 cleanup facts 到 Bridge Cleanup/Release proof 的 Accepted mapping 未解决。
4. `OfficialHostAdapter` 与现有 Worker 的生产接线未实现。
5. 完整 native/resource closure、BOM、许可与数据 rollback 未完成。
6. Workspace/identity、timeout/restart、Browser/MCP 和崩溃故障矩阵未证明。
7. 真实 Start Plan/账户/模型 E2E 按安全边界未运行。
8. 完整回归、Astra 最终批准和 PR-ready 门禁未满足。

### DEFERRED

- Desktop UI 能力对齐和全部 Desktop 工具移植。
- Shared AppServer Pool 和资源效率优化。
- 多租户认证框架。
- 多 Runtime 版本并行支持。
- 性能优化、token/cache 改写和 Provider headers 调整。

## 4. 关键证据

| 证据 | 结果 | 路径 |
|---|---|---|
| 固定源码构建 | `PASS` | `OFFICIAL_SOURCE_BUILD.md` |
| Host module 重复 bundle | `PASS`；1,611,888 bytes | `SOURCE_ARTIFACT_BOM.md` |
| 当前最新 ProcessManager Mock r9 | `12/12 PASS` | `.run/official-host-poc/runs/process-manager-r9/evidence/process-manager-result.json` |
| r9 AppServer/helper PID | `13464/9580`、`11224/24124`；最终为空 | r9 evidence |
| Mock 请求 | 3 次 loopback HTTP；2 次主 Turn + 1 次标题辅助 | r9 evidence |
| Usage | input 200、output 20、total 220 | r9 evidence |
| Same-profile 双 Worker | `FAIL`；第二次 refresh HTTP 409 | `.run/lifecycle-account-evidence/g4-harness/runs/2026-11-11T12-35-56.153Z-24920/result.json` |
| Bridge Start Plan/private auth | 33/33 PASS_HISTORICAL | `REGRESSION_REPORT.md` |
| Bridge lifecycle/cleanup | 139/139 PASS_HISTORICAL | `REGRESSION_REPORT.md` |

## 5. 交付边界

本分支只有架构文档、研究与验收报告，没有修改生产源码、官方源码、SQLite、插件 bundle 或运行配置。本轮没有提交、Push、创建 PR、Merge、Tag 或 Release。即使后续完成本地 commit，该结论仍表示候选分支不满足 PR-ready 的技术条件。

进入下一阶段的首要输入不是继续写 Adapter，而是 Owner 对两项合同问题作出裁决：

1. 在现有 Worker、Manager 或官方 account service 内采用哪一种最小 cross-process refresh coordination；
2. 是否为固定官方 transport 引入窄 upstream option/patch，以保留 16 MiB raw-frame 合同。

同时，Cleanup Proposed ADR 必须先明确持久 Job identity/receipt 或最小只读 verifier，才能继续生产 Release 接线。
