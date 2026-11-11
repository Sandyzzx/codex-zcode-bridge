# G4：账户所有权与权益事实

> Status: RESEARCH — SYNTHETIC MULTI-WORKER EVIDENCE / ACCOUNT E2E NOT RUN
> Date: 2026-11-11
> Bridge baseline: `9710303397fe2d544c75698f783a8174404b2d51`
> Observed upstream: ZCode `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`，`3.18.0`
> Architecture authority: [ADR-032 Accepted](../../decisions/ADR-032-existing-worker-official-host-integration.md)
> Existing auth authority: [ADR-030 Active/Amended](../../decisions/ADR-030-start-plan-provider-preflight.md)
> Evidence level: 源码与现有 Bridge/官方测试核对；两个真实 Node 子进程使用 case-local 合成 profile 和 loopback strict-rotation Mock 完成窄装配验证；未做真实 OAuth/profile/凭据刷新、Billing、Start Plan 或模型请求。

## 1. 结论

目标所有权是：

```text
persistent logical profile
  → official credential/OAuth service inside Existing Worker
    → official account/provider snapshot and revision
      → official runtime request auth
```

Bridge Core 只保留不透明 profile 引用、非秘密账户可用性、Task/Attempt 绑定和失败分类。它不保存 JWT、cookie、refresh token、设备身份或加密主密钥，也不成为第二个账户状态数据库。

当前仍需遵守 ADR-030 Preview.3 合同：每个 Issuer/Task 一次权威 Billing entitlement verdict，后续仅对完全相同 account/provider/model/device/credential binding 复用；Private Lease/HANDLE/ACK、fail-closed、不跨任务缓存全部有效。

官方账户服务接入不自动授予替代 ADR-030 的权力。账户所有权草案继续为 **Proposed only**。

## 2. 身份与职责分层

| 对象 | 目标 owner | 持久事实 | Bridge 可以看到 | 明确禁止 |
|---|---|---|---|---|
| logical profile | 用户显式供给，Worker 内官方服务消费 | 持久 profile identity/configuration | 不透明 profile ref 与非秘密状态 | 每 Attempt 新建空 profile 后宣称 continuation |
| credential file | 官方 credential store | 加密/私有记录、revision | 是否可用、失败分类 | Core 保存秘密或复制 token |
| OAuth/session state | 官方 OAuth service | token set、active provider、session revision | 可用性/变更事件 | 第二套账户权威数据库 |
| account/provider snapshot | 官方 service | source/revision/config projection | 非秘密版本/可用性摘要 | 把旧 snapshot 当实时 entitlement |
| entitlement | 当前 ADR-030；未来须新 ADR | 单任务 verdict | 单任务 verdict 与绑定 digest | unrelated Task 复用、HTTP 200 当权益 |
| runtime request auth | 官方加当前私有 delivery 桥 | 短期请求材料 | scope 与 delivery ACK | 普通事件/Result/SQLite 泄漏秘密 |
| Task/Attempt | Bridge SQLite Authority | claim/result/cleanup/release | 全部生命周期事实 | 官方 Session 直接决定 Task 终态 |

## 3. 官方 Credential Store 的已确认事实

`apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts` 把所有 mutation 放入跨进程文件锁，并覆盖完整 read-modify-write，而不是只保护最后一次 atomic rename：

- 普通读取前后做 recovery generation 校验；
- mutation 持有 `withCredentialFileMutation`；
- 锁内重读最新值、执行 mutation、原子写私有文件；
- 单个进程内 listener 失败不会把已落盘写入伪装成失败。

底层依据：

- `packages/shared/src/node/privateFilePersistence.ts:49-80`
- `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts:109-129,434-451`

该合同足以防止旧 snapshot 覆盖另一进程刚写入的无关 key，但它本身不证明远端 token rotation 已经全局 single-flight。

## 4. OAuth Session、CAS 与 revision

`packages/services/src/oauth/repo/oauthCredentialRepo.ts:570-583` 的 `saveTokenSet`：

- 写入 access/refresh/zcode JWT；
- 用随机 UUID 更新 session revision；
- 以 expected snapshot 做条件提交。

`packages/services/src/oauth/oauthService.ts:1168-1216`：

- 先读取 token set 和 snapshot；
- 在 session mutation queue 内先检查进程代次；
- 网络 refresh 发生在该进程 queue 之外；
- 网络完成后才进入 `runSessionMutation`；
- 用最初读取的 `snapshot` 作为 expected snapshot 保存；
- `saveTokenSet` 返回 false 时必须视为 session changed，不能让旧刷新结果无条件覆盖新登录。

`oauthService.ts:145,501-507` 的 `sessionMutationQueue` 是单个 `OAuthService` 实例的 Promise chain，不是跨进程锁，也不是跨 Worker lease。

因此必须区分三种机制：

1. 凭据文件 RMW 跨进程锁；
2. session snapshot/revision CAS；
3. 远端 refresh/rotation 的幂等和 single-flight。

前两项源码存在，第三项对于所有账户入口尚未证明。

固定提交上的双进程合成实验已经给出直接反例：两个 Worker 在 barrier 后使用同一
`synthetic-refresh-v1` 各发一次 refresh；loopback Mock 接受第一个并返回新 token，
以 `409 rotation_reuse_rejected` 拒绝第二个。最终文件 revision 可见，但失败 Worker
没有自动复用 winner 的结果。因此不能把 credential file lock 或 revision CAS 当成
general account refresh single-flight。原始证据见
`.run/lifecycle-account-evidence/ACCOUNT_MULTIWORKER_EVIDENCE.md`。

## 5. Provider refresh 能力边界

`packages/services/src/oauth/providers/providerAdapter.ts:21-38` 把 `refreshToken` 定义为可选方法。固定版本的 `bigmodelProviderAdapter.ts` 会读取和保存 refresh token，但本轮未找到其具体 `refreshToken` 实现。

所以不能把以下概念混为一谈：

- 凭据文件可以原子更新；
- OAuth service 暴露泛型 `refreshToken()`；
- BigModel/Z.ai profile 已支持无感续期；
- Project Token 可刷新；
- Start Plan 权益可持续刷新。

固定版本的 MCP OAuth 还有专门的跨进程 single-flight/lease 实现与双进程 synthetic E2E 测试定义，见：

- `apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.ts`
- `apps/zcode-cli/packages/adapters/tests/mcp-oauth-cross-process.e2e.test.ts:357-397`

这些测试定义针对 MCP OAuth 子系统，不能推广成 Start Plan profile 或一般账户 provider 的并发证明。本轮也未执行该 E2E。

## 6. 当前 Bridge 所有权

`src/runtime/start-plan-production-auth.ts:460-568` 为每个 dispatch 创建独立 issuer：

- 初始读取官方凭证，失败则 fail closed；
- issuer state 保存唯一 `entitlementContext` 和 `issuedTask`；
- `prepare()` 读取当前凭证，核验 account、expiry、account/provider/model/device/credential digest 绑定；
- 首次 prepare 进行权威 entitlement check；
- issue 再读取凭证并校验同一绑定，复用已建立 verdict；
- 同一 issuer 只发一次 lease；
- 不同 Task 使用不同 issuer，各自一次 Billing，不共享 Private Lease。

`src/runtime/start-plan-private-lease.ts:1-120` 的 lease：

- 一次性；
- 绑定 account/provider/model/task/attempt/operation/generation/claim/session/turn/pid/creation；
- delivery deadline 与实际 credential lifetime 分离；
- redeem 前先同步 claim；
- 竞争 redeem 不撤销已在途 delivery；
- delivery error、ACK loss、取消或超时都进入不可重试状态。

这是当前生产合同，不由官方 credential store 的文件锁替代。

## 7. 目标 Worker 内账户供给

POC/实现阶段需要证明一个最小官方 account context 能提供：

- profile 根与可写数据根显式配置；
- 无 Desktop Main、Desktop DB、真实代理或设备身份隐式依赖；
- credential store 与 runtime auth resolver 的窄装配；
- account snapshot 变更的可观察方式；
- entitlement/request auth 与当前 model/provider 绑定；
- logout/account switch/cancel 后迟到请求拒绝；
- 无秘密进入普通日志、事件、Result、SQLite 或 Bridge diagnostics。

如果必须调用完整 `createServerHostServices()` 才能得到账户上下文，则暂停，因为它会同时带入不必要的 repo、插件、MCP、遥测和设备副作用。需要寻找更窄的官方导出或另行决定，不能先运行再观察是否碰到生产数据。

## 8. 同 profile 共享的原则

ADR-032 不把“每账户一个 Worker”作为产品限制。目标允许多 Worker 绑定同一逻辑 profile，但必须满足：

- 不复制 token 造 profile；
- Task/Session/Workspace lineage 隔离；
- 单次短 credential mutation 可协调；
- 不增加 task-long 或 model-stream-long account lock；
- refresh failure、account invalidation、logout 和行为修订能跨进程收敛；
- 旧 revision/旧请求结果不能复活已登出或已切换账户。

本轮验证结果为：

```text
SAME_ACCOUNT_MULTIWORKER: FAIL
TOKEN_REFRESH_RACE: FAIL
TOKEN_ROTATION: PASS
REVISION_PROPAGATION: FRESH_PROCESS_READ_PASS / LIVE_CACHE_NOT_PROVEN
ACCOUNT_FAILURE_ISOLATION: PASS
CRASH_LOCK_RELEASE: PASS
REAL_ACCOUNT_E2E: NOT_RUN
START_PLAN_REAL_ENTITLEMENT: NOT_RUN
```

两个 fresh reader 在 rotation 后读到相同的新 access/refresh token 和 revision；CAS
竞争者恰好一个成功，loser 未覆盖 winner；一个 Worker 的 refresh 失败未改写 profile，
另一个 reader 仍成功；锁持有进程被终止后，下一进程在 `17 ms` 内回收锁。与此同时，
失败 Worker 在收到 409 后的 snapshot 仍是旧 token，运行中的 service 是否接收跨进程
热更新仍未证明。

## 9. 合成测试门槛

同一 profile 多 Worker 的生产资格至少需要两个真实服务进程和本地 Mock：

1. 并发读取同一 profile；
2. 同一时刻触发 refresh；
3. 严格的 rotation token 只允许一次远端使用；
4. 一个 winner 写入新 revision，loser 读取 winner 结果；
5. CAS loser 不覆盖 winner；
6. A→B→A account switch 拒绝旧迟到结果；
7. logout 后旧 token/cached runtime auth 失效；
8. 一个 Worker 崩溃不永久持有文件锁；
9. Manager/Worker 重启后读取正确 revision；
10. 两独立 Task 不串 Session、凭据 scope 或 entitlement；
11. unknown/denied entitlement 始终 fail closed；
12. 只发送一次可能已接受的 Prompt，不因 auth retry 重发。

单个 MCP OAuth 测试定义不能满足 Start Plan profile 全部门槛。

本轮合成实验实际覆盖了第 1、3、4、5、8 项中的基础子集；第 2 项暴露 double-refresh
失败，第 4 项的 loser 未自动复用 winner。A→B→A、logout、Manager restart、两个 Task
的 Private Lease/runtime auth、真实 entitlement 和“不重发可能已接受 Prompt”仍未运行。

## 10. 本轮 Bridge 测试

```text
node scripts/test-isolated.mjs \
  dist-test/test/start-plan-private-lease.test.js \
  dist-test/test/start-plan-private-channel.test.js \
  dist-test/test/start-plan-production-auth.test.js

33 tests, 33 pass
```

覆盖 one-shot lease、错误身份、ACK loss、30 秒交付期限与凭证寿命分离、每 Task 一次 Billing、shared task 不串用、设备身份 fail-closed、Start Plan/Coding Plan 分流。

首轮 `pnpm --filter @zcode/adapters exec vitest` 因依赖安装超时没有进入 Vitest。主 Agent 完成隔离安装后，本轮改为直接执行 source 内已安装的 Vitest 二进制，成功运行：

```text
node ../../../../node_modules/vitest/vitest.mjs run \
  tests/credential-recovery-fence.test.ts \
  tests/auth.test.ts \
  tests/credential-security.test.ts

3 test files passed
55 tests passed
```

运行时实际报告 Node `v24.22.1`、pnpm `11.25.0`；官方 mise 固定 Node `24.14.0`、pnpm `10.33.2`。所以该结果是固定源码上的合成凭据测试证据，不是官方工具链兼容性 PASS。

```text
OFFICIAL_CREDENTIAL_SUITES: PASS
OFFICIAL_TOOLCHAIN_PIN_COMPLIANCE: NOT_PROVEN
OFFICIAL_SOURCE_TRACKED_CHANGES_AFTER_INSTALL: NONE
```

## 11. 验收结论

```text
ACCOUNT_OWNERSHIP_DESIGN: PASS
OFFICIAL_CREDENTIAL_STORE_RMW_LOCK: SOURCE_CONFIRMED
SESSION_REVISION_CAS: SOURCE_CONFIRMED
EXISTING_ADR_030_SEMANTICS: PRESERVED
PRIVATE_LEASE_REGRESSION: PASS
OFFICIAL_CREDENTIAL_STORE_TESTS: PASS
OFFICIAL_ACCOUNT_SERVICE_ASSEMBLY: PARTIAL
SYNTHETIC_CREDENTIAL_FLOW: PARTIAL
SAME_ACCOUNT_MULTIWORKER: FAIL
TOKEN_REFRESH_RACE: FAIL
TOKEN_ROTATION: PASS
REVISION_PROPAGATION: FRESH_PROCESS_READ_PASS / LIVE_CACHE_NOT_PROVEN
ACCOUNT_FAILURE_ISOLATION: PASS
CRASH_LOCK_RELEASE: PASS
CREDENTIAL_BROKER_NECESSITY: PROPOSED_BY_SYNTHETIC_EVIDENCE_ONLY
REAL_ACCOUNT_E2E: NOT_RUN
ACCOUNT_ADR_STATUS: PROPOSED_ONLY
```

双进程证据已经证明 current narrow assembly 不安全，因此生产账户支持不能标记
PASS。下一步只能研究现有 Host/Manager 或现有 official account service 内的最小
coordination，不能新增独立 Companion/Broker 进程、IPC 或凭据数据库，也不能用单
Worker 实验限制替代现有并发合同。
