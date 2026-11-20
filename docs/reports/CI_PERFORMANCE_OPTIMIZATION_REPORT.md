# CI Performance and Test Content Optimization

> Status: RESEARCH
> Date: 2026-11-20
> Base: `origin/preview` `c1245a02f8f9d4b6e1102eabac230b657d85de9b`
> Base tree: `b687bca64ce766b945178cf8af44442cf57f90b3`
> Candidate branch: `codex/ci-performance-test-optimization-20261120`

## 1. 结论

本轮没有删除测试、增加 SKIP、降低断言、缩短生产 timeout 或移除非 Windows 平台覆盖。实施集中于四类可独立验证的改动：

1. FULL PR 只执行一次完整双平台回归，不再同时运行 Fast T0 和部分 Integration。
2. Integration 自己执行一次 T0，随后通过受控 `--tests-only` 入口只运行所选测试。
3. 修正 Impact Map 的直接依赖漏选，并为未知 `scripts/**` 建立 FULL fallback。
4. 将 32 MiB 合同中的编码/转义检查改为有界负载，仅保留一次真实上限与一次 +1 边界。

Windows 纯单元 `--test-concurrency=2` 实验的绝对收益不足以抵消分类和调度复杂度，因此没有修改全局 Windows 并发或引入第二套 Test Runner。

## 2. 基线

### 2.1 Git

| 项目 | 值 |
|---|---|
| Repository | `Sandyzzx/codex-zcode-bridge` |
| Base branch | `preview` |
| Base commit | `c1245a02f8f9d4b6e1102eabac230b657d85de9b` |
| Base tree | `b687bca64ce766b945178cf8af44442cf57f90b3` |
| Worktree | `D:\codex-zcode-bridge\.run\ci-performance-test-optimization-20261120` |
| Branch | `codex/ci-performance-test-optimization-20261120` |

根工作区已有 `M AGENTS.md` 和 `?? $null` 未被读取、修改、暂存或清理。

### 2.2 Windows 完整回归

基线本地执行 `npm test`：

| 指标 | 结果 |
|---|---:|
| Tests | 961 |
| PASS | 959 |
| FAIL | 0 |
| SKIP | 2（既有平台条件） |
| Node duration | 2,288,852.7287 ms |
| Wrapper elapsed | 2,313.079 s |
| 新增 SKIP | 0 |

日志保存在任务 Worktree 的 `.run/baseline-full-test.log`，不提交。

### 2.3 GitHub Actions

公开 Actions 页面中 7 次可比运行：

| Run | Event/context | Wall | Windows Verify | Ubuntu Verify |
|---|---|---:|---:|---:|
| `44726713450` | preview push #105 | 11m59s | 11m54s | 1m24s |
| `44724303810` | PR #105 | 13m56s | 13m40s | 1m27s |
| `44723395810` | failed PR #105 | 14m18s | 14m02s | 1m29s |
| `44675126776` | preview push | 13m48s | 13m43s | 1m25s |
| `44673275490` | PR #104 | 13m11s | 12m57s | 1m36s |
| `44659449928` | preview push | 14m01s | 13m43s | 1m32s |
| `44657234905` | PR #103 | 13m38s | 13m24s | 1m35s |

Wall Time P50 为 13m48s，最大值为 14m18s。Windows Verify P50 为 13m40s；Ubuntu Verify P50 为 1m29s。公开 HTML 没有稳定的 Queue Time 或逐 Job Runner Minutes，本报告不把 Actions 使用页面的累计分钟数和 Wall Time 混用。

## 3. 最慢测试

按单次基线日志中的声明耗时汇总到文件：

| 文件 | 累计 | 数量 | 单项最大 |
|---|---:|---:|---:|
| `test/sqlite-candidate/wp6b-wiring/mvp-real-adapter.test.ts` | 746.716s | 46 | 35.854s |
| `test/sqlite-candidate/wp6b-wiring/composition.test.ts` | 399.654s | 41 | 54.250s |
| `test/failure-facts-integration.test.ts` | 173.765s | 33 | 15.000s |
| `test/zcode-app-server-adapter.test.ts` | 106.773s | 33 | 9.300s |
| `test/browser-host-adapter.test.ts` | 57.396s | 8 | 17.622s |
| `test/session-frames.test.ts` | 57.268s | 9 | 10.042s |
| `test/batch2-evidence.test.ts` | 53.618s | 10 | 17.455s |
| `test/process-lock.test.ts` | 43.415s | 19 | 15.698s |
| `test/mcp-result-v14.test.mjs` | 31.633s | 1 | 31.633s |
| `test/sqlite-candidate/wp6b2b1/admission.test.mjs` | 26.979s | 34 | 5.931s |

关键长项主要是：

- 6 个 hard Manager exit / restart Recovery 边界。
- 真实 Worker 32 MiB Result、stdio/MCP 和 Windows pipe。
- Start Plan private lease、ACK、身份绑定和真实 Worker 失败路径。
- 官方 AppServer 与 Windows 进程树清理。

这些用例包含 unique process、disk、IPC 或 recovery 缺陷发现价值，不能仅因耗时高而删除或 mock 化。

## 4. 合同覆盖矩阵

| 合同 | Unit | Integration | 真实 Worker | Windows 专项 | Stress |
|---|---|---|---|---|---|
| Admission / Idempotency | YES | YES | YES | YES | YES |
| Launch / Permanent Claim | YES | YES | YES | YES | YES |
| Worker Lifecycle | YES | YES | YES | YES | NOT SOLE |
| Result CAS / Commit ACK Unknown | YES | YES | YES | YES | YES |
| Cleanup / Release | YES | YES | YES | YES | NOT SOLE |
| Workspace Occupancy | YES | YES | YES | YES | YES |
| Host Shutdown / Restart / Recovery | YES | YES | YES | YES | NOT SOLE |
| Official AppServer Protocol | YES | YES | YES | YES | NOT SOLE |
| Coding Plan / Start Plan Auth | YES | YES | YES | YES | NO |
| Private Credential Lease | YES | YES | YES | YES | NO |
| SQLite Schema / v13→v14 | YES | YES | YES | YES | YES |
| MCP Result / Events / stdio | YES | YES | YES | YES | NOT SOLE |
| Windows Process Identity | YES | YES | YES | YES | NOT SOLE |

“NOT SOLE” 表示该层存在覆盖，但不是该合同的唯一或权威证明。压力矩阵仍不能替代真实 Worker、Windows 进程树或 Provider 认证 E2E。

未发现可在不损失独立缺陷发现价值的情况下删除的重复测试。大型 composition/real-adapter 文件没有为了文件长度而拆分；当前 Targeted 选择已按 domain 工作，拆分没有已证明的 CI 收益。

v13→v14 升级、历史 Result/Event 完整性、CAS 和 Recovery 仍属于支持合同，未因“旧版本”而退役。

## 5. Workflow 改造

### 5.1 T0 与 FULL 去重

- `impact` 只在 PR 执行。
- FULL PR：Fast 和 Integration 均跳过；Release 在 Windows/Ubuntu 各执行一次 T0 + `npm test`，Stress 独立执行。
- 非 FULL PR：Fast 在 Ubuntu 执行 T0 + Targeted；需要 Windows Integration 时，该 Job 执行自己的 T0 和进程身份探针，然后通过 `--tests-only` 只运行所选测试。
- Push `preview` / `master` 与 `workflow_dispatch`：不受 PR-only impact 条件影响，继续执行完整 Release 和 Stress。

没有改动 Job 名称，避免无证据地改变潜在 Required Check 身份。GitHub Branch Protection/Rulesets 的读取被当前 GitHub integration 以 403 拒绝，因此无法在本轮宣称已经自动证明 Required Check 配置；保留既有 Job 名称并覆盖普通 PR、FULL PR、Push 和 Dispatch 的条件测试是当前安全边界。

### 5.2 tests-only

`npm run test:affected -- --tests-only --base <sha>`：

- 必须显式提供 Base。
- 必须设置 `CODEX_BRIDGE_CI_T0_COMPLETED=1`。
- 必须产生 TARGETED 选择；FULL、NO_TESTS 和仅有 Stress 的结果不能伪装成 Targeted PASS。
- 不运行 typecheck/build/plugin validation/generated freshness/diff check；这些由同一 Integration Job 的前置步骤负责。
- 不再重复运行注册 Stress；Stress 只由独立矩阵执行。

### 5.3 并发与 timeout

- PR concurrency group 按 PR number 隔离，只取消同一 PR 的过期运行。
- Push/dispatch 不使用 `cancel-in-progress`。
- impact、Fast、Integration、Release、Stress 增加有限 timeout，未修改任何测试内部 timeout。
- 所有涉及 `npm ci` 的 Job 保留 npm cache。

## 6. Test Impact 修正

改动不是扩大 `full_suite_paths` 来掩盖所有问题，而是同时修复实际依赖和未知输入 fallback：

| 输入 | 修正 |
|---|---|
| `scripts/copy-test-assets.mjs` | Full Suite，并归属 test execution contract |
| 新/重命名且未登记的 `scripts/**` | `unknown-executable-script` Full fallback |
| `plugins/codex-zcode-bridge/launch-node24.mjs` | 选中 `node-runtime.test.ts`，保留 Attention/Waiter 关系 |
| `src/adapters/process-spawn.ts` | 选中 process cleanup、composition、real-adapter 和 remediation 消费者 |
| Official AppServer Runtime descriptor | 选中 adapter/capability 直接消费者 |
| Start Plan production auth / model routing | 选中 real-adapter、provider capability 和 auth 消费者 |
| Browser protocol modules | 选中 Official Host adapter 消费者 |

新增回归用 TypeScript AST 检查每个测试的直接 `src/`、`plugins/`、`scripts/`、`tools/` 静态导入是否被其 domain 或 Full Suite 覆盖。该检查只验证现有 Impact Map 的一致性，不创建第二套 Selector。

验证结果：

- 路径发现修改不触发 SQLite Stress。
- Store/schema 修改仍触发冻结参数的 SQLite Stress。
- Copy-test-assets 和未知脚本进入 Full。
- Launcher 选择 node runtime。
- Process-spawn 选择 composition/real-adapter。
- 文档-only 不选测试。
- 重命名、staged/unstaged/untracked 和显式 Base 的纯选择行为保持不变。
- `--list` 与 Impact Map 的实际可执行清单保持一致。

## 7. 测试内容优化

### 已实施：32 MiB 编码数据

`test/sqlite-result-v14.test.mjs` 原先把 ASCII、中文、emoji、引号、NUL、lone surrogate 各自在 32 MiB 的 -1/0/+1 三个大小上构造，单用例耗时 8,600.556 ms。

现在：

- 六种编码/转义规则各用 64 KiB 有界负载验证 exact UTF-8 byte semantics。
- 实际 `MAX_TASK_RESULT_BYTES` 仍验证一次精确接受。
- `MAX + 1` 仍验证一次 `result_too_large`。
- 独立真实 SQLite 用例继续验证 32 MiB 原文写入、SQL CHECK +1、Digest、重复提交、CAS 与 Recovery。
- 真实 MCP stdio 和 Worker pipe 的 32 MiB 用例完全保留。

本机同一文件单次定向运行：8,600.556 ms → 345.51 ms，该子用例减少 8,255 ms。文件总执行从基线 13.566s 降到 4.282s，属于单次本地观测，不作为 CI P50 或固定百分比承诺。

### 未实施

- 不拆分 `composition.test.ts` / `mvp-real-adapter.test.ts`：当前没有证据表明拆文件会降低 Targeted 选择成本。
- 不合并重复 cleanup 用例：每次故障边界对应的 durable state 和迟到事件不同。
- 不删除 v13→v14 或历史 Result/Recovery 测试：这些仍保护支持范围内的数据完整性。
- 不用小数据替换 Worker IPC、SQLite 或 MCP stdio 的真实 32 MiB 验证。
- 不把 Stress 当作性能基准或真实 Provider 证据。

## 8. Windows 并行实验

选取 4 个纯单元文件、47 个声明：

| 模式 | Wrapper elapsed | Node duration |
|---|---:|---:|
| `--test-concurrency=1` | 0.554s | 410.383 ms |
| `--test-concurrency=2` | 0.362s | 236.696 ms |

保存约 0.19s 绝对时间，但该收益只覆盖小型纯单元组；真正耗时在进程、CIM、SQLite、Worker 和 Recovery。自动判定更多文件可并行需要新分类元数据和额外竞态验证，不符合最小改动原则。

结论：`WINDOWS_SELECTIVE_PARALLELISM: NOT_WORTH_IMPLEMENTING`，保持 Windows 生产套件 `--test-concurrency=1`。

## 9. 验证记录

### 已完成

| 检查 | 结果 |
|---|---|
| Test selector focused suite | 19/19 PASS |
| Compile test TypeScript | PASS |
| Test inventory regeneration | PASS |
| `git diff --check` | PASS |
| 32 MiB optimized focused file | 7/7 PASS |
| Windows parallel comparison | PASS；未启用 |
| Windows FULL regression | PASS |
| Windows SQLite Stress | PASS |

### 完整门禁

| 检查 | 状态 |
|---|---|
| typecheck | PASS |
| build | PASS |
| validate:plugin | PASS |
| check:generated | PASS |
| Windows FULL regression | PASS：964 tests / 962 PASS / 0 FAIL / 2 既有 SKIP |
| Windows SQLite Stress | PASS：3/3，Node duration 9,100.5952 ms |
| Ubuntu FULL regression | PENDING CI |
| Ubuntu SQLite Stress | PENDING CI |
| PR CI | PENDING |

不得把 PENDING 或 NOT RUN 写成 PASS。

Windows FULL regression 的 Node duration 为 1,275,734.8523 ms。与基线 2,288,852.7287 ms 相比，这次单次本地观测少 1,013,117.8764 ms；两次运行不是受控 Benchmark，且测试声明从 961 变为 964，因此该差值只记录为环境观测，不归因为本次代码优化。

## 10. 性能结论

已经确定可度量的优化：

- FULL PR 删除重复 Fast T0 Job。
- FULL PR 删除部分 Windows Integration Job。
- 非 FULL Windows Integration 不再在 `test:affected` 内重复 typecheck/build/plugin/generated/diff。
- Targeted 运行不再重复已登记的 Stress。
- 32 MiB 编码子用例本机单次减少约 8.3s。
- Windows SELECTOR 新增测试后完整回归为 962 PASS、0 FAIL、2 既有 SKIP。
- Windows SQLite Stress 3/3 PASS。

尚未测量：

- 优化后 PR Wall Time 的三轮 P50/P95。
- GitHub 托管 Runner 上 32 MiB 优化后的实际 CI 收益。
- Queue Time 和逐 Job Runner Minutes（公开运行页未给出稳定机器可读值）。

因此普通 PR 的 CI Wall Time 性能状态不能在 PR 运行前声明。`PERFORMANCE_VERIFIED` 只适用于上述已直接测量的局部项；整体 CI 目标仍待 CI 数据。

## 11. 剩余瓶颈与风险

- 单次 Windows FULL 的主要成本仍是真实 Worker、6 边界 Recovery、32 MiB MCP/pipe 和 Windows 进程身份测试，不能通过 Mock 或删除覆盖解决。
- 普通 PR 若选择多个 Windows Integration 文件，仍可能接近 25 分钟 timeout；本轮没有改变真实生命周期合同。
- Branch Protection/Rulesets 无法读取，Required Check 是否有隐藏名称依赖需要 Owner 在 GitHub 设置侧核对。
- PR concurrency 只取消同一 PR 的旧 Run；不会取消 Preview/Master Push。
- Impact Map 直接 import 检查发现的是静态依赖；动态构造路径仍需由未知源码/脚本 fallback 保护。

## 12. Git 与 PR

实现 Commit、最终 Tree、远程分支和 PR 在提交、推送与 CI 完成后追加。未合并、未发布、未打 Tag、未修改 Marketplace。

## 13. Astra 审计重点

1. FULL PR 跳过 Fast/Integration 后，Required Check 语义是否可接受。
2. Integration 的 T0 与 `--tests-only` 是否可能被参数绕过。
3. FULL、TARGETED、仅 Stress、NO_TESTS 的退出状态是否严格。
4. Impact Map 新增 domain 是否会无意扩大普通 PR Targeted 集，是否存在可收窄映射。
5. 32 MiB 有界编码优化是否保持精确上限、+1、Unicode、转义、SQLite 和 MCP 合同的独立证明。
6. Windows 不启用局部并行是否合理接受剩余 Wall Time。
7. 未读取 Branch Protection/Rulesets 的风险是否需要在合并前人工确认。

```yaml
GOAL: ZCODE_BRIDGE_CI_PERFORMANCE_AND_TEST_CONTENT_OPTIMIZATION

IMPLEMENTATION_COMPLETE: YES
TEST_COVERAGE_PRESERVED: YES
CI_REGRESSION_PASS: PENDING
PERFORMANCE_VERIFIED: PARTIAL_LOCAL_ONLY
READY_FOR_ASTRA_AUDIT: PENDING

REAL_MODEL_REQUESTS: 0
REAL_OAUTH_REQUESTS: 0
REAL_BILLING_REQUESTS: 0
PRODUCTION_CODE_CHANGED: NO
SQLITE_AUTHORITY_CHANGED: NO
HOST_WAKE_CHANGED: NO
PLUGIN_BUNDLE_CHANGED: NO
```
