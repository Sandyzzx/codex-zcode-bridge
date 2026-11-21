# Preview 2.0.0-preview.11 Release

> Status: RESEARCH
> Date: 2026-11-22
> Preview base: `f549373404ac137600e89991b99114a4802133f2`
> Integration PR: #117

## Release Scope

Preview.11 在 Preview.10 的 SQLite v14-only 基线上发布以下已验证变更：

- `zcode_result({ task_id })` 继续默认返回完整 Result；`view="summary"` 作为显式
  opt-in 提供有界投影，并保留 `expected_attempt` 归属保护。
- `zcode_events` 默认使用有界 Event 页，保留 `has_more`/`next_seq` 分页和显式
  Attempt 归属字段。
- Master Skill 优先引用工作区已有证据，避免重复转述大型源码、Diff 和日志。
- 用户重复调用既有 `zcode_cancel({ task_id })` 时，仅对符合既有资格合同的历史
  `launch_intent`/`cleanup_unverified` 阻塞执行 SQLite CAS 行政释放；不伪造
  `cleanup_verified`，不释放活动 Worker、live descendant 或终止失败现场。
- `zcode_status`、Doctor 与 `zcode_cancel` 返回阻塞 Task、Operation、phase、
  Workspace 与阻塞时长；Spawn 前继续重读权威状态。

## Verification

- PR #117 的合并前 CI：`44937622999`，Ubuntu、Windows 两 shard、Windows aggregate
  和两平台 SQLite matrix PASS；PR 的托管 Cost Lab job 因 impact selector skipped。
- PR #117 合并后 Preview push CI：`44938418623`，Cost Lab、Ubuntu、Windows 两 shard、
  Windows aggregate 和两平台 SQLite matrix 全部 PASS。
- 本发布候选的版本一致性、生成物、typecheck、build、plugin validation、完整回归和
  发布 Tag/资产验证在 release workflow 完成后记录。

## Known Limits

- 真实完整任务计费 A/B 仍为 `INSUFFICIENT_EVIDENCE`；受支持 Runtime、请求级 Usage、
  账户/账单隔离、受控缓存序列和派发前硬预算尚未同时满足，付费试点保持 `BLOCKED`，
  本轮 Provider 请求和新增支出为 0。
- 安装版 Codex Host 的 MCP 单行上限为 16,777,216 bytes；SQLite 保留原始证据，但
  超过该上限的 MCP-only 完整回读仍不受支持。
- 历史 Start Plan 核心功能路径为 PASS，历史完整 E2E 仍为
  `FAIL — WORKSPACE BOUNDARY`；本轮不发起新的真实 Start Plan 请求。
- `zcode_result` 的静态 output schema 现在允许完整 Result 或 projection，
  `dispatch_blocker` 是可选加性字段；精确 Schema 哈希消费者必须刷新。

## Release Identity

```text
PREVIEW_VERSION: 2.0.0-preview.11
PREVIEW_CODE_HEAD: f549373404ac137600e89991b99114a4802133f2
RELEASE_COMMIT: PENDING
RELEASE_TREE: PENDING
TAG: codex-zcode-bridge-preview-v2.0.0-preview.11
RELEASE_URL: PENDING
ZIP_SHA256: PENDING
```

## Repository Boundary

根工作区的未跟踪 `$null`、`stable` 和既有用户 WIP 未修改。发布产物从 Tag 指向的
提交独立生成，不使用生产 SQLite 或用户工作区。
