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
| `npm run typecheck` | PASS（A 线代码） |
| `npm run build:test` | PASS |
| `test/executor-recovery.test.ts` | PASS（12/12） |
| `sqlite-candidate/wp6c/executor-wake.test.mjs` | PASS（7/7） |
| `test/mcp-stdio-entry.test.ts` | PASS（6/6） |
| A 线定向集合（Recovery/Wake/Lease/IPC/Thin MCP/Executor 进程） | PASS（60/60） |
| 真实进程恢复定向用例 | PASS |
| Preview.17 完整回归 / Windows / Ubuntu CI | NOT_RUN（集成阶段） |
| Windows 重启 / Desktop fully exited / notLoaded / 严格 Wake C/D | NOT_RUN |

本报告不把定向测试或合成 Executor 结果提升为 Preview.17 最终验收。
