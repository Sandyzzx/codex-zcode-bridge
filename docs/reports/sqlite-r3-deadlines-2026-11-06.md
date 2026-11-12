# R3 执行与清理期限验收

> Status: RESEARCH
> Date: 2026-11-06
> Verified against: 4fc3d91731da38cc022afe80e474e510a70735ac（生产实现；本地候选）
> Acceptance: PASS — 隔离 Windows R3 合同验证；等待 Owner 审核，不代表生产迁移或发布。

## 核验与结论

R3 已在最终代码 4fc3d91 完成验收：完整 Windows 门禁退出 0，1000 项中 998 通过、0 失败、2 个既有跳过；最终 8 个最大 Result 并发全部 Result committed / released。R2 Host 读取限制按 Owner 决定延后，不阻塞本轮期限治理。

原 D3 的期限衔接问题成立：R2 基线 904f457 的 Manager 将 Result 等待封顶为 1h+30s，忽略环境默认；Adapter 能接受 4h。Adapter 成功路径的执行计时器继续覆盖清理，Manager 还在 Result 提交前等 Worker close，并无限 await interaction pump。Claim 后执行 envelope 的 fd5 写入同样可能被真实管道背压阻塞。

本轮修复这些衔接问题，保留永久 Claim、身份绑定 Windows 树清理、CAS、单 SQLite Authority，以及 Result/Cleanup/Release 的独立事实。成功和失败清理合并为一条路径，没有新增持久状态、公开配置、依赖或 MCP 工具。32 MiB Result、Worker Result envelope 的 256 KiB 额外余量和 v14 Schema/Store 未改。

## 最终期限合同

| 阶段 | 所有者/期限 | 到期语义 |
|---|---|---|
| 每次执行有效时限 | Manager 一次解析 Task override > Host 持久化/环境默认 > 1h；60s–4h | 私有 Task 副本传给 Worker/Adapter；持久公开 Task 不改 |
| Claim 后执行 envelope 发送 | Manager，15s；原 1,100,000-byte 输入上限不变 | private_execution_delivery_timeout；保留 Claim/Workspace，不推断未执行 |
| resolver、启动、turn | Adapter，使用上述时限 | failed/timeout；取消走原语义；终结/错误后撤销执行 timer |
| Browser/app-server 清理及必要 claimant scan | Adapter，独立 300s 总预算 | 发布 cleanup unverified；迟到完成不能升级已发布 snapshot 或自动 Release |
| 完整 Result 帧等待 | Manager，execution + 300s + 30s | private_report_timeout，保留 running、诊断与占用；活 Manager 保留原 Worker 句柄至实际 close |
| 提交后 close 与 interaction drain | Manager，共用 15s | Result 保留，Cleanup 独立判定，不无限 await pump |
| 精确 Worker 身份验证 | 现有 Manager 探针，5s | unknown 不等于 exited，缺树 proof 不释放 |
| 显式 Host shutdown | 现有独立 60s 等待 | 活跃任务不能证明 Release 时显式失败，不复用为执行时限 |

Result 通过完整帧、绑定和语义校验后先落库，再等待 Worker close。Worker 非零、未知或迟到退出不再导致合法 Result 丢失；这些事实仍可阻止 Cleanup/Release。退出不等于树已清理。

已提交 completed/failed/cancelled/waiting_for_master Result 的 cleanup_unverified Operation 可以通过原 zcode_cancel 做仅清理恢复。保留精确原身份、树扫描、未决交互及 CAS 门，不创建 Attempt、不重放任务、不改写 Result。已 released 的重复请求只读。无 Result 的重启恢复继续属于 R5，R3 不自动接管、终结或重派。

300s 是一次清理的总预算，容纳现有 120s Windows helper 会话、必要 fallback scan 和 browser close；没有放宽底层身份或 helper 限制。执行 timer 与 cleanup timer 分工，不叠加第二个执行 watchdog。JS timer 是协作式期限，不承诺 OS 硬实时。

## 验证

实际环境：Windows 11 Home 10.0.26100 x64，Node v24.16.0。所有数据根、Host settings 和运行时均为项目内隔离 fixture。

| 运行 | 结果 | 耗时 |
|---|---|---|
| test:affected -- --base HEAD --dry-run | T0 typecheck/build/plugin validation/diff-check 通过；DRY_RUN_ONLY，不算选择出的套件 PASS | 未单独记录整体 wall time |
| 三文件专项：task-timeout、zcode-app-server-adapter、mvp-real-adapter | 44 pass / 0 fail / 0 skip | 217.820s |
| 初次 8 × 32 MiB 探针 @ a684850 | 8 Claim、8 Result committed/released；每项 Spawn=1 | 107.734s |
| 最终 8 × 32 MiB 探针 @ 4fc3d91 | 8 Claim、8 Result committed/released；每项 Spawn=1 | 145.538s |
| 首次 npm run test:full @ a684850 | 997 项：991 pass / 4 fail / 2 既有 skip；三类失败已修复，不能称该运行通过 | wall 2,228.592s；Node test 2,199.174s |
| 修正后反例：ENOENT 单例 | 1 pass / 0 fail | 0.954s |
| 修正后 Claim/ACK/清理恢复/选择器回归 | 26 pass / 0 fail / 0 skip | 9.617s |
| 最终 npm run test:full @ 4fc3d91 | 1000 项：998 pass / 0 fail / 2 既有 skip；含 typecheck/build/plugin validation，命令退出 0 | wall 2,313.612s；Node test 2,268.312s |
| 最终文档 test:affected -- --base HEAD | T0 通过；NO_TESTS_APPLICABLE，不计为测试 PASS | 未单独记录整体 wall time |

专项覆盖：

- 真实 Worker 接收 90s 环境默认和 4h 显式值，Manager 等待为相同有效值 + 330s。
- 受控 Date/setTimeout 越过旧 1h+30s 边界，4h−1ms 不结束，4h 时 resolver 阻塞也能结束；不是四小时真实墙钟执行。
- 真实 Worker/Adapter 执行超时（fixture 将内部预算缩为 5s）持久化 failed/timeout，只有真实 Windows cleanup proof 才 Release。
- 真实 Windows 终止延迟 5.2s 时，已成功 turn 的 5s 执行计时器不会在清理中触发。
- 100ms 内部 cleanup seam 超时发布 unverified；随后真实终止完成也不增加 verified checkpoint；Manager 保持占用，显式 cancel 仅恢复清理。
- Result 已交付但 Worker 延迟退出：completed Result 先落库，cleanup_unverified；关闭/重建 Manager 后显式 cancel 可清理，Result 保持不变、重复 cancel 无新 Attempt。
- Manager Result 等待超时后，仍能通过保留句柄做身份绑定取消、持久化 cancelled 并验证 Release。
- 实际 Worker 不读取 fd5，合法 1,000,000-byte context 使真实 Windows pipe 阻塞；15s 后出现可读持久诊断，仍能显式取消原 Worker。
- 现有正常完成、用户取消、Provider 失败及 root-exited claimant scan 拒绝/保留后代用例均在专项内；R2 Unicode、精确 32 MiB、+1/schema failure、known rollback/COMMIT ACK 不确定也通过。

并发探针：最终代码 Manager max RSS 1,477,708 KiB（约 1.41 GiB）；各进程高水位之和 2,929,260 KiB（约 2.79 GiB，不是同时采样的整机峰值）；DB 302,571,520 bytes，WAL 35,530,912 bytes。使用显式 test fake Adapter，但 Spawner、Worker、管道、Manager、SQLite 和 Release 为生产链；不是 Provider 并发性能认证，也未执行 Host 大 Result 接收验收。

完整命令、每个用例及耗时日志在本 Worktree `.run/evidence/`：`r3-targeted-delivery.log`、`r3-eight-max-results-final.log`、`r3-windows-full-final.log`。自动文件清单为 `r3-automatic-test-files.json`，冻结文件 Git hash 为 `r3-frozen-code.json`。不新增 SKIP，不放宽断言，不提高原测试预算。最终 B3-05 已通过（554.181s），32 active / 10,000 historical 的 setup 472.271s、status p95 3.61ms；这是原有 JSON TaskStore 压力门，不将其称为 SQLite 规模基准。

首次全量发现并修复三类问题，未修改这些既有测试的断言：①共享清理误把已证明未建立 app-server 子进程的 ENOENT 分类为 cleanup_failed，现复用原 spawnFailure 事实并要求没有分配 PID；它不推断外层 Worker 未 Spawn。②先提交 Result 后，ACK 不确定分支遗漏 Worker 的有界退出观察/worker_close 诊断，现保留观察但不推进 Cleanup/Release。③Authority 的新增 snapshot.result 真值判断重复 Driver 的持久 Result 绑定验证，现删除该重复门槛，精确身份/树扫描/CAS 未改。

共享 task-timeout.ts 现同时属于 Adapter 和 SQLite 影响域；选择器断言验证单文件期限修改会选择三类生产链测试及现行压力门禁。映射修改前后自动执行文件集均为 90 个，没有新增手工 E2E 或 Fixture。

完整 1000 项用例及逐项耗时见任务私有归档 `r3-windows-full-final-cases.json`，每一条均来自实际 Node 报告；`r3-validation-runs.json` 保留了开发反例、失败运行和修正后运行。这两个证据文件不属于 Git tree，本报告仅保留其文件名和结论。两项既有跳过分别为 Windows 下的 POSIX mode-bit 检查、原已跳过的 injected ENOTEMPTY fixture case，未新增跳过。

## 变更与兼容

生产修改仅五处：`src/runtime/task-timeout.ts`（共享阶段预算）、`src/adapters/zcode-app-server-adapter.ts`（执行 timer 结束点/共享清理）、`src/worker/worker-main.ts`（时限快照/错误清理证据）、`src/store/lifecycle-gate.ts`（交付和收尾有界、先提交 Result、句柄保留）、`src/manager/sqlite-lifecycle-mcp-authority.ts`（已有终态 Result 的仅清理入口）。两份生产 bundle 同步。测试修改为原三份 R3 用例文件、test-impact-map.json 与现有选择器测试；没有退役测试。

ADR-027 与三份相关合同同步。`INTERFACES.md` 在 904f457 中已有冲突标记，本轮修复页头；不把历史全文件验证冒充 R3 重新认证。ADR-026 的索引由“待批准”纠正为 Owner 已批准。

没有数据库迁移或 SQLite schema/data 格式变化，没有清理历史 JSON API/测试，没有生产数据库操作、未知 Hold 操作或远程动作。回滚使用代码/bundle 回退即可；不删除现有 evidence/Claim/占用，不把旧活跃 Worker 重派。回退到旧实现会恢复原期限缺陷，旧运行中 Worker 不受本次代码热更新。

## 剩余边界

- Manager 崩溃且没有完整提交 Result 的一般结案仍未完成，保守保持 running/占用，归 R5；不是本轮新增恢复承诺。
- Cleanup 预算耗尽后底层有界 helper 可能仍在结束；R3 冻结已发布的 unverified 事实，后续必须用新鲜证据恢复。
- 8 个最大 Result 的内存成本仍高，本轮没有降低容量、截断或引入 Chunk API。Host 接收限制按 Owner 决定延后。
- 既有执行 envelope 的 1,100,000-byte 上限包含 continuation.previous_result（lifecycle-gate.ts 的 sendDecision/previous_result 赋值处）。独立序列化验证得到合法 canonical Result 1,100,249 bytes，而最小 Decision 已达 1,100,348 bytes，超过原输入 cap；真实 envelope 还包含 Task/身份配置。这是 STATIC_SERIALIZATION_EVIDENCE，不是实际 Continue/Host E2E；大 Result 续作仍可能被拒，需另行裁决，该 cap 作用于 Manager→Worker 的续作输入，Host 接收限制作用于 MCP 响应；本轮不扩大输入上限或增加 Chunk API。证据：r3-existing-continuation-cap.json。
- 真实 Provider/模型长时运行和四小时墙钟运行未运行；Ubuntu 本轮未运行，不作跨平台认证。
- R4–R7 未实施。下一步建议先由 Owner 审核本轮，并单独裁决大 Result 的续作输入上限；随后按原计划处理 R4 可证明未 Spawn 的 Launch 失败；不要用 R3 超时作为自动重派依据。

## Git

主 Worktree `D:\codex-zcode-bridge` 仍为 master aabbb0a；已有 `.gitignore` WIP 未改。

本轮 Worktree：`D:\codex-zcode-bridge\.run\r3-deadlines-20261106`，branch `codex/r3-deadlines-20261106`，基于 904f457。初始实现提交 a684850ed0b981319f2623ae9eaba12fd94875e5；修正与影响映射提交 4fc3d91731da38cc022afe80e474e510a70735ac，最终生产代码 Tree 803426f04cc08eefdfe472081904067ef46f2598。包含文档的最终 HEAD/Tree 与工作区状态见 `.run/evidence/r3-final-git-state.json`（文档提交后采集）及交付摘要。

环境记录例外：前半段部分 npm 命令使用默认用户缓存生成了调试日志，后续 npm 调用通过本 Worktree 的临时 .npmrc 重定向到项目内；未清理用户缓存。项目外没有数据库实验或验收产物。临时 .npmrc 已按原内容核对后删除，后续 npm 命令显式指定项目内缓存和日志。
