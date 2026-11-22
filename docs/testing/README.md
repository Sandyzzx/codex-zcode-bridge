# 测试入口与成本边界

> Status: AUTHORITATIVE
> Last updated: 2026-11-22（Executor Web Deep Link + real-process/synthetic-Worker E2E）
> Last verified: 2026-11-22，核对 `release-candidate` 标签与 `workflow_dispatch.release_gate` 分流、开发期 `FULL_SUITE_DEFERRED_TO_RELEASE_GATE`、Required Check 占位、Push 完整门禁，以及 Web 修复后的 92/92 项受影响测试与 C1 E2E。
> Verified against: `origin/preview` `c941f578ec00834ab0e93f235134d24bf14a827a` + PR #131 `codex/async-executor-rc-20261122`

`test/test-impact-map.json` 为可执行清单唯一来源。共享资格规则禁止 MANUAL_E2E、Fixture 自动执行，显式误传同样拒绝；源 .test.ts/.test.mjs、map 与实际 --list 由回归对账。生成的 test-inventory.json 是静态声明/历史证据索引，不决定执行。

| 入口 | 行为 |
|---|---|
| npm run test:affected | 本地统一入口，必跑 T0（typecheck/build/plugin validation/generated freshness/diff check），按真实依赖选择功能/压力测试；未知源码、未知可执行脚本或基础设施变化标记完整功能回归 |
| npm run test:affected -- --development | CI 开发门禁入口：TARGETED 照常执行；`FULL_SUITE` 在 T0 后先运行直接变更与受影响域的 Unit 安全测试，再明确输出 `FULL_SUITE_DEFERRED_TO_RELEASE_GATE`，不得当作完整回归 PASS |
| npm test | 编译并运行本平台全部功能测试；不隐式执行登记压力矩阵 |
| npm run test:full | typecheck/build/npm test/plugin validation；冻结 Windows 门禁 |
| npm run test:stress | 编译后显式运行登记资源矩阵；支持 --file=<registered file> |
| npm run test:shard -- --shard=1/2 | Windows 两路完整功能测试入口；计划必须覆盖全部自动测试，CI 聚合结果沿用 `Verify (windows-2022)` Required Check |
| npm run test:clean-entrypoints | 无 production dist 的 compiled stdio、shipped launcher、Worker 拒绝和 bundled Core |
| node scripts/test-isolated.mjs --list | 本平台实际默认执行集合 |

FULL_SUITE 表示需要完整功能回归，压力状态为 SEPARATE_STRESS_GATE。开发门禁可显式延期该完整回归；延期标记、文档-only 的 NO_TESTS_APPLICABLE 和 dry-run 的 DRY_RUN_ONLY 都不能称测试 PASS。SQLite 边界的 targeted selection 标记 STRESS_TEST_REQUIRED；压力矩阵只在完整 Release Gate 执行，或由 Owner 明确单独运行。

`npm run test:affected -- --safe-tests-only --base <sha>` 只供同一 workflow run、同一代码 SHA 的 CI Integration Job 使用。Fast 已完成平台无关 T0；Windows Integration 另行构建 Windows 产物和进程身份探针后，只运行所选安全测试。安全集合始终排除 Stress、Manual E2E 与 Fixture；TARGETED 使用正常受影响集合，延期 `FULL_SUITE` 使用直接变更和受影响域的安全测试。该入口要求显式 Base、`CODEX_BRIDGE_CI_T0_COMPLETED=1`，并在没有安全测试时 fail closed；不会接受 NO_TESTS_APPLICABLE 作为跳过门禁的捷径。注册压力测试仍只由独立 Stress Job 执行。`--tests-only` 继续保留给既有 TARGETED CI 调用，语义不变。

## CI 门禁分层

`impact` 先用同一 impact map 做 Windows 全量选择与可执行清单的影子对照，再输出 Fast、Integration、Release、Stress、Cost Lab 和 Release Gate 需求。PR 的 `release-candidate` 标签只在非 Draft 状态生效；手动运行必须显式设置 `release_gate=true`。无效或零 Base SHA 强制 FULL，未知源码、未知 `scripts/**`、测试基础设施、执行器、CI 与核心合同变化也自动 FULL。PR 使用独立 concurrency group，只取消同一 PR 的过期运行；Preview/Master Push 与手动验收不被后续 PR 自动取消。

| Gate | 运行内容 | 成本边界 |
|---|---|---|
| Development Fast | Ubuntu 上的 T0 和可安全执行的受影响测试；FULL 变更明确延期完整回归 | 每次普通 PR、Draft/Ready 转换和手动开发运行保持轻量，不重复完整矩阵 |
| Integration | Windows 上构建 Windows 产物、执行进程身份探针，再以 safe-tests-only 运行所选 Worker、Runtime、SQLite、Result、Cleanup/Release 集成测试及延期 FULL 选择的安全测试 | 复用同一 Run/SHA 的 Fast T0；非 Release Gate 且选择含 Integration 或开发期 FULL 时运行，完整矩阵不在此 Job 重复 |
| Release | Ubuntu 的 typecheck/build、完整 `npm test`、Plugin Validation、生成物 Freshness 与 diff check；Windows 两路并行执行完整分片、身份探针，再由聚合 Job 提供 `Verify (windows-2022)` | `preview`/`master` push、非 Draft `release-candidate` PR 或 `release_gate=true` 时执行；分片计划必须完整、互斥且自动测试全覆盖 |
| SQLite Stress | Windows/Ubuntu 资源矩阵 | 只随完整 Release Gate 执行或由 Owner 明确单独运行 |
| Cost Lab | Windows 上运行独立的 `npm run cost-lab:test` | `tools/cost-lab/**` 不再强制 Bridge FULL_SUITE；选中 Cost Lab、forced-full、Push 和 Dispatch 时独立执行 |

普通 PR 始终保留 `Fast PR gate`、`Verify (ubuntu-latest)`、`Verify (windows-2022)` 与 SQLite Stress 的 Required Check 结果；未请求 Release Gate 时完整 Job 输出明确延期并成功占位。非 Draft Release Candidate 到来后，同一 workflow 运行完整 Ubuntu、Windows 两路分片与 Stress，Fast/Integration 不重复执行。Draft PR 只承担 Impact 和 Development Fast；转为 Ready 会重新选择。Push 直接运行完整保护；`workflow_dispatch` 默认只跑开发门禁，`release_gate=true` 才运行完整保护。Cost Lab 保持独立选择。

Impact Map 的每个测试域必须覆盖其直接 `src/`、`plugins/`、`scripts/` 或 `tools/` 静态导入；这是对现有 map 的一致性回归，不创建第二套 selector。`scripts/copy-test-assets.mjs` 变化强制 FULL；`launch-node24.mjs` 变化至少选择 `node-runtime.test.ts`；`process-spawn.ts` 变化选择 composition、real-adapter 和进程清理消费者。

Windows 进程/身份套件按文件串行；其他平台保留既有 Windows-only 限制并打印排除清单，不通过新增 SKIP 获得绿色。现有 admin-abandonment CLI 测试在 Windows 验证成功/CAS，在其他平台验证 windows_required 且数据库逻辑事实不变；生产 guard 不变。

PR 2.5 开发期的最小定向集合包括：`npm run typecheck`、`npm run build:test`、
`test/executor-lease.test.ts`、`test/executor-ipc.test.ts`、
`test/executor-process.test.ts`、`test/architecture-boundaries.test.ts`、
`test/mcp-server.test.ts`、`test/mcp-stdio-entry.test.ts`、
`test/validate-plugin-root-pattern.test.ts`、`npm run validate:plugin` 和
`npm run check:generated`（提交后）。这组证据不等同完整回归；真实 Desktop
关闭、真实 Official Runtime、strict Wake C/D 仍分别记录 `NOT_RUN`/`BLOCKED`。

PR 3 Task CLI 在同一开发门禁之外至少运行
`node --test dist-test/test/task-cli.test.js`、Task list 的 lifecycle-port
定向用例、`test/executor-lease.test.ts` 的 transition 用例，以及
`npm run build` / `npm run validate:plugin` 对 `dist/task-cli.mjs` 与
`dist/executor.mjs` 的生成物检查。Task CLI 的通过只证明 Control-only 客户端、
同一 Authority 并发读取和本地打包边界，不替代真实 Desktop 关闭或真实 Runtime E2E。

PR 4 Web Console 的定向集合增加
`node --test dist-test/test/web-console.test.js` 与
`test/architecture-boundaries.test.ts` 的 Web 边界用例，以及
`dist/web-console.mjs` 的生成物/Plugin 校验。HTTP smoke 必须在独立 Executor
Root 上完成 loopback session、Host/Origin/CSRF 和“关闭 Console 后 Executor
仍 active”验证；Deep Link/发现专项还必须覆盖实际动态端口、同 Root 二进程
复用同一 URL、跨页 summary、Result pending 独立显示、注意力投影和发现记录
CAS 释放。真实浏览器 HTTP 操作属于 Host E2E，不得用页面成功加载替代
Task/Result/Cleanup 验收。

最终 Web 修复候选另执行 10 个受影响测试文件，共 92/92 PASS，覆盖
AgentReport、架构边界、Executor IPC/Lease/Process、Wake fail-closed、
Thin MCP、Task CLI、Web Console 与 Skill policy。C1 使用真实 Executor /
Web Console / MCP Host / Chromium 进程和 synthetic Worker，验证 Host 退出后
Deep Link 仍可观察、原 Attempt 单 Result/Cleanup/Release 且新 Host 读回同一
Result。该结果是 `REAL PROCESS + SYNTHETIC WORKER`，不是真实 Desktop、
Queue Wake 或 Official Runtime；最终 exact-head Release Gate 在文档更新后
单独运行。

PR 5 Executor Wake 的定向集合增加：

- `node --test dist-test/test/executor-wake.test.js`：策略/授权、App Server
  preflight、Queue ACK、pending/unknown、Turn observation、no-retry 与 Web
  fallback；
- `node --test test/sqlite-candidate/wp6b2b1/lifecycle-port.test.mjs test/sqlite-candidate/wp6c/executor-wake.test.mjs`：
  SQLite v14 Wake evidence、幂等/冲突、Release retry/Continue 兼容；
- `test/executor-process.test.ts` 的跨进程 fake Worker Result -> Cleanup ->
  Release -> Wake -> Web fallback E2E。

不得运行真实 `codex queue`、真实 App Server control socket 或付费模型作为
普通 PR 门禁。严格 C/D、真实 Desktop 关闭与真实模型费用/额度保持独立
`NOT_RUN / BLOCKED`，不能用合成 Queue 或 `QUEUED` 代替。

PR 6 Async Handoff 的定向集合增加 `node --test
dist-test/test/skill-policy.test.js`、`npm run validate:plugin` 与生成物
Freshness。测试验证授权、Scope/Handoff 分离、回执未知、Turn end/断连不取消、
显式取消、Wake 身份冲突、Pending Interaction 和“Wake 不等于验收”的确定性合同；
真实模型遵循率和真实 Host Wake 仍为 `NOT_RUN`，静态 Skill 测试不能替代。

## 退役与保留

JSON B3-05 是 TaskStore/TaskManager 的 32 active/10,000 historical 与 JSON event scan 测试，随旧实现删除，不是 SQLite v14 的性能证据。其 695.904s 集成基线只作为历史成本保留。

SQLite 功能门禁继续覆盖永久 Claim、CAS、路径/Capacity 竞争、Result、Recovery、Interaction、Cleanup、真实 Worker/Windows 管道和 R1–R5。v13 自动/离线升级成功、恢复与回滚测试随 ADR-043 退役；只保留 v13 数据库和旧 Marker 的非破坏性拒绝合同。混合用例保留 Adapter/进程/隐私部分；旧 JSON 写盘、checkpoint、respawn、roster 和专属锁协议退役。

SQLITE-STRESS-01 使用生产 Store/事务 API：0/32/256 已取消历史任务、WAL reader snapshot 与 checkpoint、四进程同 Result CAS、八进程 Admission/Capacity。使用真实 SQLite、隔离根和受控 synthetic identity，不假称真实 Provider/进程树压力认证。旧大 Result 1/2/4/8 资源证据仍独立保留，不把此矩阵推广为任意规模性能保证。

压力资源与功能断言分开报告；不复制 10,000 次 JSON 文件准备，不提高原测试 timeout，不减小 32 MiB 合同，不以 SKIP 或放宽断言换耗时。CI 保留完整 npm test；登记压力矩阵通过独立 CI job 调度。

32 MiB 边界的 UTF-8、引号、NUL 与 lone-surrogate 语义使用 64 KiB 有界负载验证；真实 32 MiB 上限仍验证一次精确接受、一次 +1 拒绝，并由独立 SQLite 用例保留真实写入、CHECK、Digest/CAS 与 Recovery 证据。该优化不替换 Worker IPC、MCP stdio 或真实持久化边界。
