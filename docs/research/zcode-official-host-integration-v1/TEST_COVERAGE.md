> Status: RESEARCH
> Date: 2026-11-11
> Bridge baseline: `9710303397fe2d544c75698f783a8174404b2d51` / tree `a9ec733ac02a22b6d27b7cb150abeaae3020569c`
> Observed upstream: ZCode `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d` / `3.18.0`
> Evidence scope: 本文汇总本轮已经留下的构建、隔离运行、合成账户和 Bridge 定向回归证据。本轮最后新增本文档及另外三份交付文档时没有重新执行模型、账户、Billing、Start Plan 或完整回归。

# G6：测试覆盖与证据矩阵

## 1. 结论

当前已经覆盖固定官方源码构建、官方 AppServer Mock、Windows runtime-host helper、ProcessManager 正常启动/恢复/取消/关闭、Bridge 定向 Lifecycle/Auth 回归，以及同 profile 双 Worker 合成账户竞争。

这些证据足以证明若干隔离组件可运行，但不足以声明 Worker 内官方 Host 集成完成。`OfficialHostAdapter`、Worker 接线、兼容性 parity、持久 Cleanup Proof 和生产 Release 接线都尚未实施。

```text
G1_SOURCE_BASELINE: RUN / PASS
G1_CLI_BUILD: RUN / PASS_WITH_TOOLCHAIN_AND_NATIVE_CAVEATS
G1_MINIMAL_HOST_ASSEMBLY: NOT_RUN
G1_REPRODUCIBILITY: RUN / FAIL_FOR_CLEAN_INSTALL_BYTE_IDENTITY
G2_PROCESS_MANAGER: RUN / PASS_UNDER_LOOPBACK_MOCK
G3_HELPER_ACCEPTANCE: RUN / PASS
G3_PERSISTENT_CLEANUP_PROOF: BLOCKED / PARTIAL
G4_GENERAL_CREDENTIAL_SUITES: RUN / PASS_UNPINNED_TOOLCHAIN
G4_SAME_ACCOUNT_MULTIWORKER: RUN / FAIL_SYNTHETIC
G4_REAL_ACCOUNT: NOT_RUN
G5_ADAPTER_IMPLEMENTATION: NOT_RUN
G5_COMPATIBILITY_PARITY: NOT_RUN
G5_FRAME_GUARD: BLOCKED
G5_CLEANUP_RELEASE: BLOCKED_FAIL_CLOSED
FULL_REGRESSION_THIS_ROUND: NOT_RUN
PRODUCTION_CODE_CHANGED: NO
```

`PASS_UNDER_LOOPBACK_MOCK` 只表示隔离 Mock 路径中的行为和进程关闭符合断言。它不证明真实 Provider、真实账户、真实模型、Desktop 独立性或生产 Cleanup 合同。

## 2. 基线

| 项 | 固定值 |
|---|---|
| Bridge worktree | `D:\codex-zcode-bridge\.run\official-host-integration-v1-20261111` |
| Bridge branch | `codex/official-host-integration-v1-20261111` |
| Bridge commit | `9710303397fe2d544c75698f783a8174404b2d51` |
| Bridge tree | `a9ec733ac02a22b6d27b7cb150abeaae3020569c` |
| Official source | `D:\codex-zcode-bridge\.run\companion-runtime-validation-20261111\source` |
| Official commit | `b95ebaffeab641907b38652f45c1502bd762972d` |
| Official tree | `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d` |
| Root package version | `3.18.0` |
| AppServer CLI version | `0.17.1` |

构建实际使用 Node `v24.16.0` 和 pnpm `10.33.2`。官方 `mise.toml` 固定 Node `24.14.0`、pnpm `10.33.2`，因此 pnpm 精确匹配，Node 仅满足运行时范围，未按官方 pin 做等价性验证。

## 3. 证据等级

| 等级 | 含义 |
|---|---|
| `RUN / PASS` | 有实际退出结果和结构化断言，且本轮核对了原始证据 |
| `RUN / FAIL` | 实际执行完成，但至少一个目标合同不满足 |
| `PARTIAL` | 运行范围或依赖闭包不完整，不能扩展为整体 PASS |
| `BLOCKED` | 缺少实现或不满足合同，继续扩展测试没有意义 |
| `NOT_RUN` | 没有可接受的执行证据 |
| `PASS_SYNTHETIC` | 合成数据、Mock 或 loopback 范围内通过 |
| `PASS_FOR_ISOLATED_MOCK` | 隔离 Mock 中的组件级通过，不覆盖生产路径 |

历史证据不因文件存在而自动成为当前候选的新鲜回归。本文对每次证据注明其范围和限制。

## 4. 覆盖矩阵

| 门禁 | 测试或验证 | 状态 | 证据与边界 |
|---|---|---|---|
| G1 source baseline | commit、tree、版本、tracked clean | `RUN / PASS` | `.run/official-host-g1/evidence/g1-summary.json` |
| G1 dependency install | frozen install、固定 pnpm、单并发重试 | `RUN / PASS_WITH_RETRY` | 首次失败为 `ERR_PNPM_ENOENT`，固定重试退出 0 |
| G1 native closure | optional native module | `PARTIAL` | `cpu-features` 和 `ssh2` optional crypto 未构建 |
| G1 CLI build | `pnpm --filter "@zcode/cli..." build` | `RUN / PASS` | 退出 0，18 packages |
| G1 copied artifact smoke | 复制 `dist` 后直接启动 AppServer | `RUN / PASS` | 9 项结构化检查通过 |
| G1 minimal Host assembly gate | G1 文档定义的完整最小 Host | `NOT_RUN` | 后来 G2 的窄 Mock 不反写成 G1 已完成 |
| G1 same-tree rebuild | 同 dependency tree 原地重建 | `RUN / PASS` | 生成的四个文件逐字节一致 |
| G1 clean-install byte identity | 独立 checkout 首次构建同 hash | `RUN / FAIL` | `zcode.cjs` 与 source map 均与首个制品不同 |
| G2 ProcessManager | 启动、session、model、turn、Read、第二请求、replay、usage、close、resume、cancel | `RUN / PASS_FOR_ISOLATED_MOCK` | r7/r9 各断言 `12/12`；r9 为当前最新 |
| G2 mock network | Provider 与模型仅到达 loopback | `RUN / PASS` | `realModelRequests=0` |
| G2 process ownership | 两代 AppServer/helper 的 spawn、exit、最终目标集合 | `RUN / PASS_FOR_OBSERVED_RUN` | lifecycle spawn/exit 各 2，最终目标 PID 为空 |
| G3 helper acceptance | graceful、tree、root-exit、control-loss、helper-loss、cancel、ownership rejection | `RUN / PASS` | 验收程序退出 0 |
| G3 persistent Job proof | 跨崩溃持久、可恢复的 Job identity/receipt | `BLOCKED / PARTIAL` | 官方公开 API 未导出 Bridge verifier 所需 receipt |
| G3 Cleanup mapping | 官方正常关闭到现有 Bridge proof | `BLOCKED` | 不能把 `disposeAndWait()` 或 Job empty 日志当作 `cleanup_verified` |
| G3 Bridge Release | 候选路径 Release | `BLOCKED_FAIL_CLOSED` | 新 proof 合同仍未 Accepted |
| G4 Bridge auth | Start Plan/private auth 定向测试 | `RUN / PASS_HISTORICAL` | 33 tests passed |
| G4 Bridge lifecycle | SQLite、Adapter、Windows cleanup、review regressions | `RUN / PASS_HISTORICAL` | 139 tests passed |
| G4 official credential suites | Credential recovery、auth、security | `RUN / PASS_UNPINNED_TOOLCHAIN` | 3 files / 55 tests passed |
| G4 MCP OAuth refresh | 两进程 refresh single-flight | `PASS_SYNTHETIC` | 两次均通过 |
| G4 MCP OAuth suite | 完整 cross-process 文件 | `PARTIAL_3_OF_4` | 两次均有一项 `authorizationUrl` 断言失败 |
| G4 same-profile multi-worker | 两真实 Node 子进程、同合成 profile | `RUN / FAIL_SYNTHETIC` | 两次远端 refresh 均到达 loopback server |
| G4 token rotation | 一次性 refresh token 严格 rotation | `RUN / PASS` | 稳定运行中第一次成功、第二次 `409` |
| G4 revision propagation | 两个 fresh process 读新 revision | `RUN / PASS` | 新进程读取一致；live cache 热更新未证明 |
| G4 failure isolation | 一个 Worker 失败、另一个继续 | `RUN / PASS` | profile revision 未被失败者改写 |
| G4 crash lock release | 锁持有进程终止后恢复 | `RUN / PASS` | 后续进程 `17 ms` 取得锁 |
| G4 real account | OAuth、Billing、Start Plan、模型 | `NOT_RUN` | 按授权边界禁止 |
| G4 official account service | 完整 Host 内 AccountService | `PARTIAL / NOT_ASSEMBLED` | 只装配窄 `CredentialService`、`OAuthService`、`OAuthCredentialRepo` |
| G5 Adapter implementation | `OfficialHostAdapter` 生产代码 | `NOT_RUN` | 当前只有设计文档和只读源码映射 |
| G5 coding-adapter parity | 五方法合同、错误、取消、terminal | `NOT_RUN` | 不能凭 G2 probe 推导 |
| G5 workspace identity | project identity、worktree cwd、Browser scope、instructions | `NOT_RUN` | 现有映射仍是 design hypothesis |
| G5 raw frame guard | 16 MiB UTF-8 raw stdout cap | `BLOCKED` | 官方 3.18.0 transport 只有 LF framing，无等价 raw-byte cap |
| G5 timeout/restart | 请求 timeout 后不得重发 acceptance unknown Prompt | `BLOCKED / DESIGN_REQUIRED` | 官方 client timeout 可能 evict/restart runtime |
| G5 Worker integration | Claim、Hold、Recovery、Cleanup、Release | `NOT_RUN` | 没有生产接线 |
| G6 full regression | 项目发布前完整门禁 | `NOT_RUN` | G5 尚未实现 |

## 5. 关键运行证据

### 5.1 官方制品

首个执行制品：

```text
zcode.cjs
bytes: 30,999,438
SHA256: DF4637F2E31AEDE37DB15B3E4E8D8BE35F59BF756E4EECFFC0A6A6B1EEDB4F2E
```

独立 clean-install checkout 的首次构建：

```text
zcode.cjs
bytes: 30,998,734
SHA256: 5EEEB739E646952D3DD2F1109006C7C0BA56CF2E406B5B8012686C5D1EA3140B
```

两次生成的 `zcode.cjs` 和 source map 不一致。不能提供“任意 clean install 可复现同一字节制品”的结论。后续运行应使用 hash-addressed known-good artifact，而不是覆盖同名文件后假定兼容。

### 5.2 G2 r7/r9

r7 使用固定 `zcode.cjs`、固定 helper、隔离 HOME/TMP/SQLite 和 localhost Mock；r9 在自包含 host module artifact 上重现同一结果：

- 实际模型请求数：`0`
- loopback Mock HTTP 请求数：`3`（两次主 Turn Provider 请求，另一次标题等辅助请求）
- Provider 完成请求数：`2`
- usage：`220` tokens
- 事件 replay：seq `1..21` 连续
- r9 第一代 PID：AppServer `13464`、helper `9580`
- r9 第二代 PID：AppServer `11224`、helper `24124`
- 最终 managed processes：空
- 最终目标进程集合：空

证据：

- `.run/official-host-poc/runs/process-manager-r7/evidence/process-manager-result.json`
- `.run/official-host-poc/runs/process-manager-r7/evidence/isolation.json`
- `.run/official-host-poc/runs/process-manager-r9/evidence/process-manager-result.json`
- `.run/official-host-poc/runs/process-manager-r9/evidence/isolation.json`

### 5.3 G3 helper

固定 helper 和 acceptance harness 的 SHA256 分别为：

```text
zcode-runtime-host.exe
04E1794F8325B3C46D4159420CDD04041E9AFC58516E03FC3DC8E78576EEFC24

zcode-runtime-host-acceptance.exe
33E70B20A430393081920225E6A2848A2F28CB68881B03E97EBF88ADEB8E70A3
```

acceptance 退出 0，覆盖七个场景。证据：

- `.run/official-host-poc/runtime-host-artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/BUILD_PROVENANCE.json`
- `.run/official-host-poc/runs/runtime-host-acceptance-r1/acceptance-result.json`
- `.run/official-host-poc/runs/runtime-host-acceptance-r1/acceptance.log`

### 5.4 G4 合成双 Worker

最新稳定运行：

```text
runId: 2026-11-11T12-35-56.153Z-24920
Node: v24.16.0
network: 127.0.0.1 loopback only
realModelRequests: 0
realOAuthRequests: 0
billingRequests: 0
startPlanRequests: 0
```

两个真实 Node 子进程在 barrier 后使用同一 synthetic refresh token：

```text
request 1: worker-b -> rotated
request 2: worker-a -> rejected (409 rotation_reuse_rejected)
```

因而当前每 Worker 独立装配官方通用 `OAuthService` 的路径不是 cross-process single-flight。文件锁能保护落盘 mutation，CAS 能让一个 writer 胜出，但都不能阻止两个网络 refresh 先发出。

证据：

- `.run/lifecycle-account-evidence/ACCOUNT_MULTIWORKER_EVIDENCE.md`
- `.run/lifecycle-account-evidence/g4-harness/runs/2026-11-11T12-35-56.153Z-24920/result.json`
- `.run/lifecycle-account-evidence/g4-harness/runs/2026-11-11T12-35-56.153Z-24920/refresh/network-ledger.json`

## 6. 尚未覆盖的必要测试

后续 G5/G6 至少需要新增或执行以下测试；当前均不能标为 PASS：

- `OfficialHostAdapter` 与现有 `CodingAgentAdapter` 五方法的 contract tests；
- Worker Claim 到 Result 的完整 Attempt、continuation、Hold、Recovery、Cleanup、Release 集成；
- 同一 Worker 内单 ProcessManager、单执行 AppServer 的所有权断言；
- project identity、canonical workspace、worktree cwd、AGENTS instructions、Browser scope 的 G2-style fixtures；
- 16 MiB raw stdout frame 上限及超限关闭；
- 请求 timeout、cancel、transport close 后 acceptance unknown 的 fail-closed 行为；
- 官方关闭事实到已接受 Bridge Cleanup Proof 的跨崩溃映射；
- Worker crash、AppServer crash、helper crash、control loss 和 descendant/browser resource 矩阵；
- 同 profile 多 Worker 的 cross-process refresh coordination；
- model routing、reasoning/effort、permissions、MCP、Browser、usage 和 terminal/error 映射；
- Legacy adapter 与 Official Host 的有效性能对比；
- 项目规定的完整 regression、stress 和 release gates。

## 7. 其他记录

搜索现有 `.run` 和本轮研究目录后，没有发现可引用的 `OCEAN_RESULT` 文件或结构化结果：

```text
OCEAN_RESULT: NOT_FOUND / NOT_RUN
```

`IMPLEMENTATION_SUMMARY.md` 已同步为后续 `G4_SAME_PROFILE_MULTI_WORKER: FAIL`；原始运行仍以 `ACCOUNT_MULTIWORKER_EVIDENCE.md` 和 `result.json` 为准。

## 8. 覆盖结论

当前覆盖可以支持“固定源码可构建、官方窄组件和 Mock Agent 生命周期可运行”的组件结论。它不能支持以下交付声明：

- 官方 Host 已接入现有 Worker；
- 同账户多 Worker 已安全；
- 官方进程关闭已满足 Bridge Release；
- raw transport 与现有 Bridge 防御边界一致；
- 新旧执行链性能、真实账户或完整回归已经通过；
- PR-ready。
