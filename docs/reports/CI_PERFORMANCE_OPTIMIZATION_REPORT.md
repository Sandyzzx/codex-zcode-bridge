# CI Execution Cost and Windows Test Optimization

> Status: RESEARCH
> Date: 2026-11-21
> Base: `origin/preview` `c1245a02f8f9d4b6e1102eabac230b657d85de9b`
> Base tree: `b687bca64ce766b945178cf8af44442cf57f90b3`
> Candidate branch: `codex/ci-performance-test-optimization-20261120`
> Worktree: `D:\codex-zcode-bridge\.run\ci-performance-test-optimization-20261120`

## 1. 结论

当前最昂贵的工程成本不是 TypeScript、npm 安装或插件构建，而是 Windows 上约 12–13 分钟的 `npm test`。因此本轮优先级调整为：

1. 消除同一 PR/同一代码树的重复门禁。
2. 拆分超大 real-adapter 测试，让 Targeted 选择真正缩小。
3. 把 32,000-event 压力合同从普通 PR 门禁移到独立 Stress，同时保留一个仍能证明真实 Windows 管道背压的常规负载。
4. 改善 Draft、Ready、FULL、Preview Push 的触发分工。
5. 对 Windows 两路分片做独立实验，但不在稳定性尚未完成托管 Runner 验证时设为 Required Check。

没有删除功能测试、增加 SKIP、弱化断言、提高测试内部 timeout，或以 Mock 替换唯一的真实进程边界。

### 1.1 已定位的上一次 CI 失败

PR #106 的 HEAD `19c04d25899c9314d0b93a7efbafb37fa5b3f947` 在 Windows Verify 失败：

```text
SQLite production Worker survives streaming stderr backpressure without a diagnostic recorder
duration: 49,079 ms
task ... did not reach terminal status; observed: running
```

这是普通 PR 测试实际运行 32,000 个流事件的成本造成的门禁失败，不是产物构建或认证失败。当前候选：

- 普通门禁保留 4,096 个事件，仍真实写入约 3.80 MB、超过 Windows 管道容量，并记录 `high_water_mark=16384`、`max_writable_length=0`。
- 原 32,000-event 负载完整保留在独立 `WORKER-STREAM-STRESS-01`。
- 拆分后的 ordinary test 已在本地 Windows 运行中约 8.6 秒通过。

## 2. 基线

### 2.1 触发链与重复运行

GitHub Actions API 的 20-PR 历史样本显示：

| 指标 | 基线 |
|---|---:|
| PR 样本数 | 20 |
| PR 触发 Run | 52 |
| 平均 PR Run/PR | 2.6 |
| 同期 `workflow_dispatch` Run | 5 |

旧流程在同一 PR 的连续 push 上可同时保留过期运行；`ready_for_review` 也不是默认 `pull_request` 类型，Draft 转 Ready 可能不触发正式门禁。非 FULL PR 还会在 Fast 和 Integration 分别支付 T0。FULL PR 的完整回归、普通 Push 和手动验收没有可复用的跨 Run 验证凭据，不能安全地用“上一轮通过”代替。

Actions 历史不能稳定提供 PR 编号、每个 Run 的 FULL 选择和逐 Job 计费字段，因此以下基线项明确为 `NOT_MEASURED`：

- 每次 PR 更新的 FULL_SUITE 次数。
- PR 从提交到全部 Required Check 完成的历史 P50/P95。
- 官方 GitHub runner-minutes 账单值。

### 2.2 Windows Verify 历史样本

最近 8 次同类型 Windows Verify：

```text
802s, 714s, 820s, 842s, 823s, 777s, 823s, 804s
```

| 指标 | 基线 |
|---|---:|
| P50 | 812s |
| P95 | 835.35s |
| 8 次 Job 墙钟合计 | 7,890s |
| 换算近似 runner-minutes | 131.5 |

这里使用 Job 墙钟求和近似观察成本，不宣称等于 GitHub 官方计费分钟。

### 2.3 主要测试成本

基线单次 Windows 完整回归中的声明耗时汇总：

| 文件 | 累计 | 数量 | 单项最大 |
|---|---:|---:|---:|
| 原 `mvp-real-adapter.test.ts` | 746.716s | 46 | 35.854s |
| `composition.test.ts` | 399.654s | 41 | 54.250s |
| `failure-facts-integration.test.ts` | 173.765s | 33 | 15.000s |
| `zcode-app-server-adapter.test.ts` | 106.773s | 33 | 9.300s |
| `browser-host-adapter.test.ts` | 57.396s | 8 | 17.622s |
| 原 `session-frames.test.ts` | 57.268s | 9 | 10.042s |
| `process-lock.test.ts` | 43.415s | 19 | 15.698s |

长耗时主体是真实 Worker、Windows 进程身份/树清理、SQLite Recovery/CAS、32 MiB Result、stdio/MCP 管道和 AppServer 生命周期。不能通过 Mock 或删除合同解决。

## 3. 已实施改进

### 3.1 PR Run 去重与 Draft/Ready 分流

`.github/workflows/ci.yml` 现在：

- 显式监听 `opened`、`synchronize`、`reopened`、`ready_for_review`。
- concurrency group 按同一个 PR 隔离，`cancel-in-progress` 只取消该 PR 的过期 Run。
- Preview/Master Push 和 `workflow_dispatch` 不被后续 PR 自动取消。
- Draft PR 只运行 Impact 和 Fast。
- `ready_for_review` 会重新进入正式的 Impact/Fast/Integration/Release/Stress/Cost Lab 选择。
- FULL PR 不在 Fast 或 Integration 重复跑部分完整套件，由 Release 在 Windows/Ubuntu 各执行一次。

跨 Run 的“上次已经通过”没有被当作本轮验证。只有同一 workflow run、同一代码 SHA 的 Fast T0 被 Integration 复用。

### 3.2 一次 T0，而不是两份

Fast 在 Ubuntu 完成平台无关 T0：

- typecheck
- build
- plugin validation
- generated freshness
- `git diff --check`

非 FULL PR 的 Windows Integration 只执行：

- Windows `npm run build`
- Windows Worker 进程身份探针
- `test:affected -- --tests-only`

这样不重复 T0，同时保留 Windows 二进制/进程/测试边界。`--tests-only` 仍要求显式 Base、`CODEX_BRIDGE_CI_T0_COMPLETED=1`、TARGETED 选择和同一 Run/SHA 的成功 Fast 前置条件。

### 3.3 Cost Lab 独立门禁

`tools/cost-lab/**` 不再位于 `full_suite_paths`，而由 `cost-lab` domain 输出 `cost_lab_required`：

- Cost Lab-only PR 不再强制 Bridge FULL_SUITE。
- 新 `Cost Lab tests` Job 独立运行 `npm run cost-lab:test`。
- forced-full、Preview/Master Push 和 `workflow_dispatch` 也运行该 Job，避免无法取得可信 changed-file 集合时静默跳过。
- Bridge 共享生产代码、执行器、Impact Map 或未知 `scripts/**` 变化仍按 fail-closed 规则进入原有覆盖。
- 该变更不触碰生产 Bridge、认证、Worker、Manager、SQLite Authority 或插件 Bundle。

### 3.4 超大 real-adapter 文件按合同拆分

原 2,405 行、46 个自动测试文件拆为：

| 文件 | 合同域 | 自动测试 |
|---|---|---:|
| `mvp-real-adapter-official-host.test.ts` | Official Host / Cleanup / Release | 6 |
| `mvp-real-adapter-private-auth.test.ts` | Private Auth / Lease / Secret | 19 |
| `mvp-real-adapter-result-lifecycle.test.ts` | Result / Recovery / Cleanup | 12 |
| `mvp-real-adapter-routing-admission.test.ts` | Routing / Admission / Identity | 8 |
| `mvp-real-adapter-runtime-events.test.ts` | Runtime Event latch | 1 |
| `mvp-real-adapter-harness.ts` | shared fixture | Fixture |

这些文件仍是 Windows-only Integration，不允许在 Linux 上用 Fake 或 SKIP 冒充。Routing/Admission 明确映射了真实 Worker、SQLite、Manager、MCP、Provider、进程清理和 Cleanup/Release 依赖。

拆分后 Targeted 修改只选择相关合同，不再无条件运行整个 12 分钟文件。完整 `npm test` 仍包含全部 46 个功能合同，不依赖拆分文件数量宣称覆盖率。

测试标题对账结果：原文件 46 个功能测试；拆分后仍有 46 个功能测试，唯一变化是 stream 用例被明确改名为 bounded 负载，并额外产生 1 个 32,000-event Stress。没有遗漏或凭空新增其他功能合同。

### 3.5 Stream 负载分级

| Gate | 事件数 | 用途 |
|---|---:|---|
| 普通 Windows 功能测试 | 4,096 | 真实 Windows 同步管道背压、UTF-8、事件顺序、Result/Cleanup |
| `WORKER-STREAM-STRESS-01` | 32,000 | 原大规模持续输出、持久化、Result、Cleanup/Release 压力 |

普通负载观测：

- 写入约 3,796,910 bytes。
- `high_water_mark = 16384`。
- `max_writable_length = 0`。
- 4096 个事件全部写入且顺序保持。

这不是用“小数据 PASS”替换 32,000-event 压力，而是把大负载放到明确 Stress，把仍超过常规管道容量的负载留在普通门禁。

### 3.6 依赖映射与生成物

Impact Map 已修正：

- 新拆分文件进入 Windows-only 与 Test Impact Map。
- 共享 real-adapter harness 变化进入完整测试基础设施回退。
- `scripts/test-shard.mjs`、分片计划、生成物复制与 fixture 依赖已登记。
- 未知可执行 `scripts/**`、测试基础设施、CI、release/build 合同继续 fail-closed。
- `test:inventory`、`check:generated`、`validate:plugin` 和 `git diff --check` 保留。

### 3.7 已保留的前一阶段优化

前序候选中的 32 MiB canonical-result 优化继续保留：

- ASCII、中文、emoji、引号、NUL 与 lone-surrogate 语义使用 64 KiB 有界负载检查。
- 实际上限仍验证一次精确接受和一次 `+1` 拒绝。
- 独立真实 SQLite 用例继续验证 32 MiB 原文、Digest、CAS 和 Recovery。
- 真实 MCP stdio 与 Worker pipe 的 32 MiB 边界没有被缩小。

Impact Selector 的未知源码、未知可执行脚本、测试基础设施和 CI fail-closed fallback 也保留。

## 4. Windows 两路分片实验

### 4.1 计划

`test/windows-test-shard-plan.json` 只覆盖当前 Windows 自动功能测试，不包含 Stress：

| Shard | 文件数 | 估计耗时 |
|---|---:|---:|
| 1 | 48 | 721.501s |
| 2 | 45 | 749.419s |
| 计划失衡 |  | 3.7% |

校验器要求：

- 恰好两个 Shard。
- 所有自动测试出现且只出现一次。
- 不包含 Fixture、MANUAL_E2E、Windows-only 误用或 Stress。
- Shard 估计等于其测试估计之和。
- 失衡低于 15%。
- 两个 Shard 使用独立 TEMP、HOME、fixture 和 SQLite root。
- 聚合 Job 只有在两个 Shard 都成功时成功。

实验入口为：

```text
node scripts/test-shard.mjs --shard=1/2
node scripts/test-shard.mjs --shard=2/2
```

### 4.2 历史实验中的不确定项

在拆分文件后的前四组本地运行中，曾出现：

- Windows 路径过深导致 `unable to open database file`。
- 一次 `shutdown_release_unverified`。
- 一次 Routing/Admission 的第二任务在 75 秒内未观察到 `released`，但单文件复跑通过。

这些失败被保留在 `.run/shard-stability-20261121/`，未改为 SKIP，也未通过放宽断言消除。新的 harness 现在在 lifecycle 等待失败时附带最终 status、Attempt、phase、issues 和事件 trail，便于下次复现定位。

首次远程注册实验 Workflow 时，GitHub 在创建 Job 前拒绝执行：`runner` context 不能用于 Job-level `env`。该失败没有启动 Windows Runner，也没有消耗测试 Job。已改为在 step-level 使用 `runner.temp`，先创建每 Shard 的 TEMP/fixture 目录，再运行测试；同时新增回归，禁止把 `runner.temp` 放回 Job-level `env`。

### 4.3 当前三轮结果

分片在本地 Windows 上连续运行。每轮两个 Shard 使用独立 fixture/TEMP；不改 timeout、不并发启动同一 Workspace。

| 轮次 | Shard 1 | Shard 2 | 结果 |
|---|---:|---:|---|
| Round 5 | 482 tests：481 PASS / 1 SKIP；590.056s | 484 tests：483 PASS / 1 SKIP；571.601s | PASS |
| Round 6 | 482 tests：481 PASS / 1 SKIP；585.653s | 484 tests：483 PASS / 1 SKIP；574.814s | PASS |
| Round 7 | 482 tests：481 PASS / 1 SKIP；589.631s | 484 tests：483 PASS / 1 SKIP；580.242s | PASS |

三轮全部为 `FAIL=0`，每轮两个 Shard 合计 966 个功能声明、964 PASS、2 个既有平台 SKIP。三轮较慢 Shard 为 590.056s、585.653s、589.631s，配对失衡为 3.1%、1.9%、1.6%。

本地三轮只证明当前机器和当前计划的可重复性；GitHub Windows 托管 Runner 的分片实验仍标记 `NOT_RUN`，因此：

- `test:shard` 保持 experimental。
- 没有把分片 Workflow 设为 Required Check。
- 没有把本地墙钟直接换算成 GitHub P50/P95 或 runner-minutes。

## 5. 验证记录

### 5.1 已完成

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run build:test` | PASS |
| Impact Selector + Shard Plan focused tests | 22/22 PASS |
| `npm run cost-lab:test` | 86/86 PASS（首次命中既有临时端口 `bad port`，立即复跑通过） |
| `npm run test:stress` | 4/4 PASS |
| `npm run test:clean-entrypoints` | 4/4 PASS |
| `npm run validate:plugin` | PASS |
| `npm run check:generated` | PASS |
| `npm run test:inventory` | PASS；905 declarations / 100 mapped files |
| `git diff --check` | PASS |
| Windows shard rounds 5–7 | PASS，每轮两个 Shard 均 PASS |
| `npm run test:affected` full fallback | PASS；966 tests / 964 PASS / 0 FAIL / 2 existing SKIP；当前机器串行耗时 1,161.362s |

### 5.2 未运行或未取得

| 项目 | 状态 |
|---|---|
| GitHub 托管 Windows 两路分片 | NOT_RUN |
| 分片后的 GitHub Windows Verify P50/P95 | NOT_MEASURED |
| 分片后的 PR Completion Wall Time | NOT_MEASURED |
| 官方 runner-minutes | NOT_MEASURED |
| 新候选的 PR CI | PENDING PUSH |

`NOT_RUN`、`NOT_MEASURED` 和 `PENDING` 不计为 PASS。

## 6. 优化收益与边界

### 6.1 已实测有效

- 同一 PR 的过期 Run 可取消。
- Draft → Ready 不再漏掉正式门禁。
- 非 FULL PR 不再在 Ubuntu Fast 和 Windows Integration 各跑一次 T0。
- Cost Lab-only 变更不再强制 Bridge FULL_SUITE。
- real-adapter Target 可缩小到单一合同文件。
- 32,000-event 压力不会阻塞普通 PR；原压力合同仍存在。
- 拆分后的 ordinary stream 用例在本地 Windows 恢复为秒级。

### 6.2 仅改善 Targeted PR

- real-adapter 五个合同文件的 Impact Map 精度。
- source/import 与 fixture 的直接依赖选择。
- `--tests-only` 只运行所选测试。

这些改善不自动证明完整 `npm test` 墙钟按同一比例下降。

### 6.3 可降低 runner 成本

- PR 过期 Run cancellation。
- Draft 只跑 Impact/Fast。
- FULL 只保留 Release 双平台完整回归。
- Cost Lab 单独短 Job，不拖起 Bridge 全套。

### 6.4 可能降低墙钟但不降低总测试量

- Windows 两路分片。
- Windows 托管 Runner 的分片结果尚未取得；在设置 Required Check 前必须完成真实的 3 轮稳定性和聚合检查验证。

### 6.5 不建议或尚未证明

- 不应简单把所有 Windows 测试改为全局并行。真实 Worker、CIM、SQLite WAL、进程树和 Recovery 会互相污染。
- 不应把 4,096-event 普通负载当作 32,000-event 压力等价证据。
- 不应把历史 Run 的 PASS 复用于不同代码树或不同测试基线。
- 不应因 CI 变绿而扩大 Impact Map、降低断言或增加 SKIP。

Cost Lab 首次复跑出现一次既有临时端口选择触发 Node `fetch` `bad port`，立即复跑 86/86 PASS。Cost Lab 代码与端口实现本轮未修改，因此记录为残余测试随机性，不将单次通过写成稳定性证明，也不在无关范围内顺带修复。

## 7. 剩余工作

1. 在 GitHub 上执行修正后的 Windows Shard Experiment，取得托管 Runner 的真实墙钟、失败率和 runner-minutes。
2. 若托管分片稳定，再评估是否增加 Required Check 与 Push/Preview 的适用范围。
3. 重新运行受影响测试、生成物检查和完整 Diff 检查。
4. 提交并推送候选；PR CI 通过前不得合并 Preview。

## 8. Git 与交付状态

实现提交为 `e8214366bd4077983aec5641936031e97b804a3d`，Tree 为
`ccd47d649102b63f0da05f5fe422049e9b6ed9e4`，位于
`codex/ci-performance-test-optimization-20261120`。该实现提交之后只允许追加本报告状态和
PR CI 结果的文档提交，不再改变测试或 Workflow 行为。根工作区的 `M AGENTS.md` 和
`?? $null` 未被读取、修改、暂存或清理。

PR: `https://github.com/Sandyzzx/codex-zcode-bridge/pull/106`

未执行 Merge、Release、Tag、Marketplace 更新或生产部署。

```yaml
GOAL: CI_EXECUTION_COST_AND_WINDOWS_TEST_OPTIMIZATION

PR_TRIGGER_DEDUP: PASS
READY_FOR_REVIEW_GATE: PASS
DRAFT_FORMAL_GATES: SKIPPED_BY_DESIGN
COST_LAB_DECOUPLING: PASS
REAL_ADAPTER_SPLIT: PASS
STREAM_STRESS_SEPARATION: PASS

WINDOWS_SHARD_PLAN: PASS
WINDOWS_SHARD_LOCAL_ROUNDS: 3_OF_3_PASS
WINDOWS_SHARD_HOSTED: NOT_RUN
WINDOWS_SHARD_REQUIRED_CHECK: NO
FULL_FUNCTIONAL_REGRESSION: SHARDED_3X_PASS

TEST_COVERAGE_PRESERVED: YES
TEST_ASSERTIONS_WEAKENED: NO
SKIP_ADDED: NO
PRODUCTION_CODE_CHANGED: NO
SQLITE_AUTHORITY_CHANGED: NO
HOST_WAKE_CHANGED: NO
PLUGIN_BUNDLE_CHANGED: NO

REAL_MODEL_REQUESTS: 0
REAL_OAUTH_REQUESTS: 0
REAL_BILLING_REQUESTS: 0

CI_PRIMARY_BASELINE: WINDOWS_NPM_TEST
CI_POST_CHANGE_P50_P95: NOT_MEASURED
RUNNER_MINUTES: NOT_MEASURED
PR_CI_AFTER_PUSH: PENDING
IMPLEMENTATION_COMMIT: e8214366bd4077983aec5641936031e97b804a3d
IMPLEMENTATION_TREE: ccd47d649102b63f0da05f5fe422049e9b6ed9e4
REMOTE_BRANCH: codex/ci-performance-test-optimization-20261120

MERGE_ALLOWED: NO
RELEASE_ALLOWED: NO

FINAL_VERDICT: PENDING_PR_CI
```
