# 测试入口与成本边界

> Status: AUTHORITATIVE
> Last updated: 2026-11-22（Executor 开发期定向验证 / 发布候选完整 CI 分层）
> Last verified: 2026-11-22，核对 `release-candidate` 标签与 `workflow_dispatch.release_gate` 分流、开发期 `FULL_SUITE_DEFERRED_TO_RELEASE_GATE`、Required Check 占位、Push 完整门禁及 Cost Lab/Stress 独立边界；执行证据见 Async Executor PR 2 报告。
> Verified against: `origin/preview` `1bf039fda2ccfd17a992458a871bddd7b48b38c1` + `codex/async-executor-pr2` CI governance revision

`test/test-impact-map.json` 为可执行清单唯一来源。共享资格规则禁止 MANUAL_E2E、Fixture 自动执行，显式误传同样拒绝；源 .test.ts/.test.mjs、map 与实际 --list 由回归对账。生成的 test-inventory.json 是静态声明/历史证据索引，不决定执行。

| 入口 | 行为 |
|---|---|
| npm run test:affected | 本地统一入口，必跑 T0（typecheck/build/plugin validation/generated freshness/diff check），按真实依赖选择功能/压力测试；未知源码、未知可执行脚本或基础设施变化标记完整功能回归 |
| npm run test:affected -- --development | CI 开发门禁入口：TARGETED 照常执行；`FULL_SUITE` 在 T0 后明确输出 `FULL_SUITE_DEFERRED_TO_RELEASE_GATE`，不得当作完整回归 PASS |
| npm test | 编译并运行本平台全部功能测试；不隐式执行登记压力矩阵 |
| npm run test:full | typecheck/build/npm test/plugin validation；冻结 Windows 门禁 |
| npm run test:stress | 编译后显式运行登记资源矩阵；支持 --file=<registered file> |
| npm run test:shard -- --shard=1/2 | Windows 两路完整功能测试入口；计划必须覆盖全部自动测试，CI 聚合结果沿用 `Verify (windows-2022)` Required Check |
| npm run test:clean-entrypoints | 无 production dist 的 compiled stdio、shipped launcher、Worker 拒绝和 bundled Core |
| node scripts/test-isolated.mjs --list | 本平台实际默认执行集合 |

FULL_SUITE 表示需要完整功能回归，压力状态为 SEPARATE_STRESS_GATE。开发门禁可显式延期该完整回归；延期标记、文档-only 的 NO_TESTS_APPLICABLE 和 dry-run 的 DRY_RUN_ONLY 都不能称测试 PASS。SQLite 边界的 targeted selection 标记 STRESS_TEST_REQUIRED；压力矩阵只在完整 Release Gate 执行，或由 Owner 明确单独运行。

`npm run test:affected -- --tests-only --base <sha>` 只供同一 workflow run、同一代码 SHA 的 CI Integration Job 使用。Fast 已完成平台无关 T0；Windows Integration 另行构建 Windows 产物和进程身份探针后，只运行所选测试。该入口要求显式 Base、`CODEX_BRIDGE_CI_T0_COMPLETED=1` 和 TARGETED 选择；不会接受 FULL_SUITE 或 NO_TESTS_APPLICABLE 作为跳过完整门禁的捷径。注册压力测试仍只由独立 Stress Job 执行。

## CI 门禁分层

`impact` 先用同一 impact map 做 Windows 全量选择与可执行清单的影子对照，再输出 Fast、Integration、Release、Stress、Cost Lab 和 Release Gate 需求。PR 的 `release-candidate` 标签只在非 Draft 状态生效；手动运行必须显式设置 `release_gate=true`。无效或零 Base SHA 强制 FULL，未知源码、未知 `scripts/**`、测试基础设施、执行器、CI 与核心合同变化也自动 FULL。PR 使用独立 concurrency group，只取消同一 PR 的过期运行；Preview/Master Push 与手动验收不被后续 PR 自动取消。

| Gate | 运行内容 | 成本边界 |
|---|---|---|
| Development Fast | Ubuntu 上的 T0 和可安全执行的受影响测试；FULL 变更明确延期完整回归 | 每次普通 PR、Draft/Ready 转换和手动开发运行保持轻量，不重复完整矩阵 |
| Integration | Windows 上构建 Windows 产物、执行进程身份探针，再以 tests-only 运行所选 Worker、Runtime、SQLite、Result、Cleanup/Release 集成测试 | 复用同一 Run/SHA 的 Fast T0；只在 TARGETED、非 Release Gate 且需要 Integration 时运行 |
| Release | Ubuntu 的 typecheck/build、完整 `npm test`、Plugin Validation、生成物 Freshness 与 diff check；Windows 两路并行执行完整分片、身份探针，再由聚合 Job 提供 `Verify (windows-2022)` | `preview`/`master` push、非 Draft `release-candidate` PR 或 `release_gate=true` 时执行；分片计划必须完整、互斥且自动测试全覆盖 |
| SQLite Stress | Windows/Ubuntu 资源矩阵 | 只随完整 Release Gate 执行或由 Owner 明确单独运行 |
| Cost Lab | Windows 上运行独立的 `npm run cost-lab:test` | `tools/cost-lab/**` 不再强制 Bridge FULL_SUITE；选中 Cost Lab、forced-full、Push 和 Dispatch 时独立执行 |

普通 PR 始终保留 `Fast PR gate`、`Verify (ubuntu-latest)`、`Verify (windows-2022)` 与 SQLite Stress 的 Required Check 结果；未请求 Release Gate 时完整 Job 输出明确延期并成功占位。非 Draft Release Candidate 到来后，同一 workflow 运行完整 Ubuntu、Windows 两路分片与 Stress，Fast/Integration 不重复执行。Draft PR 只承担 Impact 和 Development Fast；转为 Ready 会重新选择。Push 直接运行完整保护；`workflow_dispatch` 默认只跑开发门禁，`release_gate=true` 才运行完整保护。Cost Lab 保持独立选择。

Impact Map 的每个测试域必须覆盖其直接 `src/`、`plugins/`、`scripts/` 或 `tools/` 静态导入；这是对现有 map 的一致性回归，不创建第二套 selector。`scripts/copy-test-assets.mjs` 变化强制 FULL；`launch-node24.mjs` 变化至少选择 `node-runtime.test.ts`；`process-spawn.ts` 变化选择 composition、real-adapter 和进程清理消费者。

Windows 进程/身份套件按文件串行；其他平台保留既有 Windows-only 限制并打印排除清单，不通过新增 SKIP 获得绿色。现有 admin-abandonment CLI 测试在 Windows 验证成功/CAS，在其他平台验证 windows_required 且数据库逻辑事实不变；生产 guard 不变。

## 退役与保留

JSON B3-05 是 TaskStore/TaskManager 的 32 active/10,000 historical 与 JSON event scan 测试，随旧实现删除，不是 SQLite v14 的性能证据。其 695.904s 集成基线只作为历史成本保留。

SQLite 功能门禁继续覆盖永久 Claim、CAS、路径/Capacity 竞争、Result、Recovery、Interaction、Cleanup、真实 Worker/Windows 管道和 R1–R5。v13 自动/离线升级成功、恢复与回滚测试随 ADR-043 退役；只保留 v13 数据库和旧 Marker 的非破坏性拒绝合同。混合用例保留 Adapter/进程/隐私部分；旧 JSON 写盘、checkpoint、respawn、roster 和专属锁协议退役。

SQLITE-STRESS-01 使用生产 Store/事务 API：0/32/256 已取消历史任务、WAL reader snapshot 与 checkpoint、四进程同 Result CAS、八进程 Admission/Capacity。使用真实 SQLite、隔离根和受控 synthetic identity，不假称真实 Provider/进程树压力认证。旧大 Result 1/2/4/8 资源证据仍独立保留，不把此矩阵推广为任意规模性能保证。

压力资源与功能断言分开报告；不复制 10,000 次 JSON 文件准备，不提高原测试 timeout，不减小 32 MiB 合同，不以 SKIP 或放宽断言换耗时。CI 保留完整 npm test；登记压力矩阵通过独立 CI job 调度。

32 MiB 边界的 UTF-8、引号、NUL 与 lone-surrogate 语义使用 64 KiB 有界负载验证；真实 32 MiB 上限仍验证一次精确接受、一次 +1 拒绝，并由独立 SQLite 用例保留真实写入、CHECK、Digest/CAS 与 Recovery 证据。该优化不替换 Worker IPC、MCP stdio 或真实持久化边界。
