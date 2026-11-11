# ZCode 官方 Host 集成实施摘要

> Status: RESEARCH — G1/G2 ISOLATED EVIDENCE CONSOLIDATED / PRODUCTION INTEGRATION NOT IMPLEMENTED
> Date: 2026-11-11
> Bridge baseline: `9710303397fe2d544c75698f783a8174404b2d51`
> Observed ZCode: `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d` / `3.18.0`

## 当前状态

固定官方 3.18.0 源码已生成 CLI/AppServer 执行制品、固定 Windows runtime-host helper 和自包含最小 host module artifact。官方 `ZCodeAgentProcessManager` 已在 r7 的 source dependency-tree 路径和 r8/r9 的 package-free module-artifact 路径中实际启动和关闭。

r7、r8 和 r9 各自 12/12 结构化断言通过，覆盖官方 `Read` 工具后的第二次模型请求、220 tokens、事件重放、正常关闭、同一 session 重启 resume、cancel 和最终精确目标 PID 清理。r8/r9 使用 tree-shaken、自包含 `official-host-runtime.mjs` 与 compiled probe，通过普通 Node 执行，不经过 tsx 或 source `node_modules`。r9 是当前保留的最新运行。这些 POC 没有真实模型、账户、Start Plan 或 Billing 请求。

```text
G1_SOURCE_BASELINE: PASS
G1_SOURCE_BUILD: PASS
G1_DIRECT_APP_SERVER_SMOKE: PASS
G1_MINIMAL_HOST_MODULE_ARTIFACT: PASS
G1_MINIMAL_HOST_MODULE_ARTIFACT_SCOPE: WINDOWS_X64_NODE_24.16.0_ZCODE_3.18.0_R9
G1_HOST_MODULE_REPEAT_BUNDLE_BYTE_IDENTITY: PASS
G1_ARTIFACT_REPRODUCIBILITY: PARTIAL
G1_SAME_DEPENDENCY_TREE_REPEAT_BUILD: PASS
G1_CROSS_INSTALL_FIRST_BUILD_BYTE_IDENTITY: NOT_STABLE
G2_ISOLATED_MINIMAL_HOST: PASS_FOR_ISOLATED_MOCK
G2_PROCESS_MANAGER_R7_R8_R9_ASSERTIONS: EACH_12_OF_12_PASS
G2_WINDOWS_HELPER_ARTIFACT: PASS
G2_WINDOWS_HELPER_ACCEPTANCE: PASS
G2_OVERALL: PARTIAL
G3_BRIDGE_CLEANUP_MAPPING: PARTIAL
G3_CLEANUP_PROOF_CONTRACT: PROPOSED
G4_ACCOUNT_SERVICE_ASSEMBLY: PARTIAL
G4_SYNTHETIC_CREDENTIAL_FLOW: PARTIAL
G4_SAME_PROFILE_MULTI_WORKER: FAIL
G4_TOKEN_REFRESH_RACE: FAIL
G4_TOKEN_ROTATION: PASS
G4_REVISION_PROPAGATION: FRESH_PROCESS_READ_PASS / LIVE_CACHE_NOT_PROVEN
G4_ACCOUNT_FAILURE_ISOLATION: PASS
G4_CRASH_LOCK_RELEASE: PASS
G4_CREDENTIAL_BROKER_NECESSITY: PROPOSED_BY_SYNTHETIC_EVIDENCE_ONLY
G4_REAL_ACCOUNT_E2E: NOT_RUN
G5_UPSTREAM_BINDING_DESIGN: DEFINED
WORKER_HOST_INTEGRATION: NOT_IMPLEMENTED
DESKTOP_MAIN_INDEPENDENCE: NOT_RUN
PRODUCTION_CODE_CHANGED: NO
PRODUCTION_SWITCH_AUTHORIZED: NO
```

## 已核实

### G1

- source commit/tree 固定且构建前 tracked worktree clean；
- 固定 pnpm 首次安装失败后，以 `--child-concurrency=1` 重试成功；
- `pnpm --filter "@zcode/cli..." build` 退出码 0，构建 18 个 packages；
- AppServer `zcode.cjs --version` 为 `0.17.1`，root version 为 `3.18.0`；
- 直接 RPC 和官方 ProcessManager 路径都使用同一 `zcode.cjs`：
  `DF4637F2E31AEDE37DB15B3E4E8D8BE35F59BF756E4EECFFC0A6A6B1EEDB4F2E`。
- tree-shaken 自包含 `official-host-runtime.mjs` 为 1,611,888 bytes，SHA256 `0DE82EB939F48F8D97E697BEFB7F937BA13723E965C27960DA2A4C5BCB8092DC`；
- host module 除 Node builtins 外没有外部 import，同输入重复 bundle 字节一致；
- 独立 `g1r2` checkout 的 offline frozen install 在本地补齐缺失 tarball 后 PASS；
- `g1r2` 首次 clean-install build 生成 `zcode.cjs` SHA256 `5EEEB739E646952D3DD2F1109006C7C0BA56CF2E406B5B8012686C5D1EA3140B`、map SHA256 `91EB5C8F90E46E1B452DCA32120C849B649633EF3672E538FC33CA51347DFF9A`；
- 同 dependency tree 原地第二次 build PASS 后，四个产物与最初 artifact 逐字节一致；
- 因此重复执行与同依赖树稳定性为 PASS，但不同 install 后的 first-build 逐字节稳定性为 `NOT_STABLE`，整体仅 `PARTIAL`。

### G2

- 两代 runtime identity 分别为 `<workspace>:1:23176` 和 `<workspace>:2:6428`；
- generation 1 AppServer/helper PID 为 `23176/23820`，关闭后目标集合为空；
- generation 2 AppServer/helper PID 为 `6428/2548`，resume、cancel 和最终关闭后目标集合为空；
- r8/r9 各使用自包含 host module artifact 和 compiled probe 重跑，均 12/12 PASS；r9 当前保留的 compiled probe SHA256 为 `A00C35093E1A8421FD22C2B64A791E1F96AF561A0D95C51A2473B4C49B66EDE3`；
- r9 generation 1 AppServer/helper PID 为 `13464/9580`，generation 2 为 `11224/24124`，最终目标 PID 全退出；r8 的对应 PID 为 `20828/10372` 与 `26156/25340`；
- lifecycle reporter 记录 2 次 spawn 与 2 次 expected exit；
- `realModelRequests=0`；两次主 Turn Provider 请求的 usage 为 input 200、output 20、total 220，`modelRequestCount=2`；另有 1 次标题等辅助 loopback HTTP 请求，不能合并成“共 2 次 HTTP 请求”；
- helper acceptance 覆盖 graceful、tree、root-exit、control-loss、helper-loss、cancel 和 ownership failure rejection。

### G3

- 现有 Bridge 139 项 Lifecycle/Cleanup 回归通过；
- r7/r9 正常路径只证明本次进程观察中的关闭和恢复，不输出持久 Job identity/kernel-empty/helper-exit receipt；
- `dispose()` resolved、root PID 退出和 lifecycle callback 仍不能单独满足 Bridge `cleanup_verified`；
- Cleanup Proof 合同继续保持 `PROPOSED`，不得自动转 Accepted。

### G4

- 固定上游窄装配的双进程测试复现了 general account double-refresh；
- 第一个 refresh 完成 rotation，第二个使用同一一次性 refresh token 收到 `409 rotation_reuse_rejected`；
- 凭据文件 mutation 锁、session revision CAS、fresh-process 读取和 crash-lock release 各自有通过证据，但不能推出跨进程网络 refresh single-flight；
- 当前每 Worker 直接装配 `OAuthService` 不满足同 profile 多 Worker，必须由新的 Owner/ADR 决定最小协调机制。

## 隔离边界

```text
providerOrigin: 127.0.0.1
realModelRequests: 0
productionCredentialsRead: NOT_OBSERVED_NON_INSTRUMENTED
desktopProcessStarted: NOT_DETECTED_BY_EXPLICIT_LAUNCH
```

`NOT_OBSERVED_NON_INSTRUMENTED` 不等于证明生产凭据绝对未被读取；`NOT_DETECTED_BY_EXPLICIT_LAUNCH` 也不足以证明一般 Desktop Main 独立性。真实 Desktop/账户路径仍为 `NOT_RUN`。

## 设计边界

- 沿用现有 Worker、Manager、SQLite Authority 和 `CodingAgentAdapter`；
- 每个 Worker/Attempt 初始化一个执行 AppServer，不共享无关 Task；
- 官方 ProcessManager 是正常 AppServer/helper 生命周期的 owner；
- Upstream Binding 只映射协议、事件和结果，不成为 Task/Cleanup 权威；
- 不新增独立 Companion、业务 SQLite、平行 RuntimeAdapter、shared AppServer pool 或第二套 Recovery；
- 官方正常关闭与 Bridge 持久 Cleanup proof 分层记录。

设计入口见 [UPSTREAM_BINDING_DESIGN.md](UPSTREAM_BINDING_DESIGN.md)，运行证据详见 [MINIMAL_HOST_ASSEMBLY.md](MINIMAL_HOST_ASSEMBLY.md)，清理边界详见 [CLEANUP_PROOF_MAPPING.md](CLEANUP_PROOF_MAPPING.md)。

## 仍需完成

```text
G1_ARTIFACT_REPRODUCIBILITY: PARTIAL
NODE_FULL_NATIVE_MATRIX: NOT_RUN
RESOURCE_CLOSURE: PARTIAL
REDISTRIBUTION_REVIEW: PARTIAL
PROCESS_MANAGER_CRASH_FAULT_MATRIX: NOT_RUN
DESKTOP_MAIN_INDEPENDENCE: NOT_RUN
PRODUCTION_CREDENTIAL_PATH: NOT_RUN
REAL_ACCOUNT_E2E: NOT_RUN
SAME_PROFILE_MULTI_WORKER: FAIL
TOKEN_REFRESH_RACE: FAIL
CREDENTIAL_BROKER_NECESSITY: PROPOSED_BY_SYNTHETIC_EVIDENCE_ONLY
PERSISTENT_JOB_PROOF_EXPORT: MISSING
BRIDGE_CLEANUP_MAPPING: PARTIAL / PROPOSED
FRAME_GUARD_PARITY: BLOCKED_PENDING_TRANSPORT_DECISION
UPSTREAM_BINDING_IMPLEMENTATION: NOT_IMPLEMENTED
WORKER_HOST_INTEGRATION: NOT_IMPLEMENTED
PERFORMANCE_COMPARISON: NOT_RUN
PUBLIC_DISTRIBUTION_APPROVAL: NOT_GRANTED
PRODUCTION_SWITCH: BLOCKED
```

## 验证边界

此前在同一 worktree 已运行 `npm run test:affected`：文档影响选择为 `NO_TESTS_APPLICABLE`，typecheck、build、plugin validation 和 `git diff --check` 通过，`STRESS_TESTS_NOT_APPLICABLE`。Lifecycle/Cleanup 回归另为 139/139，Start Plan/private auth 回归为 33/33；这些是既有生产路径的历史定向证据，不是新 Host 路径 PASS。

本次文档更新没有启动新的源码 build、runtime POC 或真实账户请求。parent 的 g1r2 结果已回流：同 dependency tree 第二次 build 与最初 artifact 逐字节一致，但 clean-install 的 first-build 不稳定，故 overall 保持 `PARTIAL`。最小 host module artifact 的 r8/r9 路径为限定环境下的 PASS；完整 native/resource closure 与正式发行许可仍未关闭。证据路径为 `.run/official-host-g1/logs/g1r2-install.log`、`.run/official-host-g1/logs/g1r2-build.log`、`.run/official-host-g1/logs/g1r2-build-repeat.log`、`.run/official-host-poc/runs/process-manager-r9/evidence/process-manager-result.json` 和 `.run/official-host-poc/runs/process-manager-r9/evidence/isolation.json`。
