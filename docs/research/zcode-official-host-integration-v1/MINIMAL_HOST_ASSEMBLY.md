# G2：最小官方 Host 装配

> Status: RESEARCH
> Date: 2026-11-11，Asia/Shanghai
> Bridge baseline: `9710303397fe2d544c75698f783a8174404b2d51`
> Observed upstream: ZCode `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`，`3.18.0`
> Scope: fixed-source artifacts, official `ZCodeAgentProcessManager`, official `ZCodeProtocolClient`, official Windows runtime-host helper, and a localhost Mock provider. No real model, account, Start Plan, Billing, or production credential path was exercised.

## 1. 结论

最小官方 Host 已在隔离的 Windows x64 环境中完成只访问 `127.0.0.1` 的 Mock POC。r7 从固定源码依赖树验证官方 ProcessManager 路径；r8/r9 进一步使用 tree-shaken、自包含 `official-host-runtime.mjs` 和预编译 probe，以普通 Node 完成同一组 12 项断言，不再通过 tsx 或 source `node_modules`。r9 是当前保留的最新运行。

```text
G2_OVERALL: PARTIAL
MINIMAL_HOST_ASSEMBLY: PASS_FOR_ISOLATED_MOCK
OFFICIAL_PROCESS_MANAGER_RUNTIME_E2E: PASS_FOR_ISOLATED_MOCK
MINIMAL_HOST_MODULE_ARTIFACT: PASS
MINIMAL_HOST_MODULE_ARTIFACT_SCOPE: WINDOWS_X64_NODE_24.16.0_ZCODE_3.18.0_R9
HOST_MODULE_REPEAT_BUNDLE_BYTE_IDENTITY: PASS
WINDOWS_RUNTIME_HOST_HELPER_ARTIFACT: PASS
WINDOWS_RUNTIME_HOST_HELPER_ACCEPTANCE: PASS
OFFICIAL_BUILD_SCRIPT_REPRODUCIBILITY: PARTIAL
DESKTOP_MAIN_INDEPENDENCE: NOT_RUN
REAL_ACCOUNT_E2E: NOT_RUN
G2_VERDICT_AS_PRODUCTION: BLOCKED
```

`G2_OVERALL: PARTIAL` 的原因不是上述 Mock 场景失败，而是其证据边界尚未覆盖真实凭据、真实模型、Start Plan/Billing、一般 Desktop Main 独立性、ProcessManager 崩溃故障矩阵或生产 Worker 集成。

## 2. 固定输入

| 输入 | 固定值 |
|---|---|
| AppServer entry | `.run/official-host-g1/artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/cli/zcode.cjs` |
| AppServer hash | `DF4637F2E31AEDE37DB15B3E4E8D8BE35F59BF756E4EECFFC0A6A6B1EEDB4F2E` |
| G1 host module artifact | `.run/official-host-poc/runtime-host-module-artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/official-host-runtime.mjs` |
| G1 host module artifact hash | `0DE82EB939F48F8D97E697BEFB7F937BA13723E965C27960DA2A4C5BCB8092DC`，1,611,888 bytes |
| G1 host module provenance | `.run/official-host-poc/runtime-host-module-artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/BUILD_PROVENANCE.json` |
| Compiled probe | `.run/official-host-poc/g2-process-manager-probe.compiled.mjs` |
| Compiled probe hash (r9 current) | `A00C35093E1A8421FD22C2B64A791E1F96AF561A0D95C51A2473B4C49B66EDE3`，27,694 bytes |
| Helper used by r7 | `.run/official-host-poc/runtime-host-build-nuget-r5/zcode-runtime-host.exe` |
| Helper canonical artifact | `.run/official-host-poc/runtime-host-artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/zcode-runtime-host.exe` |
| Helper hash | `04E1794F8325B3C46D4159420CDD04041E9AFC58516E03FC3DC8E78576EEFC24` |
| Node | `v24.16.0`，module ABI `137` |
| Provider origin | `127.0.0.1` only |
| Real model requests | `0` |

`.run/official-host-poc/runs/process-manager-r7/evidence/isolation.json` 记录 r7 使用的 helper 与 canonical artifact 具有相同 SHA256；r7 结果中的 AppServer 也是上述 hash 对应的隔离 `zcode.cjs`。r8 isolation 记录了当时的 compiled probe `0B6728397DE8830C712308ED49E0DA8EC0F06466F169609330DC2B243C9D40B4`；该 probe 后来被 r9 覆盖为当前 `A00C35093E1A8421FD22C2B64A791E1F96AF561A0D95C51A2473B4C49B66EDE3`。r8/r9 的 helper 与 AppServer identity 仍分别与固定制品一致。

`official-host-runtime.mjs` 由固定 g1r2 source 经 esbuild tree-shake 生成，入口覆盖：

```text
ZCodeAgentProcessManager
ZCodeProtocolClient
ZCodeStdioTransport
```

其依赖闭包只引用 Node builtins，没有外部 package import。以同一输入重复 bundle，输出逐字节一致。该 PASS 仅覆盖 Windows x64 / Node 24.16.0 / ZCode 3.18.0 的 r8/r9 路径，不表示完整 Desktop native/resource closure 或正式发行许可已通过。

## 3. 十二项结构化断言

`r7`、r8 和 r9 的 `status` 均为 `PASS`，各自为 12/12。下表采用 r7 的断言结构，r8/r9 使用自包含 host module artifact 和 compiled probe 重新得到同一组结果；r9 是当前保留的最新运行。

| # | 断言 | 结果 | 实测事实 |
|---:|---|---|---|
| 1 | `OFFICIAL_PROCESS_MANAGER_STARTED` | PASS | generation 1 启动；`canStart.available=true`；AppServer 和 helper 均存在。 |
| 2 | `SESSION_CREATE` | PASS | session `sess_c2b8829e-5b59-4a7a-aa52-dee3c0ccd258`。 |
| 3 | `MODEL_SELECTION` | PASS | `companion-fixture / companion-local-fixture`。 |
| 4 | `TURN_TERMINAL` | PASS | `resultType=success`，response 为 `COMPANION_LOCAL_OK`。 |
| 5 | `OFFICIAL_READ_TOOL_EXECUTION_AND_SECOND_MODEL_REQUEST` | PASS | tool result verified；第一次请求已流式执行官方 `Read`；第二次请求包含该 Read result；断言时 request count 为 2。 |
| 6 | `EVENT_REPLAY` | PASS | 21 个事件，sequence `1..21` 连续；包含 turn start 和 Read result；成功终态恰好一个。 |
| 7 | `TOKEN_USAGE` | PASS | provider usage `totalTokens=220`；`modelRequestCount=2`；`inputTokens=200`、`outputTokens=20`。 |
| 8 | `MANAGER_NORMAL_CLOSE_AND_JOB_CLEANUP` | PASS | `managedProcessCount=0`；目标进程观察为空。 |
| 9 | `SESSION_RESUME_AFTER_MANAGER_RESTART` | PASS | generation 2；resume 同一 session ID；新 AppServer 和 helper 存在；AppServer PID 与 generation 1 不同。 |
| 10 | `CANCEL_ACK` | PASS | `session/stop` response present。 |
| 11 | `CANCEL_TERMINAL` | PASS | 观察到 `resultType=cancelled`。 |
| 12 | `FINAL_CLOSE_AND_JOB_CLEANUP` | PASS | managed process 数为 0；全部目标 PID 不可见；lifecycle 为 spawn 2、exit 2；断言要求 error/exception 数为 0。 |

`realModelRequests=0`。r7/r8/r9 的顶层 Mock ledger 各包含 3 条记录：两次主 Turn 的 Provider model request，以及一次标题等辅助请求。usage 的 `modelRequestCount=2` 只统计两次主 Turn；不能把全部 3 条 loopback HTTP 记录或 Mock token 数解释成真实上游请求或成本。

## 4. 两代 runtime identity 与 PID

### 4.1 r7：source dependency tree 路径

| 代次 | ProcessManager runtime identity | AppServer PID | Helper PID | 结果 |
|---|---|---:|---:|---|
| generation 1 | `<workspace>:1:23176` | `23176` | `23820` | alive，随后正常关闭 |
| generation 2 | `<workspace>:2:6428` | `6428` | `2548` | resume 后 alive，随后 cancel 和最终关闭 |

`<workspace>` 的实际值为：

```text
D:\codex-zcode-bridge\.run\official-host-integration-v1-20261111\.run\official-host-poc\runs\process-manager-r7\workspace
```

generation 1 的目标 PID 集合是 `[23176, 23820]`，关闭后为空；resume 后 generation 2 的目标 PID 集合是 `[6428, 2548]`。最终目标集合 `[23176, 23820, 6428, 2548]` 的进程观察为空。Runner 和其 esbuild 辅助进程仍在快照中，因此这里说的是精确目标 PID 清理，不是批量终止所有 Node 或所有后代。

### 4.2 r8/r9：自包含 host module artifact 路径

`r8` 先以 compiled probe 完成 12/12。当前保留的 r9 workspace 实际值为：

```text
D:\codex-zcode-bridge\.run\official-host-integration-v1-20261111\.run\official-host-poc\runs\process-manager-r9\workspace
```

| 代次 | ProcessManager runtime identity | AppServer PID | Helper PID | 结果 |
|---|---|---:|---:|---|
| generation 1 | `<r9-workspace>:1:13464` | `13464` | `9580` | alive，首次 close 后目标进程全退出 |
| generation 2 | `<r9-workspace>:2:11224` | `11224` | `24124` | 同 session resume、Read 二次 Mock、cancel 和最终 close 后目标进程全退出 |

最终目标集合 `[13464, 9580, 11224, 24124]` 的进程观察为空；`managedProcessesAfterClose` 与 `managedProcessesFinal` 都是空数组。r8 的对应 PID 为 `20828/10372` 和 `26156/25340`，也全部退出。两者 runner 都以普通 Node 执行 `.run/official-host-poc/g2-process-manager-probe.compiled.mjs`，没有 tsx preflight，也不加载 source `node_modules`。

## 5. Lifecycle reporter

r7 正常路径产生 4 个 lifecycle events：

| event | runtime generation | PID | 关键事实 |
|---|---:|---:|---|
| `spawn` | 1 | 23176 | `agent-4e7c7b90-18fb-4154-9c74-2c59b2e5e583` |
| `exit` | 1 | 23176 | `exitCode=0`，`terminationKind=expected`，`terminationReason=workspace-dispose` |
| `spawn` | 2 | 6428 | `agent-c76132c9-f981-4f25-8a90-e0eb00cc9887` |
| `exit` | 2 | 6428 | `exitCode=0`，`terminationKind=expected`，`terminationReason=workspace-dispose` |

这证明本场景中 lifecycle reporter 能关联 runtime generation、AppServer PID 和正常退出。它仍不是可跨 Bridge 崩溃持久重验的 Job proof；详见 [CLEANUP_PROOF_MAPPING.md](CLEANUP_PROOF_MAPPING.md)。

r8/r9 同样各产生 4 个 lifecycle events（2 次 spawn、2 次 exit），其目标 PID 清理由结果中的进程快照验证；该事实也不改变上述持久 proof 边界。

## 6. Helper 制品、构建来源和验收

固定 helper 的来源记录在：

```text
.run/official-host-poc/runtime-host-artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/BUILD_PROVENANCE.json
```

| 事实 | 值 |
|---|---|
| Upstream commit/tree | `b95ebaffeab641907b38652f45c1502bd762972d` / `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d` |
| Official build script | `scripts/build-windows-runtime-host.mjs`，SHA256 `0155D06E8D7DA4EBF725469A04BC9FC15138A734C13DAA33B3CF094FE69DCCC7` |
| Script used directly | `false` |
| Reason | 本地缺少脚本要求的 Visual Studio 17 2022 generator 与可发现的独立 Windows SDK；使用官方同版本 `CMakeLists.txt`、已安装 MSVC 和 `Microsoft.Windows.SDK.CPP` NuGet packages 配置构建。 |
| CMake | `3.31.6-msvc6` |
| MSVC binary version | `19.44.35229 for x64` |
| SDK packages | `Microsoft.Windows.SDK.CPP` 与 `Microsoft.Windows.SDK.CPP.x64`，版本均 `10.0.26100.4948` |
| Helper output | 167,424 bytes，x64 PE，SHA256 `04E1794F8325B3C46D4159420CDD04041E9AFC58516E03FC3DC8E78576EEFC24` |
| Acceptance harness | 190,976 bytes，SHA256 `33E70B20A430393081920225E6A2848A2F28CB68881B03E97EBF88ADEB8E70A3` |

Helper acceptance 命令为：

```text
zcode-runtime-host-acceptance.exe zcode-runtime-host.exe
```

结果为 exit code 0、`status=PASS`，覆盖：

- graceful；
- tree；
- root exit；
- control loss；
- helper loss；
- cancel；
- ownership failure 时拒绝 CLI 执行。

该验收证明这个固定 helper 二进制在其验收 harness 中通过，不等于官方构建脚本已可直接复现。`BUILD_PROVENANCE.limitations` 已明确记录 direct CMake 只是等价官方构建入口，未来 CI 仍须使用官方 prerequisites 重建。

## 7. 隔离边界

`isolation.json` 固定了项目内 HOME、TMP、session DB 和 runtime-host 路径，并记录：

```text
productionCredentialsRead: NOT_OBSERVED_NON_INSTRUMENTED
desktopProcessStarted: NOT_DETECTED_BY_EXPLICIT_LAUNCH
```

这两个值只能表述为：

- 没有观察到对 production credential 的读取，且该路径未插桩，因此不能宣布“绝对未读取”；
- 没有检测到由 POC 显式启动 Desktop 进程，也无足够 instrumentation 证明 Desktop Main 对运行时生命周期完全不参与。

所以 `DESKTOP_MAIN_INDEPENDENCE` 与 `PRODUCTION_CREDENTIAL_ISOLATION` 均不能标为 PASS。

## 8. 证据索引

- r7 结构化结果：`.run/official-host-poc/runs/process-manager-r7/evidence/process-manager-result.json`
- r7 隔离边界：`.run/official-host-poc/runs/process-manager-r7/evidence/isolation.json`
- r8 结构化结果：`.run/official-host-poc/runs/process-manager-r8/evidence/process-manager-result.json`
- r8 隔离边界：`.run/official-host-poc/runs/process-manager-r8/evidence/isolation.json`
- r9 结构化结果：`.run/official-host-poc/runs/process-manager-r9/evidence/process-manager-result.json`
- r9 隔离边界：`.run/official-host-poc/runs/process-manager-r9/evidence/isolation.json`
- 自包含 host module artifact：`.run/official-host-poc/runtime-host-module-artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/official-host-runtime.mjs`
- host module provenance：`.run/official-host-poc/runtime-host-module-artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/BUILD_PROVENANCE.json`
- host module build script：`.run/official-host-poc/build-host-runtime-bundle.mjs`
- compiled probe：`.run/official-host-poc/g2-process-manager-probe.compiled.mjs`
- helper provenance：`.run/official-host-poc/runtime-host-artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/BUILD_PROVENANCE.json`
- helper acceptance result：`.run/official-host-poc/runs/runtime-host-acceptance-r1/acceptance-result.json`
- helper acceptance log：`.run/official-host-poc/runs/runtime-host-acceptance-r1/acceptance.log`
- r7 AppServer log：`.run/official-host-poc/runs/process-manager-r7/logs/zcode-2026-11-11.jsonl`

## 9. 未完成

```text
DESKTOP_MAIN_INDEPENDENCE: NOT_RUN
PRODUCTION_CREDENTIAL_PATH: NOT_RUN
REAL_MODEL_E2E: NOT_RUN
REAL_ACCOUNT_E2E: NOT_RUN
START_PLAN_BILLING_E2E: NOT_RUN
PROCESS_MANAGER_CRASH_FAULT_MATRIX: NOT_RUN
PERSISTENT_JOB_PROOF_EXPORT: MISSING
BRIDGE_CLEANUP_MAPPING: PARTIAL
CLEANUP_PROOF_CONTRACT: PROPOSED
WORKER_HOST_PRODUCTION_INTEGRATION: NOT_IMPLEMENTED
FULL_NATIVE_RESOURCE_CLOSURE: PARTIAL
PUBLIC_DISTRIBUTION_APPROVAL: NOT_GRANTED
G2_AS_PRODUCTION: BLOCKED
```
