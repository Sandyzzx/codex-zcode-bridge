# Astra 独立最终审查：ZCode Official Host Integration v1

> Applicability (2026-11-12): HISTORICAL / SUPERSEDED. 本文审查的是一个更早的候选快照，正文为保留的历史证据。文中 `APPROVED`、`PRODUCTION_SWITCH_SAFE`、`PR_READY` 或“未实现”等结论只适用于该快照。当前 Preview.4 候选的独立结论见 [ASTRA_REVIEW_CURRENT.md](ASTRA_REVIEW_CURRENT.md)：完整回归、clean checkout 和当前 diff 审查已完成。

> Status: RESEARCH
> Date: 2026-11-11，Asia/Shanghai
> Reviewer: Astra Reviewer
> Initial review verdict: `CHANGES_REQUIRED`
> Final re-review: `APPROVED`
> Reviewed candidate SHA: `5da873d1f2632ac67343be692fab121f682f4cef`
> Reviewed candidate tree: `4ab1a4edacc93b62fa49a03b038b43a618005566`
> Initial reviewed candidate SHA: `fd1d7a8c425cbf7177e1f83394b3fd2c98266eb0`
> Initial reviewed candidate tree: `f1f1c6e0ba27093821a5555bb020f490925d4013`
> Base: `origin/preview` = `372e90622772b070357a278f1da3dea58fa42dee`，tree `9a0799b537b9b81af396f2fd45e39a00e7c8f295`
> Parent commit: `9710303397fe2d544c75698f783a8174404b2d51`
> Branch: `codex/official-host-integration-v1-20261111`
> Worktree: `D:\codex-zcode-bridge\.run\official-host-integration-v1-20261111`
> `FINAL_ACCEPTANCE_REPORT.md` required final status: `APPROVED`

## 1. 第一轮审查结论（保留）

```text
ASTRA_REVIEW: CHANGES_REQUIRED
PRODUCTION_SWITCH_SAFE: NO
PR_READY: NO
```

候选没有被批准为生产接入或 PR-ready。当前 diff 是文档-only 的架构冻结、隔离 POC
证据和阻断项记录，且总体安全边界写得基本准确；生产 Worker、`OfficialHostAdapter`、
raw-frame 等价防护、账户跨进程 refresh 协调和 Bridge 可恢复 Cleanup Proof 均未完成。

`CHANGES_REQUIRED` 来自文档证据一致性和状态标注问题，不是把总体不安全结论改写成
可生产。必须修正下列 P2 项后，文档候选才可重新审查：

1. `ACCOUNT_OWNERSHIP.md` 第 5 节称本轮“未执行” MCP OAuth E2E，但
   `ACCOUNT_CONCURRENCY.md` 第 4 节和 `REGRESSION_REPORT.md` 第 5.2 节记录了两次
   实际运行，均为 `3 passed / 1 failed`。同一候选中的事实互相冲突。
2. `FINAL_ACCEPTANCE_REPORT.md` 仍记录 `ASTRA_REVIEW: PENDING_FINAL_FILE`。
   本文件产生后，正确状态应为 `CHANGES_REQUIRED`；在该文件更新前，最终报告与证据
   集合不一致。
3. `PR_DESCRIPTION.md` 顶部没有 `Status: RESEARCH` 或其它允许的文档状态。这不符合
   `AGENTS.md` 对每份文档标注状态的要求。

## 2. 审查对象与变更边界

实际检查了：

- `git diff origin/preview...HEAD`、两个提交的内容、名称状态、统计与工作区状态；
- ADR-032、ADR-030、`docs/README.md`、`docs/PROJECT_STATE.md`、
  `docs/ARCHITECTURE.md` 和 ADR 索引；
- `docs/research/zcode-official-host-integration-v1/` 下全部 19 个 Markdown 文件；
- r7/r8/r9 原始 result 与 isolation evidence；
- G4 双 Worker 原始 `result.json` 与 network ledger；
- G1 install/build/repeat-build 日志、执行制品、helper/host-module provenance 和 hash；
- 当前 Bridge 的 raw-frame、`CodingAgentAdapter`、Worker Claim 和 Cleanup gate 源码；
- 固定上游 transport、ProcessManager 和 Windows runtime-host 源码。

差异结果：

```text
COMMITS: 2
CHANGED_FILES: 31
INSERTIONS: 5424
DELETIONS: 10
FILE_TYPES: Markdown only
FILE_MODES: regular non-symlink files
PRODUCTION_SOURCE_CHANGED: NO
PLUGIN_BUNDLE_CHANGED: NO
SQLITE_CHANGED: NO
RUNTIME_CONFIG_CHANGED: NO
```

审查开始时 worktree clean。审查期间曾因一条 shell 误解释的只读命令生成未跟踪的
根目录 `$null`；检查其内容确认是 `git status --branch;` 的错误输出重定向文件，且位于
本候选 worktree 内。该误产物已删除，不属于候选交付物，也不改变 Git HEAD。

## 3. 原始证据核对

### 3.1 r9 ProcessManager/AppServer

核对文件：

```text
.run/official-host-poc/runs/process-manager-r9/evidence/process-manager-result.json
bytes: 190830
sha256: A6A4F102EDFB10B96A99D5B9668CF12ECCAB8C92F469C1D101D189DE70FF361D
status: PASS
assertions: 12/12
```

原始结果确认：

- 两代 AppServer/helper PID 为 `13464/9580` 和 `11224/24124`；
- 两次关闭后的对应目标 PID 集合均为空，最终检查包含四个目标 PID；
- 两次关闭后 `managedProcesses` 为空；
- lifecycle ledger 有 2 次 spawn、2 次 exit，AppServer 均记录 `exitCode=0`；
- 3 条 loopback HTTP 记录是 2 条主 Turn Provider 请求加 1 条 1,216-byte 辅助请求；
- usage 为 input `200`、output `20`、total `220`，`modelRequestCount=2`；
- `realModelRequests=0`；
- r9 的 replay 为 22 个连续事件；文档表中若引用 21 个事件，明确采用 r7 作为表结构，
  没有把 r7 的计数写成 r9 原始值；
- `isolation.json` 记录的 probe SHA256 为
  `A00C35093E1A8421FD22C2B64A791E1F96AF561A0D95C51A2473B4C49B66EDE3`，
  AppServer 与 helper SHA256 分别匹配下节固定制品；
- `productionCredentialsRead` 为 `NOT_OBSERVED_NON_INSTRUMENTED`，
  `desktopProcessStarted` 为 `NOT_DETECTED_BY_EXPLICIT_LAUNCH`。这两个值没有表达成
  “绝对未读取”或“已证明 Desktop 独立”。

证据支持“隔离 Mock 正常路径观察到目标进程退出”。它不提供持久 Job identity、
kernel-empty/helper-exit receipt 或生产 Bridge Release 证明。

### 3.2 G4 双 Worker

核对文件：

```text
.run/lifecycle-account-evidence/g4-harness/runs/2026-11-11T12-35-56.153Z-24920/result.json
bytes: 29478
sha256: 0B4CA50E8BBAD3C753ADBE08D890602C3887B5601E789C5BDD9537AEED3AD19B

.../refresh/network-ledger.json
bytes: 368
sha256: 136C5DE897710580832344D57F5EC458B4BF461235AB66BBC9B2E2EC33022756
```

network ledger 确认：

```text
request 1: worker-b, pid 17376, rotated
request 2: worker-a, pid 23784, rejected
```

worker-a 返回
`synthetic_refresh_rejected:409:rotation_reuse_rejected`。result 同时将
`SAME_ACCOUNT_MULTIWORKER` 和 `TOKEN_REFRESH_RACE` 标为 `FAIL`；没有把 CAS winner、
fresh-process read、failure isolation 或 crash-lock reclaim 的局部 PASS 合并成跨进程
refresh PASS。真实 OAuth、Billing、Start Plan 和模型请求均为 `0 / NOT_RUN`。

### 3.3 G1 日志与制品

重新核对了 G1/G1R2 日志与制品。日志显示 Node 版本警告、
`cpu-features` optional build failure，以及最终安装/构建退出成功；这与文档的
`PASS_WITH_RETRY`、`PARTIAL` native closure 一致。关键 hash 为：

| 对象 | Bytes | SHA256 |
|---|---:|---|
| `zcode.cjs` | 30,999,438 | `DF4637F2E31AEDE37DB15B3E4E8D8BE35F59BF756E4EECFFC0A6A6B1EEDB4F2E` |
| `zcode.cjs.map` | 57,001,458 | `205404F621D86A0D2B5A30C0A8F1392C4679133917CFC907F9D17D3F627FE29B` |
| builtin provider JSON | 265,884 | `BC760A3B0C6D096EA07EE4E963471F135AE75AB207DB6ED4C372E1B183C856CD` |
| `THIRD-PARTY-NOTICES.md` | 3,465,209 | `C4CC6DC747EB6026E41D2CEFC6679392C33E1192629EA96DC0DC702BCFE7C51C` |
| runtime-host helper | 167,424 | `04E1794F8325B3C46D4159420CDD04041E9AFC58516E03FC3DC8E78576EEFC24` |
| helper acceptance binary | 190,976 | `33E70B20A430393081920225E6A2848A2F28CB68881B03E97EBF88ADEB8E70A3` |
| host module | 1,611,888 | `0DE82EB939F48F8D97E697BEFB7F937BA13723E965C27960DA2A4C5BCB8092DC` |
| compiled r9 probe | 27,694 | `A00C35093E1A8421FD22C2B64A791E1F96AF561A0D95C51A2473B4C49B66EDE3` |

G1R2 与固定官方 source 的 commit/tree 分别为
`b95ebaffeab641907b38652f45c1502bd762972d` 和
`d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`，tracked worktree 为 clean。固定 helper
acceptance 原始结果退出码为 0、`status=PASS`，覆盖文档列出的七个场景。

G1 重复构建仍只能判为 `PARTIAL`：同一依赖树原地重建后的字节身份通过，但不同
clean install 的 first-build 字节身份未稳定。helper 的官方 build script
`usedDirectly=false`，采用等价 direct CMake 路径；报告没有把它写成官方脚本可复现。

### 3.4 Documentation-only T0

先前的 T0 日志：

```text
.run/official-host-integration-v1-t0-final.log
bytes: 6620
sha256: 935EF86574A0B3B3C16E9AAB31CF18A57231186B2C1ADF059A2DFF975BA321D7
mode: NO_TESTS_APPLICABLE
stress: STRESS_TESTS_NOT_APPLICABLE
typecheck/build/plugin validation/git diff --check: completed
```

本次审查没有重跑会写入 tracked bundle 的 `npm run test:affected`，以满足“只写
`ASTRA_REVIEW.md`”的约束。上述日志是历史候选证据；本次独立执行了
`git diff --check origin/preview...HEAD`，结果通过。

## 4. 源码合同核对

### 4.1 16 MiB raw frame

当前 Bridge 在 `src/adapters/zcode-app-server-adapter.ts` 定义
`MAX_FRAME_BYTES = 16 * 1024 * 1024`，按未 trim 的 UTF-8 raw frame 字节计数；
超限立即进入致命的 `frame_over_limit`，拒绝 pending RPC 和 turn，并停止缓冲。

固定上游 `packages/services/src/zcode-agent/zcodeStdioTransport.ts` 使用
`StringDecoder("utf8")`、LF 切分和 pending chunk 数组，完整帧后 `join`，随后
`JSON.parse`；该源码没有等价的 16 MiB raw-byte 上限。文档正确地把
`FRAME_GUARD_PARITY` 标为 `BLOCKED_PENDING_TRANSPORT_DECISION`，没有把解析后长度检查
写成合同等价。

### 4.2 CodingAgentAdapter 与 Worker Claim

`src/interfaces.ts` 的 `CodingAgentAdapter` 仍只有 `startTask`、`continueTask`、
`getStatus`、`getResult`、`cancelTask` 五个方法。当前 `worker-main.ts` 接受
`adapter_mode = zcode_app_server | test_fake`，实际 production 分支仍实例化
`ZCodeAppServerAdapter`；diff 未增加 `OfficialHostAdapter` 或持久化新 adapter mode。

Worker 在 Claim 决策前校验 provenance、runtime profile、精确 Windows process
identity，并等待 `claim_committed`；因此报告所述“单 Attempt、Claim 后装配”的现有
入场边界与源码一致。报告也明确 `WORKER_HOST_INTEGRATION:
NOT_IMPLEMENTED`，没有把 POC probe 冒充生产 Worker。

### 4.3 Cleanup proof 与 Release

当前 `buildExecutionCleanupProof()` 只生成：

- `identity_bound_windows_tree_cleanup`；
- `verified_recorded_tree_scan`；
- 特定 `adapter_not_started`。

Manager 的 exact-key verifier 只接受对应 source/method；正常 cleanup 还要求
Worker exit code 0、同代 Worker identity probe 为 exited、execution proof、完整
resource facts、持久 cleanup digest，以及 CAS `releaseCapacity`。

固定上游 `WindowsRuntimeHost.close(deadlineAtMs)` 的内部成功条件确实包含 Job empty
、helper exit；ProcessManager cleanup 还会等待 exit diagnostics，失败时保留
`ownedProcesses`。但公开 `close()` 返回 `Promise<void>`，Job 名保留在 closure，
没有 Bridge 接受的 typed/persistent receipt。`dispose()`/`close()` resolved、
root exit、目标 PID 消失、Job empty/helper exit 和 Worker exit 因此必须分层。

报告正确指出新路径当前必须 fail closed，Cleanup Proof 仍是 Proposed，不能直接
Release。该硬阻塞是真实源码边界，不是完成报告中的猜测。

## 5. 状态一致性

一致的部分：

- ADR-032 是 `Accepted`，但明确标注 `TARGET ARCHITECTURE ONLY`；
- ADR-030 继续有效，没有被官方账户研究替换；
- 账户和 Cleanup 两项草案保持 `Proposed only`；
- 隔离 POC 被标为组件级 PASS，生产 Worker/Host 接线仍为 `NOT_IMPLEMENTED`；
- `FINAL_ACCEPTANCE_REPORT.md` 的 `ACCEPTED`、`BLOCKED`、`DEFERRED` 分类与
  `IMPLEMENTATION_SUMMARY.md` 一致；
- 真实模型、真实账户、Start Plan、Billing 均为零次；不能宣称生产 Host 已接入；
- `PR_READY: NO` 与 `PRODUCTION_CODE_CHANGED: NO` 正确。

需要修正的部分见第 1 节。`ACCOUNT_OWNERSHIP.md` 的 MCP OAuth 句子是实质性证据
冲突；`PR_DESCRIPTION.md` 缺少状态是仓库文档规则违反；`FINAL_ACCEPTANCE_REPORT.md`
的 Astra 状态在本审查文件加入后已过期。它们不推翻生产切换阻断，但阻止候选作为
内部证据包获得最终 `APPROVED`。

## 6. 残余风险与后续建议

1. 在真实实现前先由 Owner/ADR 决定同 profile 跨进程 refresh 的单一网络事务协调。
   文件锁和 revision CAS 只能保护落盘/CAS，不能证明 refresh single-flight。
2. 为固定上游 transport 选择窄扩展或受控 patch，保留 raw bytes 上限，并补齐接近
   上限、多字节 UTF-8、超限、partial frame 和 EOF 测试。
3. 先接受 Cleanup Proof 合同，再实现可跨崩溃恢复的 Job/runtime/helper observation；
   不得从进程快照、日志或 `Promise<void>` 合成长久证明。
4. 在 Worker 内实现 `OfficialHostAdapter` 后，验证五方法 parity、workspace identity、
   timeout/cancel、unknown acceptance、Browser/MCP、Claim/Hold/Recovery/Cleanup/Release。
5. 完成真实候选路径的 affected/full regression、性能比较、升级/回滚演练和真实账户
   阶段审查；这些均需新的明确授权。

## 7. Reviewer 执行边界

本次未修改生产源码、官方源码、SQLite、插件 bundle 或运行配置；未启动真实账户、
OAuth、Start Plan、Billing、模型或新的 POC；未 push、创建 PR、merge、tag 或
release。本次本地提交只包含本审查文件，除本文件外没有候选内容修改。

## 8. Final re-review

### 8.1 固定身份与差异边界

复核对象已重新固定为：

```text
HEAD: 5da873d1f2632ac67343be692fab121f682f4cef
tree: 4ab1a4edacc93b62fa49a03b038b43a618005566
base/origin-preview: 372e90622772b070357a278f1da3dea58fa42dee
merge-base: 372e90622772b070357a278f1da3dea58fa42dee
changed files: 32
non-doc files: 0
diff: 5688 insertions, 10 deletions
```

`git diff --name-status origin/preview...HEAD` 的结果全部是 `docs/` 下的
Markdown `A`/`M` 文件；没有源码、插件 bundle、SQLite、运行时配置、测试执行器或
依赖变更。`git diff --check origin/preview...HEAD` 通过。复核开始时工作区 clean。

修复提交 `5da873d1` 只修改四份文档：ADR-032、`ACCOUNT_OWNERSHIP.md`、
`FINAL_ACCEPTANCE_REPORT.md` 和 `PR_DESCRIPTION.md`。没有把第一轮发现的文档问题
通过放宽证据标准、修改生产合同或扩大 diff 范围来“修复”。

### 8.2 第一轮三项关闭核对

1. **CLOSED：MCP OAuth E2E 执行状态一致。**
   `ACCOUNT_OWNERSHIP.md` 已明确记录两次整文件运行及 `3 passed / 1 failed`；
   `ACCOUNT_CONCURRENCY.md`、`TEST_COVERAGE.md` 和 `REGRESSION_REPORT.md` 使用相同的
   `PARTIAL_3_OF_4` 边界。失败项仍是 caller-budget/authorization snapshot 缺少
   `authorizationUrl`，没有被标成 flaky、整套 PASS 或 general-account 并发证明。
2. **CLOSED：PR 描述具备文档状态。**
   `PR_DESCRIPTION.md` 顶部已有 `Status: RESEARCH`、日期和证据候选 SHA，满足仓库
   文档状态规则；其正文仍明确 `PRODUCTION_CODE_CHANGED: NO` 与 `PR_READY: NO`。
3. **CLOSED：最终验收的 Astra 占位状态已消除。**
   `FINAL_ACCEPTANCE_REPORT.md` 已从 `PENDING_FINAL_FILE` 改为
   `CHANGES_REQUIRED`，且 ADR-032 的后续能力状态也已同步。基于本轮最终复核，该报告
   下一授权的状态同步值必须为 `APPROVED`；本文件受“只写 `ASTRA_REVIEW.md`”边界
   限制，不能直接修改最终验收报告。

ADR-032 继续保持 `Accepted + TARGET ARCHITECTURE ONLY`，ADR-030、现有 Claim/Hold/
Recovery/Cleanup/Release、SQLite Authority 和 `CodingAgentAdapter` 合同未被改写。
账户与 Cleanup 两份草案继续保持 `Proposed only`。

### 8.3 证据与状态复核

- r9 原始结果为 `status: PASS`、12/12 assertions。3 个 loopback Mock HTTP 请求由
  2 个主 Turn 模型请求和 1 个辅助请求构成；usage 为 input 200、output 20、total 220，
  `modelRequestCount=2`，`realModelRequests=0`。
- r9 两代目标 AppServer/helper PID 集合 `13464, 9580` 和 `11224, 24124` 在对应关闭
  快照中均为空，`managedProcesses` 最终为空。这是隔离 Mock 的正常关闭观察，不构成
  Bridge 持久 Cleanup Proof、Release 或生产进程所有权证明。
- r7/r8/r9 继续被表述为隔离 ProcessManager/Mock 证据，生产 Worker、官方 Host
  Adapter 和事件/终端/错误映射仍为 `NOT_IMPLEMENTED`。
- G4 原始 result 仍将 `SAME_ACCOUNT_MULTIWORKER` 和 `TOKEN_REFRESH_RACE` 标为
  `FAIL`；network ledger 有 2 次请求，第二个复用一次性 refresh token 的 Worker 被
  `409 rotation_reuse_rejected` 拒绝。CAS、fresh-process read、failure isolation 和
  crash-lock release 的局部 PASS 没有被合并成 general-account refresh PASS。
- 当前 `CodingAgentAdapter` 仍是 `startTask`、`continueTask`、`getStatus`、
  `getResult`、`cancelTask` 五方法；没有生产 `OfficialHostAdapter`。
- 当前 Bridge `MAX_FRAME_BYTES = 16 * 1024 * 1024` 按 raw UTF-8 frame 字节 fail closed；
  官方 transport 的等价防护仍为 `BLOCKED`。
- `buildExecutionCleanupProof()` 仍只接受现有 exact-key 三类 proof；`dispose()` 或
  close resolved、root/PID exit 未被写成 Bridge cleanup verification。Manager 仍要求
  exact Worker identity exit、完整 process/resource facts、持久 cleanup digest 和
  CAS `releaseCapacity`。
- 真实模型、真实账户、OAuth、Start Plan、Billing 均为 `0 / NOT_RUN` 或相应阻断状态；
  文档没有把 POC 组件结果写成生产集成。

### 8.4 Final findings

- **P0: NONE**
- **P1: NONE**
- **P2:** ADR-032 的“决定时未决能力与后续状态”已列出 8 项，但 Consequences 段落仍写
  “不解决全部六项未决能力”。这是非阻断的数值残留，应改成“八项”或“全部未决能力”；
  不改变缺口集合、生产切换判断或本次批准。
- **P2 / handoff:** `FINAL_ACCEPTANCE_REPORT.md` 当前仍显示第一轮需要的
  `CHANGES_REQUIRED`。本次最终审查要求的后续值是 `APPROVED`，须由另有写权限的任务
  同步；本轮严格只修改本审查文件。

### 8.5 Final verdict

第一轮三项问题均已关闭，最终候选仍保持 docs-only，生产切换与 PR-ready 阻断没有
弱化。两项 P2 是低速文档状态事项，不构成新的 P0/P1 或证据包实质缺陷。

```text
ASTRA_REVIEW: APPROVED
PRODUCTION_SWITCH_SAFE: NO
PR_READY: NO
FINAL_ACCEPTANCE_REPORT_REQUIRED_STATUS: APPROVED
```

本轮没有运行构建、POC 或任何真实/Mock runtime，没有修改生产源码或合同，没有
commit、push、PR、merge、release。除本文件外没有写入候选文件。
