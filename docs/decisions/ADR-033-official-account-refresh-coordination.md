# ADR-033：官方账户 Refresh 的跨进程协调

> Status: DECISION
> Date: 2026-11-11
> Decision: Accepted — Owner 在 Official Host Integration v1 恢复任务中批准 Profile-scoped Cross-process Refresh Lock。
> Applicability: 仅协调官方 OAuth credential refresh 事务；不改变 ADR-030 的 Start Plan entitlement verdict、Private Lease/HANDLE/ACK，也不改变 Worker/Task/Session 并发合同。
> Verified against: Bridge candidate `8e8966d5ec7539a2d8575fc748871a9641fe0a2d` and current fixed-upstream patch; Observed upstream `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`。

## Context

现有 Bridge 与固定官方源码已能读取和原子写入合成 credential，但真实双进程合成证据仍显示
同 profile 的两个 Worker 可同时提交同一一次性 refresh token。一个进程先完成 rotation，另一个
随后收到 `rotation_reuse_rejected`。结果目录：

```text
.run/lifecycle-account-evidence/g4-harness/runs/2026-11-11T12-35-56.153Z-24920/result.json
```

Credential file lock 保护整文件 read-modify-write，但不覆盖远程 refresh 事务。Session revision
CAS 能拒绝过期写入，却不能撤销已被远端消费的旧 refresh token。进程内 `sessionMutationQueue`
也不能提供跨进程 single-flight。因此只扩展现有不可重入 file lock，或在网络请求之后才比较
revision，均不能满足合同。

固定官方源码的 MCP OAuth lease/refresh 已采用“独立 lease + lease 内重读 + 一次远端操作”的
模式。本决定复用该模式，不创建新的账户所有者进程。

## Decision

### 1. 独立、窄范围的 Refresh Lock

General OAuthService 的 refresh 事务使用独立于 Credential File Lock 的跨进程 lock。lock
identity 至少包括：

- 规范化 credential file path；
- active provider；
- active profile/account identity；
- refresh lock schema/version。

不同 profile 使用不同 lock，可并发刷新。相同 profile 只在 refresh 事务上串行，不锁 Task、
Attempt、Session、模型流或整个 Worker 生命周期。

### 2. Lock 内重新读取与判定

获取 lock 后必须重新读取最新 credential 和 revision。写入方不能只凭 revision 改变宣布刷新
已由其他进程完成；还必须确认最新 token set 可用，并证明它不是来自已消费的旧 refresh token。

最小事务顺序：

```text
acquire profile-scoped refresh lock
  -> reread credential + revision + token generation
  -> if another process published a usable newer token set: reuse it
  -> otherwise hold the lock across exactly one provider refresh request
  -> verify response belongs to the token generation read under the lock
  -> atomically persist with expected-snapshot/revision CAS
  -> publish process-local revision/token-set observation
release lock
```

网络请求位于 lock 内。不能把网络刷新放在 lock 外再以 CAS 尝试收尾。

### 3. Timeout、失败与锁恢复

lock 记录 owner identity、generation 和可判定创建时间。owner 进程崩溃、正常退出或超时后，
其他进程只能按固定 lease 规则回收 stale lock；回收本身需要使用跨进程原子操作，并在取得
lock 后再次重读 credential。网络超时或 refresh 失败不得生成新 session revision，不得把旧
credential 当成新 token，也不得自动串行重试一次可能已被远端接受的 refresh。

refresh 调用必须使用有界 timeout。超时后的结果按 unknown 处理，保留可解释错误事实；后续请求
先按新的 lock 事务重读。不得通过并发发送第二个 refresh 来消除 unknown。

### 4. 原子发布与迟到响应

发布路径继续使用现有 atomic persistence 和 expected-snapshot CAS。持久化成功后，本进程发布
新的 session revision/token-set generation；发布失败时，本进程不得继续使用未持久化 token。

若网络响应返回时 credential generation 已改变，该响应只能用于失败分类，不能覆盖更新事实。
旧 Worker 的迟到响应不能重新发布旧 refresh token、旧 JWT 或旧 revision。

### 5. Live revision propagation

live Worker 在生成新的 request-auth material 前核对当前 credential revision/token generation。
若已有更新的可用 token set，更新进程内账户上下文后继续；若无法安全更新仍持有旧一次性 token
的上下文，则 fail closed 或重新读取。禁止在 revision 落后时继续使用已知过期 token。

Account A -> B -> A 切换必须重新验证当前 active profile identity。返回路径 A 不能复用绑定到
旧 generation 的迟到响应或旧内存上下文。

### 6. 明确排除

- Credential Broker 或独立账户服务。
- 第二套凭据数据库或任务数据库。
- 每账户只能一个 Worker。
- 整轮 Task/Worker 的账户互斥。
- 将现有 Credential File Lock 改成可重入锁并在内部嵌套。
- 修改 ADR-030 的 entitlement authority，或由 refresh 成功推导 Start Plan 权益。

## Relationship To Existing Decisions

[ADR-030](ADR-030-start-plan-provider-preflight.md) 的 Preview.3 合同不变：每个
Issuer/Task 的一次权威 entitlement verdict、Private Lease/HANDLE/ACK、fail-closed 和
不跨任务缓存继续生效。Refresh Lock 只保证账户 credential/token rotation 安全，不是 Billing
authority，也不能替代单次任务 verdict。

[ADR-032](ADR-032-existing-worker-official-host-integration.md) 的现有 Worker、SQLite
Authority 和并发合同不变。该 lock 不引入独立 Companion、共享 AppServer Pool 或新的恢复系统。

## Verification Contract

进入 same-profile multi-Worker 生产路径前，至少需要以下合成验证：

```text
SAME_PROFILE_SINGLE_REFRESH
ONE_TIME_TOKEN_REUSE_PREVENTED
ATOMIC_PUBLISH
LOCK_CRASH_RECOVERY
NETWORK_TIMEOUT
DIFFERENT_PROFILE_PARALLELISM
LIVE_REVISION_PROPAGATION
ACCOUNT_SWITCH_ISOLATION
WORKER_CONCURRENCY
```

使用两个真实 Node 子进程和同一一次性合成 token；Provider 只能收到一次 refresh。两个 Worker
最终读取相同的新 token/revision。测试边界包括 owner crash、stale lock reclaim、refresh
failure、late response、旧写入不能覆盖新 token，以及同 profile refresh 不阻塞无关模型流。

真实 OAuth、生产账户和真实模型请求属于单独授权边界，不能伪写为 PASS。

## Consequences

该决定只增加一个短账户事务锁和进程内 revision 发布点。它保持不同 profile 的并发，不增加常驻
服务、数据库或 Task 状态机。代价是 refresh 调用持有 lock，必须正确实现 timeout 和 stale owner
回收；无法安全传播 revision 的 live Worker 必须 fail closed。
