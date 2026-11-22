# Recovery Observation 限额移除与 Task89 启动 Hold 修复

> Status: CANDIDATE
> Date: 2026-11-22
> Baseline: `origin/preview@1bf039fda2ccfd17a992458a871bddd7b48b38c1`
> Scope: SQLite Recovery Observation、Cleanup/Cancel resolution、ADR-039 持久 Evidence 绑定

## 结论

真实阻塞根因是 Recovery 相关路径使用固定 8 条上限。`Task89` 已处于
`cleanup_unverified`、Revision 15，并持久化 8 条 `cleanup_incomplete`
Recovery Hold；基线代码第 9 次观察返回 `recovery_observation_limit`。
固定上限既不能证明当前恢复事实已变化，也无法安全表达超过 8 条的有限证据集合。

候选实现只移除这一固定条数门槛，不改变身份、进程树、interaction、CAS、
Cleanup 或 Release 合同。重复且材料事实不变的观察在 SQLite 事务内去重；
材料事实变化仍追加不可覆盖事件。超过 8 条 Hold 的 Cleanup/Cancel 消解使用
`resolved_recovery_event_count` 与 `resolved_recovery_event_root` 承诺完整事件
集合，旧 `resolved_recovery_event_digests` 数组继续可校验。

## 根因与修改

- `src/sqlite-candidate/wp6b2b1/store.mjs`：删除 Observation、Cleanup
  Reverification、Cancel Resolution、历史校验和 Cancellation History 的固定
  8 条判断。
- 稳定材料事实排除动态 `observed_at`，但包含身份状态、probe 原因、进程/树
  证据与 phase。相同事实返回既有 Event 和持久 `evidence_digest`；不同事实
  不允许被兼容去重隐藏。
- 新的 Cleanup/Cancel 消解记录使用 count/root 集合承诺，避免无限 digest 数组；
  API 仍向调用方返回完整 `resolved_recovery_event_digests`。
- `src/store/lifecycle-gate.ts` 按事件因果顺序重建已解决集合，同时接受旧数组
  与新 count/root 承诺。ADR-039 行政释放使用 Store 返回的持久 Evidence Digest，
  不再依赖可能未持久化的新鲜 evidence hash。
- `src/sqlite-candidate/wp6b2b1/schema.sql` 的
  `cleanup_reverified_binding_guard` 支持两种合法集合表示。既有 v14 的旧
  Trigger 在只读 Recovery 中按精确文本识别并继续读取；可写打开时在同一
  Authority 内精确匹配后事务升级。不提升 Schema Version、不迁移表。
- 去重只比较当前仍 active 的 Recovery 事实。已由 Cancel/Cleanup resolution
  消解的同一材料事实若再次出现，必须形成新的 active Hold，不能被旧事件吞掉。

没有新增 MCP 工具、表、依赖、后台服务、第二 Authority 或备用状态机。

## Task89 只读核验

生产数据库：

`C:\Users\Sandy\AppData\Local\CodexZCodeBridge\state\bridge.sqlite`

读取方式为 SQLite 只读句柄加 `VACUUM INTO` 隔离快照。隔离副本中的
`bridge.sqlite` 保留原 cutover receipt，所有写实验仅作用于该副本。

| 项目 | 值 |
|---|---|
| Task | `LCAE-M0-FULL-ATLAS-LIFECYCLE-20261121-89` |
| Operation | `sqlite-2657859cc8c5d09f15d3d4ed1ff99dba` |
| Phase / Revision | `cleanup_unverified` / `15` |
| Result | `failed` / `provider_config_invalid`，Result Digest 未变 |
| Recovery Holds | 8 |
| Capacity / Workspace | 占用保持 |
| 旧 Trigger 只读打开 | `consistent_read_only`，无 Blocker |
| 可写打开 Trigger 升级 | 精确旧 DDL 替换成功，`user_version=14` 不变 |

生产文件前后 SHA-256 完全一致：

- `bridge.sqlite`：`67e1ed284929cf397c49f2afc3842f226079a45eb1382a7432770a51776e4008`
- `bridge.sqlite-wal`：`168c4ecb53fa2a20750e40db9823a7b70531bb849986b594349ac1f0ac0074a9`
- `bridge.sqlite-shm`：`bb046692898d47d78c9afee9f0e76d25a5f44f482af35bfdbd25d0fa86986c24`

基线代码在另一临时 Worktree 对同一快照尝试第 9 次 observation，稳定返回
`recovery_observation_limit`。候选代码打开同一快照后：

1. 第 9 次 observation 持久化为新事件，Operation 仍为
   `cleanup_unverified`，Revision 从 15 变为 16，Capacity/Workspace 继续占用。
2. 再以相同材料事实和不同 `observed_at` 重复观察时返回 durable duplicate，
   Revision 不再增长。
3. 未执行生产 Task89 cancel、Recovery、行政释放或数据库写入。

证据副本位于本次 Worktree 的忽略目录 `.run/evidence/`：

- `task89-baseline-ninth.json`
- `task89-candidate-final.json`
- `task89-baseline-probe.mjs`
- `task89-candidate-probe.mjs`
- `task89-isolated-probe-final/`

这些文件不属于提交物；仓库报告保留可复核摘要与命令。

## 验证

已通过：

| Gate | 结果 |
|---|---|
| Typecheck | PASS |
| `result-recovery.test.mjs` | 38 / 38 PASS |
| `cleanup-release.test.mjs` | 27 / 27 PASS |
| Formal MCP Recovery / ADR-039 定向组合 | 10 / 10 PASS |
| SQLite Worker/History/Admission resource stress | 4 / 4 PASS |
| Full Regression (`npm run test:full`) | 990 tests / 988 PASS / 2 SKIP / 0 FAIL |
| 超过 8 条 Cleanup Hold 的 Reverification / Release | PASS |
| 超过 8 条 Cancel Hold 的 Resolution / Result / Reopen | PASS |
| 旧 v14 material-free Hold 重开与消解 | PASS |
| legacy Hold 材料事实变化不得误去重 | PASS |
| 已消解材料事实再次出现时必须形成新 active Hold | PASS |
| 旧 v14 Trigger 只读兼容 + 可写精确升级 | PASS |
| 8 条 material Hold 后 20 次新鲜重复观察 | 28 次 verifier 均执行；Event 保持 8 条、Revision 不变、占用保留 |
| 已消解 Hold 的原始 envelope 陈旧重放 | `stale_recovery_cas`，Operation、Revision、Event 与占用均不变 |

`npm run test:full` 同时完成 Typecheck、Build、隔离完整回归和 Plugin Validator；
完整回归耗时 `1,352,987 ms`。最终 `npm run test:stress` 为 4 / 4 PASS，
耗时 `19,512 ms`。Generated Artifacts 需要在提交后由 clean committed tree
验证；远程 Windows/Ubuntu CI 在推送后记录，未运行项不能记为 PASS。

独立审查先发现并复现一个 P1：已消解 Hold 的原始 envelope 陈旧重放会在
Revision CAS 之前被误报为 durable duplicate。修复后 exact-envelope、材料事实
与同 Revision 冲突检测都只检查当前 active Recovery；陈旧 envelope 落到现有
CAS 并返回 `stale_recovery_cas`。审查者复核修复与新增回归后确认 P1 已解决，
未发现新的 P0/P1/P2；本地生产 SQLite、付费模型和候选文件均未被审查者修改。

## 风险与边界

- 固定 8 条移除不等于自动恢复。所有身份、树、Adapter resource、interaction、
  Revision/CAS 与 Cleanup/Release 门槛保持。
- 集合 root 只证明已处理事件集合的完整性；它不把行政释放改写为
  `cleanup_verified`，也不替代原 Result、Event 或 Cleanup Evidence。
- 旧 Trigger 升级是精确 DDL 替换；非精确旧形态继续 fail closed。无 Schema
  Version 提升，也没有自动数据迁移。
- Task89 的当前 snapshot 只证明启动与 Recovery 事实可继续处理；真实生产
  Task89 是否取消仍由用户显式 `zcode_cancel` 决定。

## 回滚

代码回滚可移除本候选的独立 Commit。SQLite 数据无需迁移；如果候选曾写新的
count/root 消解事件，回滚后的旧代码不会识别该新表示，必须保持该数据库由回滚前
版本只读诊断或按后续批准的恢复方案处理。不得删除 Event、Hold、Result 或
Capacity/Workspace 占用来规避回滚失败。
