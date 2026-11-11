# G4：账户并发、刷新与 revision 收敛

> Status: RESEARCH — DOUBLE-REFRESH REPRODUCED / EXISTING CONTRACT PRESERVED
> Date: 2026-11-11
> Bridge baseline: `9710303397fe2d544c75698f783a8174404b2d51`
> Observed upstream: ZCode `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`，`3.18.0`
> Evidence level: 源码/测试定义核对、现有 Bridge 合成测试，以及两个真实 Node 子进程的窄 official account assembly + loopback strict-rotation Mock。未执行真实 OAuth、真实 credential rotation、Billing、Start Plan 或模型请求。

## 1. 结论

现有 Bridge Capacity、路径 admission、Claim、Hold、Recovery、Cleanup、Release 和 Worker slots 合同不变。ADR-032 不允许为了让官方账户接入更简单而静默减少并发。

但“设计必须保留现有并发”不等于“新路径同 profile 多 Worker 已验证”：

```text
EXISTING_WORKER_CONCURRENCY_CONTRACT: PRESERVED_BY_DESIGN
EXISTING_CONCURRENCY_REGRESSION: PASS
SAME_PROFILE_MULTIWORKER: FAIL
TOKEN_REFRESH_RACE: FAIL
TOKEN_ROTATION: PASS
REVISION_PROPAGATION: FRESH_PROCESS_READ_PASS / LIVE_CACHE_NOT_PROVEN
ACCOUNT_FAILURE_ISOLATION: PASS
CRASH_LOCK_RELEASE: PASS
CREDENTIAL_BROKER_NECESSITY: PROPOSED_BY_SYNTHETIC_EVIDENCE_ONLY
REAL_ACCOUNT_E2E: NOT_RUN
```

两个真实子进程已经复现 general account double-refresh：二者在 barrier 后使用同一
一次性 refresh token 请求 loopback Mock，第一个完成 rotation，第二个收到
`409 rotation_reuse_rejected`。因此当前每 Worker 独立装配 `OAuthService` 的路径不满足
同 profile 多 Worker。这里提出的是最小 coordination 研究决定，不是已批准的 broker
实现；仍不得新增独立 Companion/Broker 进程、IPC 或业务数据库。

## 2. 不同并发层不能混为一个锁

| 层 | 当前机制 | 保护范围 | 不能推出 |
|---|---|---|---|
| credential file RMW | 跨进程文件锁 + 原子写 | 单个凭据文件从读取到替换的 mutation | 远端 refresh 只执行一次 |
| OAuth session CAS | expected snapshot + revision | 防旧 snapshot 覆盖新 session | 旧网络响应没有副作用 |
| OAuth service mutation | 进程内 Promise queue | 单 service 实例内 profile/logout/token mutation 串行 | 跨 Worker single-flight |
| MCP OAuth lease | MCP 子系统专用跨进程 lease | MCP token refresh/authorization single-flight | Start Plan 或一般账户同样安全 |
| Bridge entitlement | 单 Issuer/Task verdict + Private Lease | Task entitlement 与 private delivery | 跨 Task 账户共享或跨进程 refresh |
| Bridge scheduler | Capacity/path/Claim | Task 并发与资源准入 | 同 account provider 的云侧并发上限 |

一个短文件锁覆盖凭据落盘，不应锁住整个 Task、Session 或模型流。反过来，仅有一把文件锁也不能把网络 refresh 包成全局事务。

## 3. 官方源码事实

### 3.1 跨进程文件锁

`packages/shared/src/node/privateFilePersistence.ts:49-80`：

- read 使用 generation fence；
- mutation 先获得 `withFileLock(filePath)`；
- 锁内再次 assert generation；
- 调用者执行完整 read-modify-write。

`apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts:434-451`：

- 锁内重读最新 credential record；
- 执行 mutation；
- 原子写私有文件；
- 不把旧快照覆盖新 key。

这为并发 credential mutation 提供了必要基础。

### 3.2 session revision CAS

`packages/services/src/oauth/repo/oauthCredentialRepo.ts:570-583`：

- token set 保存时写新随机 session revision；
- expected snapshot 不匹配则条件提交失败。

这能拒绝迟到的旧状态覆盖当前登录，但不能阻止多个进程各自先向 provider 发出 refresh。

### 3.3 refresh 网络段不在跨进程锁内

`packages/services/src/oauth/oauthService.ts:1172-1216`：

1. 读 snapshot/token；
2. 调用 provider `refreshToken`；
3. 网络返回后进入 process-local `runSessionMutation`；
4. 检查进程 generation；
5. 用原读 snapshot 调 `saveTokenSet`。

`sessionMutationQueue` 位于单个 service 实例，见 `oauthService.ts:145,501-507`。它不协调两个 Worker 的网络 refresh。

潜在结果：

- 只有一个进程 CAS 成功时的最终文件更新可以受保护；
- 两个进程可能都使用同一 refresh token 发起请求；
- 若 provider 使用严格 rotation reuse detection，较早请求会使另一请求或整个 token family 失效；
- 不能把“CAS loser 未覆盖文件”写成“refresh 已 single-flight”。

双进程合成运行已将上述潜在结果变为观测事实：

```text
request 1: worker-b, rotated
request 2: worker-a, 409 rotation_reuse_rejected
```

最终 profile 由 winner 更新，两个 fresh process 读到相同的新 token/revision；失败
Worker 没有读取 winner 后重试，而是返回拒绝。证据路径见
`.run/lifecycle-account-evidence/ACCOUNT_MULTIWORKER_EVIDENCE.md`。

### 3.4 可选 provider refresh

`packages/services/src/oauth/providers/providerAdapter.ts:21-38` 将 `refreshToken` 定义为可选。固定版本的 BigModel adapter 没在本轮找到具体刷新实现。泛型 OAuth service 存在入口不等于所有 Start Plan/Coding Plan profile 已具备无感续期。

## 4. MCP OAuth 证据边界

官方源码存在跨进程 MCP OAuth 测试定义：

- `apps/zcode-cli/packages/adapters/tests/mcp-oauth-cross-process.e2e.test.ts:357-397`
- `apps/zcode-cli/packages/adapters/tests/mcp-oauth-refresh.test.ts:198-...`

其中一个测试启动两个真实子进程、并发刷新 near-expiry token，并断言 exactly one network request。它说明官方已有可借鉴的 lease/lock-in-recheck 设计。

本轮在主 Agent 完成隔离安装后直接执行了该测试文件。关键用例“two real processes refresh one near-expiry token with exactly one network request”在两次整文件运行中均通过；“two real processes elect one authorization leader”和“reclaims authorization lease after leader kill”也通过。整文件仍为 `3 passed / 1 failed`：`completes authorization that outlasts the caller budget (incident timeline replay)` 在两次运行中都以同一 missing `authorizationUrl` 断言失败。

因此可以写：

```text
MCP_OAUTH_CROSS_PROCESS_REFRESH_SINGLE_FLIGHT: PASS_SYNTHETIC
MCP_OAUTH_CROSS_PROCESS_FULL_FILE: PARTIAL_3_OF_4
```

该失败属于同文件的 caller-budget/authorization snapshot 用例，不是“两次 refresh 都到达服务端”的竞争失败；但由于整文件未通过，不能报告整套 MCP OAuth E2E PASS。测试运行时报告 Node `v24.22.1`/pnpm `11.25.0`，与官方 mise pin 不同，也不能把结果扩展成官方工具链验收。

即使 MCP 关键用例通过，也不覆盖：

- Start Plan Billing entitlement；
- BigModel profile refresh；
- same account across general Workers；
- account snapshot propagation to another live Worker；
- device identity；
- Bridge Private Lease/HANDLE/ACK；
- Worker/Manager restart and account A→B→A。

## 5. 现行 Bridge 并发语义

`src/runtime/start-plan-production-auth.ts:460-568`：

- issuer 按 dispatch/task 创建；
- `entitlementContext` 与 `issuedTask` 为该 issuer 私有；
- separate tasks 各自 one Billing check；
- issuer 的一次 lease 不跨 Task 共享。

`src/runtime/start-plan-private-lease.ts:1-120`：

- 一次性 delivery；
- 绑定完整执行坐标；
- competing redeem 不 revoke 在途 lease；
- ACK/delivery loss 为 unknown，重试不可恢复。

现有 33 个定向测试通过，包括 separate tasks each exactly one Billing 和 shared task/Desktop selection 不串用。它们验证 Task-scoped private delivery，不等于同 profile 多 Worker refresh。

## 6. 并发场景结论矩阵

| 场景 | 目标要求 | 当前状态 | 必须的验证 |
|---|---|---|---|
| 不同 profile、不同 Task Workers | 允许并行 | NOT_RUN | 两服务进程用独立合成 profile 启动 |
| 同 profile、不同 Task Workers | 不得静默串行化 | 读取通过 / refresh 不安全 | 完整 Task/Session/runtime auth 交叉 |
| 同 profile 并发读取 | 快照一致或 revision 可见 | PASS_SYNTHETIC | 两 fresh processes 读到相同 revision/token |
| 同 profile 同时 refresh | 最多一个远端 rotation | FAIL_SYNTHETIC | 两个真实进程各自发出请求 |
| Winner 更新 revision | loser 复用或失败关闭 | PARTIAL_SYNTHETIC | loser 被拒绝且未覆盖；未自动复用 |
| CAS loser 丢失响应 | 不覆盖 winner，结果可归因 | PASS_SYNTHETIC | 条件写恰好一个 winner |
| Worker 崩溃持锁 | 锁可回收，无 orphan | PASS_SYNTHETIC | 锁持有 child 终止后下一进程 `17 ms` 取得锁 |
| Account A→B→A | 旧 revision 迟到不得复活 | NOT_RUN | 三次切换、延迟响应 |
| Logout/account invalidation | live Worker 收敛或 fail closed | NOT_RUN | 两进程并发 invalidate |
| 一个 Worker refresh 失败 | 另一个不串库/不误用失败 token | PASS_SYNTHETIC | 失败者不改 profile，健康 reader 继续 |
| 两个 Task continuation | 不串 Session/credential scope | NOT_RUN | 两 Worker 同 profile 不同 lineage |

## 7. 必须验证的竞争点

### 7.1 Refresh 网络事务

如果 fixed upstream 没有 general account cross-process single-flight，目标实现不得简单把 `OAuthService` 放进每个 Worker 后宣称安全。需要：

- 在最小 mutation 周围重新读取 canonical revision；
- 如果已有人完成更新，loser 直接读取新 token；
- 只让一个刷新请求使用一次性 refresh token；
- 远端结果返回后再次以 revision/identity 条件提交；
- 失败分类必须区分 local loser、provider reject、network unknown 和 account changed。

任何 lock 只覆盖短事务，不锁模型流。

### 7.2 Account snapshot 传播

文件 revision 更新并不保证 live Worker 的 account/provider resolver 立即收到新 snapshot。测试需观察：

- in-memory cached snapshot；
- provider onMutate/credential listener；
- 新 runtime auth request；
- logout 后迟到 request；
- 两个独立 service instances。

不能把同进程 event callback 当作跨进程广播。

### 7.3 Entitlement

ADR-030 verdict 是 Task-scoped。两个同 account Task 可以独立做一次 entitlement check，但不能共享 Private Lease。未来若官方 resolver 替代 ADR-030，必须新 ADR 明确：

- freshness；
- account/provider/model/device binding；
- revision；
- unknown/denied；
- fail-closed；
- 是否减少、合并或复用 Billing 请求。

本任务不允许为并发刷新增加额外 Billing GET 或第三次查询。

## 8. Credential Broker 决策

当前结论是 **PROPOSED_BY_SYNTHETIC_EVIDENCE_ONLY**：

- 现有文件锁与 revision CAS 能保护落盘和旧写入，但不能阻止 double-refresh；
- 双进程竞态已经用严格一次性 refresh token 复现；
- 不可在没有证据时新增独立 broker 进程、Broker IPC 或凭据数据库；
- 也不可为了“简单”让每账户只允许一个 Worker。

合成多进程证据已经达到研究最小协调机制的门槛。首选只研究在现有 Bridge
Host/Manager 或现有 official account service 内的短事务、lease 或 lock-in-recheck；
任何扩展仍须 Owner/ADR 批准，且不得演变为独立服务。

## 9. 最少后续实验

在单独授权的 POC/G4 中，按以下顺序执行：

1. 两独立 profile、两 Worker、不同 Workspace——基准并行；
2. 同 profile、两 Worker、独立 Task/Session——读取与 runtime auth；
3. Mock refresh 使用严格一次性 refresh token——并发 refresh；
4. 一个 winner 更新 revision，另一个 re-read 检测并复用；
5. CAS loser 不覆盖；若只能 fail closed，记录产品行为；
6. A→B→A、logout、旧响应迟到；
7. Worker/helper crash 与文件锁恢复；
8. Manager restart 后读取 canonical revision；
9. 两个 Task 的 private lease、session、turn、ACK 互不串用；
10. 全程仅 loopback Mock，记录 network attempts、status、revision 和 failure class。

本轮覆盖第 2 项的并发读取子集，以及第 3、5、7、10 项；第 4 项只证明 winner
落盘和 fresh-process 可见，没有证明 loser 自动复用。完整 Workspace/Session/runtime
auth 隔离、独立 profile、A→B→A、Manager restart 和双 Task lineage 仍未覆盖。第 2
项的 runtime auth 未运行；同一轮 double-refresh 已复现。

通过标准不是“没有异常退出”，而是没有二次 rotation request、没有旧 revision 获胜、没有 cross-task credential/session 使用，并且 unknown 状态保持 Hold/fail-closed。

## 10. 当前验证状态

现有 Bridge：

```text
33 targeted Start Plan/private auth tests: PASS
139 lifecycle/cleanup tests: PASS
```

官方：

```text
credential-recovery-fence + auth + credential-security: PASS (55/55)
MCP OAuth cross-process refresh single-flight: PASS_SYNTHETIC
MCP OAuth cross-process full file: PARTIAL_3_OF_4
observed runtime Node/pnpm: v24.22.1 / 11.25.0
official mise pin: 24.14.0 / 10.33.2
general account multi-process narrow synthetic path: RAN / FAIL
Start Plan multi-process execution: NOT_RUN
```

```text
SAME_ACCOUNT_MULTIWORKER: FAIL
TOKEN_REFRESH_RACE: FAIL
TOKEN_ROTATION: PASS
REVISION_PROPAGATION: FRESH_PROCESS_READ_PASS / LIVE_CACHE_NOT_PROVEN
ACCOUNT_FAILURE_ISOLATION: PASS
CRASH_LOCK_RELEASE: PASS
MCP_OAUTH_REFRESH_SINGLE_FLIGHT: PASS_SYNTHETIC
MCP_OAUTH_CROSS_PROCESS_SUITE: PARTIAL
CREDENTIAL_BROKER_NECESSITY: PROPOSED_BY_SYNTHETIC_EVIDENCE_ONLY
EXISTING_WORKER_CONCURRENCY: PRESERVED
REAL_ACCOUNT_E2E: NOT_RUN
```

原始多进程结果位于
`.run/lifecycle-account-evidence/g4-harness/runs/2026-11-11T12-35-56.153Z-24920/result.json`。
其 `result.json` SHA256 为
`0B4CA50E8BBAD3C753ADBE08D890602C3887B5601E789C5BDD9537AEED3AD19B`。这些状态必须
在实现和最终验收报告中保留；后续 coordination 候选通过更完整的竞争矩阵前，不得改写成
PASS。
