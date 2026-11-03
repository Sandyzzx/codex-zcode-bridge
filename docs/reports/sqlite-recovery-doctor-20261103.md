# SQLite doctor 与 Task78 恢复诊断

> Status: RESEARCH
> Date: 2026-11-03
> Baseline: remote master `879568c211bac6233817acc90923e23d7861ca79`（1.4.0）
> Worktree: `D:\codex-zcode-bridge\.run\sqlite-recovery-doctor-20261103`
> Branch: `codex/sqlite-recovery-doctor-20261103`

## 已核实的问题

本地根目录 master 为 `6f0d7d3b`，不是此次修复基线。刷新远程后，隔离分支
快进至 `879568c2`。其 `plugins/codex-zcode-bridge/dist/bridge.mjs` 的 Git blob
为 `4338c776c8cbc2d050c57c2950a03a1bafa32edd`，与已安装 1.4.0 完全相同。
安装文件 SHA256 为 `b0a2cf8cbaa8734e0bab3e0a4e76dd34e2ab91e31352fe086da276ce925ea1f7`。
安装 Worker 与该基线的 Git blob 也相同：`cb84ce51d273829936a495b201f4c663ccd81abd`。

生产入口创建 SQLite Authority，但 doctor 原先创建 JSON TaskStore，再检查
`.tasks/.recovery.lock`。空 JSON 目录导致“无任务、无恢复锁”误报，并不能证明
SQLite 根健康。Host 已解析的 dataRoot 也未用于原 active_tasks 的默认根选择。

Task78 的生产 DB 已复制到项目内 `.run/evidence/production-snapshot/`，复制前后
DB/WAL/SHM 的 SHA256 一致；原数据库未打开为可写连接。切换发布 receipt 另有
副本。副本不是完整生产备份，不替代执行前的新鲜检查。

副本中 Operation `sqlite-676c38908c3289aa18a1ee323fbd73bd`：Task78、Attempt 1、
Generation 4、revision 121、phase running、Result absent。事件序号 121 于
2026-11-02 11:32:21.852（北京时间）记录 `recovery_hold / cleanup_incomplete`。
11 月 3 日三次失败均返回 `TASK_STATE / recovery_latch_persisted`。

当前源码和安装包都含 ADR-019 的 alive/unknown Worker 临时围栏；不能通过升级
删除旧 Hold。最初产生 Hold 时的完整 OS probe 返回与执行二进制身份不足，
其最初触发原因仍不确定，不据此推断当前还有相同的误锁缺陷。

## 本次修复

- Host 把同一个 SQLite Authority 的诊断回调绑定给 doctor。
- 一次只读事务包含 Task 投影、Operation、Recovery 分类与一致性结果，覆盖无
  Operation 的 queued 任务；报告当前 Manager 的恢复围栏。
- 保留 `active_tasks` 与 `recovery_lock` 的既有输出形状。读取失败或未绑定时
  unknown/error，不回退 JSON；SQLite 的历史行政结案不重新计为活动 Hold。
- 修正显式 dataRoot 的诊断优先级。未改公共 MCP schema、状态迁移、恢复权限、
  Claim/Capacity、Provider 或默认模型。

决策见 [ADR-022](../decisions/ADR-022-authority-bound-doctor.md)。

## 验证

原始日志保存在工作树 `.run/evidence/`，不能把复跑覆盖为原运行成功。

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | PASS，最终逻辑源码 |
| `npm test` | FAIL：703 项，700 pass / 1 fail / 2 skip，耗时约 19.6 分钟 |
| 原失败用例单独复测 | 1/1 PASS；原全量失败仍保留 |
| 最终 SQLite doctor + Result Recovery + admin-abandonment | 42/42 PASS |
| Manager alive/unknown 与 MCP doctor | 2/2 PASS |
| `npm run build` | PASS，最终实体依赖构建 |
| `npm run validate:plugin` | PASS |
| `npm run test:clean-entrypoints` | 4/4 PASS，含最终 Marketplace bundle |
| 真实 Task78 DB 副本诊断 | PASS：1 running / 1 occupied / 1 recovery-held；DB hash 不变 |

全量失败为 `runtime-remediation.test.ts` 的“真实 Worker 审批回复后退出”用例：
5 秒内未收到 close，断言为 `hung !== 0`。单独复测约 8 秒完成两次 Attempt。
该 JSON 用例未调用新增 SQLite doctor 路径，但最初超时的完整原因仍不确定；
未放宽测试时限，也不声称全量回归通过。全量运行期间的最后两项 formatter
调整（排除行政结案历史 Hold、使用 Map/Set）由最终 42 项专项补测覆盖，未再跑
一遍全量。因此最终源码的全量回归仍为 NOT RUN，发布验收尚未全绿。

第一次定向运行 55 pass / 1 fail：新 fixture 误用了 candidate 根守卫之外的目录；
改用受支持的 managed-data fixture 后 6/6 通过。构建曾遇到 Windows rename
EPERM、缺 worktree 本地依赖目录、依赖下载 ECONNRESET，日志均保留。最终确认
根目录与基线 lockfile 只有版本号差异后，将项目内现有依赖复制为本 worktree
实体目录，重新构建通过；无新增依赖。最终 vendor 和 Worker 的 Git 内容与基线
一致，只有 Bridge bundle 含本次行为变化。依赖连接与不完整安装保存在忽略的
`.run/` 中，没有递归删除或改写原依赖目录。

完整 Git diff 与新文件已复查；`git diff --check` 干净。没有提交、推送、PR 或
发布。原根目录 WIP 保留。候选指纹见同名目录 `validation.json`。

## Task78 生产恢复边界

本轮没有替换项目外的插件缓存，没有写生产任务数据库，没有清除 Hold，也没有
派发 LumeCAE 工作。当前 Windows boot 为 2026-11-02 17:29:06 +08:00，晚于 Hold，
但仍需执行时重新核查；Codex 当前运行，未满足 ADR-018 的 Host 全部关闭条件。

18:45 的只读身份检查确认原 Worker 世代 `exited / pid_absent`；真实 Claimant
Scan 为 clean、live_count=0。它不能代替关闭 Host 与写前重新检查。项目副本上的
原行政 CLI preflight 正确返回 `host_or_writer_still_running`，副本 DB 哈希不变。
这些是恢复前置证据，不是 Cleanup Verified 或已释放。

已准备 [task78-recovery.ps1](sqlite-recovery-doctor-20261103/task78-recovery.ps1)：
默认只执行原 CLI 的 preflight；`-Execute` 还要求精确 Confirmation。它固定绑定
Task/Operation/Attempt/Generation/revision/Claim/身份 digest；不杀进程，不创建
Result，不宣称 Cleanup Verified。若 revision 或身份变化，应停止重新审计。

生产执行需用户明确授权并关闭 Codex 和相关 Bridge/Worker；不能在本会话中
伪造 Host 已关闭。行政结案成功后 Task78 为 failed/admin_abandoned，保留历史；
重新启动 Bridge 并核查后，后续工作应创建新任务，不能 Continue 原行政结案任务。
