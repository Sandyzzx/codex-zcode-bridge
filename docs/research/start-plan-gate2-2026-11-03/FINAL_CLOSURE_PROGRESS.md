# Gate 2 Final Closure — 进行中

> Status: RESEARCH
> Baseline: 67dd8c67275c4afeb81dd9795ee03e258083c54d
> Scope: Windows Node 24.16.0，隔离合成凭据，无真实 Provider 请求。

## 继承管道诊断

`pipe-diagnose.mjs` 使用单调时钟记录 spawn、PID、pipe 读取、进程退出、stderr 和 PowerShell 创建时间探测。原 worker 在 ready 写入之前先构造 `new Socket({fd:3})`，诊断于 10 秒时只有 spawn 信息，未收到 ready；随后由诊断超时终止，exit signal SIGTERM。原测试等待 ready 直到 worker 计时器退出后才尝试 probe，因此报 PID 不存在；PID 不存在本身不是 PID 复用或权限拒绝的证据。

`pipe-min-parent.mjs` / `pipe-min-child.mjs` 使用 `writeSync/readSync` 在真实 Node 子进程的 FD3 做双向本地测试：约 69ms 收到 ready、70ms child 读取 ACK、78ms exit code 0。把 `worker.mjs` 的 ready 写入移动到 Socket 构造前后，诊断约 69ms 收到 ready、480ms 得到 OS 创建时间、exit 0。此证据支持问题位于原 POC 的启动/管道流初始化顺序；不能证明 Node 内部 Socket 构造的具体阻塞机制。

离线 `node --test .../lease.test.mjs` 在修正后 22/22 PASS，其中真实子进程 PID/创建时间检查与一次合成凭据交付通过。该测试使用 PID 创建时间快照；并未证明进程句柄持有、生产 ChildProcess/Claim 绑定或 PID 检查至写入期间的全部竞态。

## 未关闭的 P0

- 原生 AppServer 的 runtime-header / turn.started 的真实先后顺序尚无本轮观测；历史事件只证明 send accepted 先于 turn.started，不能推断 header 顺序。没有伪造 Turn。
- 现有 POC 仍未完成严格单帧 UTF-8、超限、ACK 丢失、写入中取消、Parent EOF、Worker exit 与跨 Worker 重放端到端验证。写入后取消不能收回已交付数据。
- 实时权益仍是合成 adapter；设备身份 NOT VERIFIED。
- 本轮尚无独立 Reviewer 对修改后结果的审查。

因此 IPC_PROTOCOL、RUNTIME_AUTH_TURN_ORDER、CANCELLATION_AND_CRASH、SECRET_ISOLATION 和 INDEPENDENT_REVIEW 均不能标记 PASS；Gate 2 仍为 PARTIAL。无真实 OAuth、Billing、模型请求或生产数据库变更。
