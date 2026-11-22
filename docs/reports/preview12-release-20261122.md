# Preview 2.0.0-preview.12 Release

> Status: RESEARCH
> Date: 2026-11-22
> Preview base: `f51e965ebe38e85b3b8d3dea1396384aa634d2d4`
> Integration PR: #121

## Release Scope

Preview.12 在 Preview.11 的 Result、Event、用户授权释放和 SQLite v14 合同上发布：

- 删除 `RECOVERY_LIMIT = 8` 及 Observation、Cleanup Reverification、Cancel
  Resolution、Cancellation History 和历史校验中的固定次数门禁。
- 当前 active Recovery 的重复材料事实不再因 `observed_at`、Bridge 重启或同一
  manager probe 结论追加 Event；每次恢复检查仍执行当前身份与进程树探测。
- 材料事实变化仍追加不可覆盖 Evidence；已消解事实再次出现时形成新的 active
  Hold，不能被历史事件误去重。
- 超过 8 条 Cleanup/Cancel Hold 的消解使用完整事件集合的
  `resolved_recovery_event_count` 与 `resolved_recovery_event_root`；旧 digest
  数组继续可校验。
- 既有 v14 的精确旧 Cleanup Trigger 可由只读 Recovery 读取，并在可写打开时
  事务内精确升级；`user_version` 保持 14，不迁移表或历史行。
- ADR-039 行政释放绑定 Store 返回的持久 Recovery Evidence Digest，不伪造
  `cleanup_verified`，活动 Worker、live descendant、终止失败和不完整证据继续
  保持占用。

本版本没有新增 MCP 工具、公共 Schema、依赖、后台服务、第二 SQLite Authority
或 Recovery 状态机。

## Verification

- Integration PR #121 CI：`44978344205`。Fast PR gate、Integration gate
  (Windows)、Ubuntu/Windows Verify、Windows 两 shard 和两平台 SQLite resource
  matrix PASS；Cost Lab 按 impact selector skipped。
- 合并后 Preview push CI：`44979711057`。Cost Lab、Ubuntu/Windows Verify、
  Windows 两 shard 和两平台 SQLite resource matrix PASS；PR-only gates
  按 push 事件跳过。
- 独立审查曾发现并修复一个 P1：已消解 Hold 的旧 envelope 重放被误报为
  duplicate。修复后返回 `stale_recovery_cas`，Operation、Revision、Event 与
  占用不变；复审无新增 P0/P1/P2。
- 完整回归：990 tests，988 PASS，0 FAIL，2 SKIP；Stress：4/4 PASS。
- 定向回归：`result-recovery` 38/38、`cleanup-release` 27/27、Formal MCP
  Recovery / ADR-039 组合 10/10。
- 8 条 material Hold 后执行 20 次新鲜重复探测：28 次 verifier 均执行，
  Event 保持 8 条、Revision 不变、占用保留。
- 隔离 Task89 快照：基线第 9 次观察返回 `recovery_observation_limit`；候选
  第 9 次成功并保持 `cleanup_unverified`，Revision 15 → 16；后续相同材料
  事实返回 durable duplicate，Revision 保持 16。
- 生产 SQLite、WAL、SHM 在证据运行前后 SHA-256 一致；生产 Task89 未取消、
  未写数据库、未执行 Recovery 或行政释放。

## Known Limits

- 生产 Bridge 尚未在本发布流程中重启并读取 Task89；隔离快照证明代码可继续
  处理历史 8 条 Hold，不等于生产 Task89 已恢复或已取消。
- 真实 Task89 的行政释放仍需 Owner 显式调用现有
  `zcode_cancel({ task_id })`；不得由发布流程自动执行。
- 新的 count/root 消解表示不能被回滚前的旧二进制识别。若数据库已写入该表示，
  回滚必须先保留 Event 与 Result，并使用支持该表示的版本只读诊断。
- 真实完整任务计费 A/B 仍为 `INSUFFICIENT_EVIDENCE`；受支持 Runtime、
  请求级 Usage、账户/账单隔离与派发前硬预算未同时满足，付费试点保持
  `BLOCKED`，本轮 Provider 请求和新增支出为 0。

## Release Identity

```text
PREVIEW_VERSION: 2.0.0-preview.12
PREVIEW_CODE_HEAD: f51e965ebe38e85b3b8d3dea1396384aa634d2d4
RELEASE_COMMIT: PENDING
RELEASE_TREE: PENDING
TAG: codex-zcode-bridge-preview-v2.0.0-preview.12
RELEASE_URL: PENDING
ZIP_SHA256: PENDING
```

## Repository Boundary

根工作区的未跟踪 `$null`、`stable`、Preview.11 实测报告和既有用户 WIP 未修改。
发布产物从 Tag 指向的提交独立生成，不使用生产 SQLite、用户工作区或真实模型请求。
