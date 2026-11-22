# Preview 2.0.0-preview.12 Release

> Status: RESEARCH
> Date: 2026-11-22
> Preview base: `f51e965ebe38e85b3b8d3dea1396384aa634d2d4`
> Source PR: #121
> Release PR: #125

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

- Release PR #125 final required CI attempt 2：`44997987353`。Windows 两 shard、
  Ubuntu Verify、Cost Lab、两平台 SQLite resource matrix 和聚合 Windows Verify
  PASS。首轮 Windows shard 1 在 `ADR-031 Gate E1` 的 75 秒清理等待边界超时；
  失败 job 重跑通过。首轮失败日志保留在本地 `.run`，根因未独立证明，
  不据此宣称修复。
- 合并后 Preview push CI attempt 2：`44999535808`。Cost Lab、Ubuntu Verify、
  Windows 两 shard、两平台 SQLite resource matrix 和聚合 Windows Verify PASS。
  首轮 Windows shard 2 在 `ADR-024 six lifecycle crash boundaries` 的测试
  fixture 清理阶段报 Windows `EPERM`；失败 job 重跑通过。该现象未在本地完整
  回归复现，根因未独立证明。
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
- 本地 `npm run test:full`：990 tests，988 PASS，0 FAIL，2 SKIP；typecheck、
  build、plugin validation PASS。
- 本地 `npm run test:stress`：4/4 PASS；`npm run cost-lab:test`：86/86 PASS；
  `npm run check:generated`：10 个 tracked artifact fresh；`git diff --check` PASS。
- Release ZIP 从 Tag 的插件子树构建。首次直接 archive 插件 subtree 时遗漏
  仓库根 `.gitattributes`，导出的 `schema.sql` 为 CRLF，导致隔离 bootstrap
  报 Recovery compatibility marker 缺失；改为从仓库根 `git archive` 后重新
  验证并通过。
- 重新下载的 Release ZIP SHA-256 为
  `a8e27e90946a0d8eb15b5e868b4839295fe39d445b87a9f0dac5d7c93554949c`；
  manifest 与 MCP server version 均为 `2.0.0-preview.12`，13 个工具，
  隔离 SQLite `user_version=14`、`integrity_check=ok`，未知 task 返回
  `TASK_NOT_FOUND`。

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
RELEASE_COMMIT: 224b8e1c45040776ccd8eae01a5191fa8a830fb2
RELEASE_TREE: 8452b0651e7adf461848c20ac8f54c22d3e4fd90
TAG: codex-zcode-bridge-preview-v2.0.0-preview.12
RELEASE_URL: https://github.com/Sandyzzx/codex-zcode-bridge/releases/tag/codex-zcode-bridge-preview-v2.0.0-preview.12
ZIP_SHA256: a8e27e90946a0d8eb15b5e868b4839295fe39d445b87a9f0dac5d7c93554949c
```

## Repository Boundary

根工作区的未跟踪 `$null`、`stable`、Preview.11 实测报告和既有用户 WIP 未修改。
发布产物从 Tag 指向的提交独立生成，不使用生产 SQLite、用户工作区或真实模型请求。
