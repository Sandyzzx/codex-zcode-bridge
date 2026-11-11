> Status: RESEARCH
> Date: 2026-11-11
> Bridge baseline: `9710303397fe2d544c75698f783a8174404b2d51` / tree `a9ec733ac02a22b6d27b7cb150abeaae3020569c`
> Observed upstream: ZCode `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d` / `3.18.0`
> Evidence scope: 历史 Bridge 定向回归、隔离官方组件运行和合成账户竞争。没有实现或执行 Worker 内 Official Host 生产接线。

# G6：回归报告

## 1. 回归结论

当前回归为部分通过，不能形成生产切换结论：

```text
REGRESSION_VERDICT: PARTIAL / NOT_READY
BRIDGE_TARGETED_AUTH_AND_LIFECYCLE: PASS_HISTORICAL
OFFICIAL_COMPONENT_MOCK_RUNS: PASS_IN_ISOLATED_SCOPE
OFFICIAL_CREDENTIAL_SUITES: PASS_UNPINNED_TOOLCHAIN
MCP_OAUTH_CROSS_PROCESS_SUITE: PARTIAL_3_OF_4
G4_SYNTHETIC_TWO_WORKER: FAIL
DOCS_ONLY_T0_PIPELINE: PASS
T0_AFTER_FINAL_DOCS: PASS
FULL_REGRESSION: NOT_RUN
ARCHITECTURE_CONTRACT_REGRESSION: NOT_YET_TESTABLE_IN_G5
PRODUCTION_CODE_CHANGED: NO
```

现有定向测试说明当前 Bridge 的 auth、lifecycle、adapter 和 cleanup 逻辑在既有实现中仍有覆盖。它们没有经过 `OfficialHostAdapter`、官方 ProcessManager 与 Worker 生产接线，因此不能作为新路径回归通过证据。

## 2. 回归基线

| 项 | 值 |
|---|---|
| Bridge commit | `9710303397fe2d544c75698f783a8174404b2d51` |
| Bridge tree | `a9ec733ac02a22b6d27b7cb150abeaae3020569c` |
| Official commit | `b95ebaffeab641907b38652f45c1502bd762972d` |
| Official tree | `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d` |
| Official root version | `3.18.0` |
| AppServer version | `0.17.1` |

当前没有生产源码修改。本文不把独立 POC probe 当作 Bridge 生产回归，也不把历史测试结果当作本轮对最终候选重新执行的测试。

## 3. Bridge 定向回归

### 3.1 Start Plan / private auth

执行的测试：

```text
dist-test/test/start-plan-private-lease.test.js
dist-test/test/start-plan-private-channel.test.js
dist-test/test/start-plan-production-auth.test.js
```

结果：

```text
33 passed / 0 failed
```

覆盖重点：

- 每 Issuer/Task 的 entitlement verdict；
- separate tasks 的 Billing 请求隔离；
- Private Lease、HANDLE、ACK；
- competing redeem 与在途 lease；
- shared task / Desktop selection 不串用。

该结果是历史定向证据。它没有执行真实 Start Plan 或 Billing，也没有覆盖同一账户的官方通用 refresh 进程竞争。

### 3.2 Lifecycle、adapter 与 cleanup

执行的测试：

```text
dist-test/test/sqlite-candidate/wp6b-wiring/lifecycle-gate.test.js
dist-test/test/zcode-app-server-adapter.test.js
dist-test/test/windows-process-cleanup.test.js
dist-test/test/windows-cleanup-review-regressions.test.js
test/sqlite-candidate/wp6c/cleanup-release.test.mjs
```

结果：

```text
139 passed / 0 failed
```

与 auth 合并为：

```text
172 passed / 0 failed
```

边界：

- 这 172 项是两个定向集合的合计；
- 不是项目完整 172-test suite；
- 不代表完整 `npm test`；
- 不代表官方 Host 新路径；
- 不代表真实 Cleanup Proof 已导出。

### 3.3 对现有合同的意义

这些测试证明现有路径仍有以下回归基线：

- SQLite Authority 没有被文档研究改动；
- 现有 Cleanup/Release gate 仍可执行；
- 现有 Adapter 行为仍有测试覆盖；
- ADR-030 的 Task-scoped private delivery 未被本轮研究改写；
- Manager/Worker 并发能力在现有实现中没有被这些文档变更直接修改。

它们不能证明未来 Official Host 接线继续满足这些合同。G5 contract tests 和集成回归仍为 `NOT_RUN`。

## 4. 官方组件回归

### 4.1 G1 build 与 copied artifact smoke

固定源码制裁结果：

```text
frozen install with retry: PASS
CLI build exit: 0
built packages: 18
copied artifact smoke checks: 9 / 9 PASS
AppServer version: 0.17.1
```

冒烟断言覆盖：

- session create；
- model selection；
- first model request；
- 官方 `Read` tool；
- tool result 回到第二次模型请求；
- event replay；
- runtime close；
- session resume；
- cancel ACK；
- cancelled terminal。

该回归没有真实模型请求；Provider 为本地 Mock。Node `v24.16.0` 与官方 pin `24.14.0` 不同，optional native closure 仍为 `PARTIAL`。

### 4.2 G2 ProcessManager r7/r9

结果：

```text
structured assertions: 12 / 12 PASS
real model requests: 0
loopback mock HTTP requests: 3
provider model requests: 2
usage: 220 tokens
event replay: seq 1..21 contiguous
generation 1 AppServer/helper: 23176 / 23820
generation 2 AppServer/helper: 6428 / 2548
managed processes after final close: []
target processes after final close: []
```

当前最新的 r9 在自包含 host module artifact 上重现 12/12 PASS：

```text
generation 1 AppServer/helper: 13464 / 9580
generation 2 AppServer/helper: 11224 / 24124
managed processes after final close: []
target processes after final close: []
```

r7/r9 证明官方 ProcessManager 在单 workspace、单活动执行 AppServer、loopback Mock 的正常路径中能够启动、关闭、重启、恢复、取消并清理观察到的目标 PID。每次运行的 3 条 loopback HTTP 记录包含两次主 Turn Provider 请求和一次标题等辅助请求。

它不覆盖：

- Worker 崩溃和父进程异常矩阵；
- 跨崩溃持久 Job identity；
- Browser/MCP 外部资源；
- 生产 Bridge Release verification。

### 4.3 G3 runtime-host acceptance

固定 helper acceptance 退出 0，七个场景通过：

```text
graceful
tree
root-exit
control-loss
helper-loss
cancel
ownership-failure-rejects-cli
```

观测耗时为：

| 场景 | elapsed |
|---|---:|
| graceful | 1500 ms |
| tree | 1921 ms |
| root-exit | 31 ms |
| control-loss | 78 ms |
| helper-loss | 16 ms |
| cancel | 156 ms |

这些是 acceptance 场景耗时，不是新旧执行链 benchmark。`disposeAndWait()`、Job empty 和 helper exit 仍不能单独映射成当前 Bridge `cleanup_verified`。

## 5. 官方账户与凭据回归

### 5.1 官方 credential/auth suites

执行：

```text
tests/credential-recovery-fence.test.ts
tests/auth.test.ts
tests/credential-security.test.ts
```

结果：

```text
3 test files passed
55 tests passed
```

运行时为 Node `v24.22.1`、pnpm `11.25.0`，不是官方 pin 的 Node `24.14.0` / pnpm `10.33.2`。该结果应标记为 `PASS_UNPINNED_TOOLCHAIN`。

### 5.2 MCP OAuth cross-process

两次整文件运行均为：

```text
3 passed / 1 failed
```

通过的三个场景：

- 两个真实进程刷新一个 near-expiry token，恰好一个网络请求；
- 两个进程选出一个 authorization leader，一个 DCR 和一个 authorization URL；
- leader 被终止后可回收 authorization lease。

稳定失败：

```text
completes authorization that outlasts the caller budget (incident timeline replay)
budgeted.authorization?.authorizationUrl is undefined
```

因此：

```text
MCP_OAUTH_REFRESH_SINGLE_FLIGHT: PASS_SYNTHETIC
MCP_OAUTH_CROSS_PROCESS_SUITE: PARTIAL_3_OF_4
```

MCP 专用 lease 通过，不能扩展为普通账户 profile 已具备 cross-process single-flight。

### 5.3 G4 同 profile 双 Worker

harness 启动两个真实 Node 子进程，每个装配固定上游的：

- `CredentialService`；
- `OAuthService`；
- `OAuthCredentialRepo`。

两个进程读取同一 case-local 合成 profile，OAuth adapter 仅访问同一 run 内的 loopback strict-rotation server。

最新稳定结果：

```text
run: 2026-11-11T12-35-56.153Z-24920
source: b95ebaff / d7ebeb99 / 3.18.0
Node: v24.16.0
realModelRequests: 0
realOAuthRequests: 0
billingRequests: 0
startPlanRequests: 0
desktopReadOrWrite: false
```

逐项状态：

```text
OFFICIAL_ACCOUNT_SERVICE_ASSEMBLY: PARTIAL
SYNTHETIC_CREDENTIAL_FLOW: PARTIAL
SAME_ACCOUNT_MULTIWORKER: FAIL
TOKEN_REFRESH_RACE: FAIL
TOKEN_ROTATION: PASS
REVISION_PROPAGATION: FRESH_PROCESS_READ_PASS / LIVE_CACHE_NOT_PROVEN
ACCOUNT_FAILURE_ISOLATION: PASS
CRASH_LOCK_RELEASE: PASS
REAL_ACCOUNT_E2E: NOT_RUN
```

失败事实：

```text
request 1: worker-b -> rotated
request 2: worker-a -> rejected (409 rotation_reuse_rejected)
networkRequestCount: 2
```

文件锁保护了凭据文件 mutation，CAS 保证最终只有一个 writer 生效，但这些机制没有把远端 refresh 网络调用包成一个跨进程事务。一个 Worker 未取得 rotation 结果并失败关闭，而不是读取 winner 后自动继续。

早先一次 run `2026-11-11T12-32-51.630Z-20096` 还在 rotation/revision 聚合断言上失败；修正后的稳定 run 对以下项目为 PASS：

- token rotation；
- 两个 fresh process 读取同一新 revision/token；
- CAS 唯一的 winner；
- refresh failure isolation；
- crash lock reclaim。

两次运行都重复了 core double-refresh failure，因此不能用后续局部 PASS 抵消并发合同失败。

证据：

- `.run/lifecycle-account-evidence/ACCOUNT_MULTIWORKER_EVIDENCE.md`
- `.run/lifecycle-account-evidence/g4-harness/runs/2026-11-11T12-35-56.153Z-24920/result.json`
- `.run/lifecycle-account-evidence/g4-harness/runs/2026-11-11T12-35-56.153Z-24920/refresh/network-ledger.json`

## 6. Documentation-only T0

本轮较早的一次 `npm run test:affected` 曾因 `node_modules/playwright-core/browsers.json` 缺失而在 plugin build 阶段 `FAIL_ENVIRONMENT`。失败构建产生了六个 tracked bundle 变化，之后通过精确 allowlist 恢复。

最终文档集生成后再次执行并记录了 `.run/official-host-integration-v1-t0-final.log`：

- 模式：`NO_TESTS_APPLICABLE`；
- 影响域：`documentation-only`；
- stress：`STRESS_TESTS_NOT_APPLICABLE`；
- `npm run typecheck` 完成；
- `build:core` 完成；
- `build:plugin`、`validate:plugin` 和 `git diff --check` 均在日志中完成。

该日志 SHA256 为 `935EF86574A0B3B3C16E9AAB31CF18A57231186B2C1ADF059A2DFF975BA321D7`。`NO_TESTS_APPLICABLE` 仍不是业务测试 PASS。build 重写了八个 tracked bundle 文件，随后按精确 allowlist 从 HEAD 恢复，最终状态未保留生成差异。

## 7. 合同回归判断

| 合同 | 当前判断 | 说明 |
|---|---|---|
| Bridge Worker 所有权 | `PRESERVED_IN_EXISTING_PATH` | 无生产源码变更；历史 cleanup 测试通过 |
| Task/Attempt 与 Claim | `NOT_EXERCISED_BY_NEW_PATH` | G5 未实现 |
| SQLite Authority | `NOT_CHANGED` | 文档-only；旧路径 lifecycle 测试通过 |
| Hold/Recovery | `NOT_CHANGED` | 未通过新路径集成验证 |
| Cleanup/Release | `BLOCKED_IN_NEW_PATH` | 官方持久 proof 映射缺失 |
| ADR-030 entitlement | `PRESERVED_HISTORICALLY` | 33 项定向测试通过，未接真实账户 |
| Worker concurrency | `PRESERVED_BY_CURRENT_CODE` | 新路径未实施；不能宣称同 profile 官方账户并发安全 |
| Compatible adapter | `NOT_RUN` | `OfficialHostAdapter` 不存在 |
| Model/tool/terminal mapping | `NOT_RUN` | G2 只验证窄 probe |

## 8. 未解释失败与停止条件

当前没有把已知失败标成 flaky 或忽略：

- G4 general account double-refresh 是稳定可复现的合同失败；
- MCP OAuth 整文件第四项在两次运行以同一断言失败；
- G1 clean-install 首次 build 的 `zcode.cjs` 与 source map 不一致；
- optional native dependency closure 未完成；
- G5 raw frame 和 Cleanup Proof 仍为阻断项；
- 完整发布回归不可执行，因为候选 Adapter 和 Worker 接线尚不存在。

以下任一项解决前不得把本轮状态升级为 PR-ready：

1. G5 生产 Adapter 和 Worker 接线完成；
2. raw frame guard 等效实现并有超限测试；
3. Cleanup Proof mapping 获批并通过失败关闭测试；
4. 同 profile refresh coordination 合同明确且有合成证据；
5. 项目规定的受影响回归和完整 release gate 对真实候选运行；
6. Astra 独立审查查看实际 diff、测试和源码。

## 9. OCEAN 与缺失证据

现有研究目录和 `.run` 文件清单中没有找到可引用的 OCEAN 结果：

```text
OCEAN_RESULT: NOT_FOUND / NOT_RUN
```

`IMPLEMENTATION_SUMMARY.md` 已同步为后续 `G4_SAME_PROFILE_MULTI_WORKER: FAIL`。本文以双 Worker 原始证据为准，也不把合成失败扩展为真实账户结论。
