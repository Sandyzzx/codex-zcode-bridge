# Preview.17 A 线实现报告：Executor Recovery + Continue

> Status: RESEARCH（候选实现与验证记录）
> Date: 2026-11-25
> Worktree: `.run/preview17-a-executor-recovery-20261125`
> Branch: `codex/preview17-a-executor-recovery-20261125`
> Baseline: `origin/preview` `6af69b55d7ecb660c2ad2c923888cf7f1e8886c8`

## P0-A Executor Crash Recovery

实现：

- 新增 `src/executor/recovery.ts`：单个 Host 请求触发、既有 Lease 探测、
  精确 Owner 核对、只读 Worker Safety、旧 Lease 归档、共享 Spawn 与健康
  检查。
- 新增 `src/executor/spawn.ts`：Task CLI 与自动恢复共用 Executor 进程入口
  解析和 detached Spawn。
- Thin MCP 注入恢复回调；默认开启，显式
  `ZCODE_BRIDGE_EXECUTOR_AUTO_RECOVER=0|false|off` 仅关闭自动启动。
- 恢复锁使用 Host 设置目录，不写入 SQLite Authority 根。
- 现有 SQLite v14、Task/Attempt/Operation/Result/Event 与历史 Lease 归档
  全部保留。

故障注入与真实进程：

- 同进程并发请求：1 次 Spawn。
- 两个独立 Node 进程共享 root：真实跨进程锁串行，1 次 Spawn。
- PID 被复用（精确身份不匹配）：仅在旧 Owner 证明退出后归档。
- Owner 探测 unknown：Fail Closed，不归档、不 Spawn。
- 归档 rename 后崩溃/结果未知：本次 Fail Closed；下一请求重新核对并恢复。
- Worker 存活或身份 unknown：保留 Lease，不 Spawn。
- `launch_intent` 无 Receipt：Fail Closed。
- SQLite Authority 打开时只读 Worker Safety：一致快照，不改变 phase。
- 真实 Executor 正常退出：重新启动并复用 Authority。
- 真实 Executor `SIGKILL`：归档旧 Lease、启动新 Executor、同一 Thin MCP
  会话后续读取成功。
- Windows 真实 production Worker：使用真实 SQLite v14、真实 Executor
  Lease/Control 进程和 production `worker-main.js` 完成 provenance、
  bootstrap、launch receipt、permanent claim 与 identity handshake，随后在
  私有 interaction bind 处保持存活；此时 `SIGKILL` Executor，由真实 Thin
  MCP 的 `zcode_status` 触发自动恢复。恢复以
  `EXECUTOR_RECOVERY_WORKER_ACTIVE` 拒绝，blocker 为
  `worker_still_alive:task-production-worker/1`。
- 上述真实 Worker 场景同时核对：Worker PID 仍存活；Lease 字节未变；没有
  新的 Executor control endpoint；没有 `EXECUTOR_START_RECOVERED`；恢复锁
  不存在；Spawn 日志仍只有一个 Worker PID；SQLite Operation/Event 未变。
  Worker 退出后 Worker Safety 才转为 safe。
- 该场景中的 Worker 是 claim-only，并在私有 interaction bind 处等待，尚未
  进入模型或 Adapter 执行；因此它证明的是“真实 Worker 存活时不得双
  Spawn/覆盖 Lease”，不是生产模型执行 E2E。

最终测试修正只增加真实进程证据与测试域映射，没有保留或新增供 fixture
绕过的 production 兼容分支。未发现根恢复顺序存在双 Spawn 缺陷；此前缺口
是证据层级不足，而不是已确认的功能缺陷。

## P0-B Continue Release 事实

修复：

- `IsolatedAdmissionStore.createNextAttempt` 与 continuation history 校验
  从“revision 必须等于 `released` Event sequence”改为“在
  `sequence <= expected_revision` 内存在 `released` Event”。
- CAS revision、generation、Claim、Worker identity、Result 与 Cleanup 校验
  不变。

真实 Store 回归：

- `intent → queued → turn_started` 三次 Wake 后 revision 前进，Manager
  传入当前 revision，Continue 创建 Attempt 2 成功。
- 原 Attempt、Result Digest、Cleanup/Release 与 3 条 Wake Event 保留。
- 未 Release、Cleanup 未验证、活动 Worker/Workspace、Task ID 冲突等既有
  拒绝路径不改。

## 验证状态

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | PASS（最终工作树） |
| `npm run build` / `npm run build:test` / `npm run check:generated` | PASS（生成物 14 项最新） |
| `test/executor-recovery.test.ts` | PASS（13/13，含 Windows 真实 production Worker） |
| Lease/IPC/Spawn Fence | PASS（30/30） |
| `test/mcp-stdio-entry.test.ts` | PASS（6/6） |
| `sqlite-candidate/wp6c/executor-wake.test.mjs` | PASS（7/7） |
| `test/executor-process.test.ts` | PASS（12/12） |
| A 线定向集合（Recovery/Wake/Lease/IPC/Thin MCP/Executor 进程） | PASS（68/68） |
| `npm run test:affected -- --development` | PASS（214 项：213 pass、1 Node-version skip、0 fail；`FULL_SUITE_DEFERRED_TO_RELEASE_GATE`） |
| 受影响门禁选择原因 | `FULL_SUITE`：`test/test-impact-map.json` 与 3 个测试 fixture 属于未登记测试基础设施 |
| 生产模型/Adapter 执行 | NOT_RUN（真实 Worker 在 bind 前被阻断） |
| Ubuntu production claim-only handshake | NOT_RUN |
| Preview.17 完整 Release Gate / GitHub Windows / Ubuntu CI | NOT_RUN（集成阶段） |
| Windows 重启 / Desktop fully exited / notLoaded / 严格 Wake C/D | NOT_RUN |

本报告不把定向测试或合成 Executor 结果提升为 Preview.17 最终验收。
`npm run test:affected` 是开发期受影响/延期门禁，其上述结果不是完整 CI
PASS；完整 Windows/Ubuntu 矩阵仍需在集成或发布候选阶段执行。
