# Start Plan Gate 2 验证状态

> Status: RESEARCH
> Baseline: 67dd8c67275c4afeb81dd9795ee03e258083c54d
> Last updated: 2026-11-03

当前为候选，不批准生产集成；架构冻结为原生 Runtime Auth + 专用继承管道（FD10-13）。证据明细和日志路径见 [GOAL_EVIDENCE_INDEX.md](GOAL_EVIDENCE_INDEX.md)。

- 原生 AppServer 本地回环观测：Session 创建、模型选择、发送、turn.started、Runtime Header、turn.completed 顺序已观测；非真实 Provider。
- 生产 SQLite Worker 经专用继承管道消费合成凭据，竞争同一租约只有一个 Worker 消费；定向组合 48/48 通过。
- Runtime Header 写入前增加缓存引用、父链路、取消和过期的同步检查；受控撤销测试通过。跨进程撤销尚未送达之前和已写出的凭据不可保证撤回。
- ACK 接收后丢弃、确认丢失/EOF/畸形确认、确认等待时取消、旧 Attempt 未消费重放拒绝已有受控生产路径证据；独立 Reviewer 复核确认握手后未发现新增必修安全问题。仍为受控边界而非完整证明：真实 Manager 进程退出、变换/拆分凭据回显未覆盖；脱敏器不证明变换或拆分凭据的所有回显安全。
- 崩溃 Release 已收束（2026-11-03）：根因为驱动结束时过早删除活动句柄 + Windows Node 24 `kill()` 退出证据判定缺口（`exitCode=null`/`SIGTERM`、`close` 可先于监听注册）。修复后取消走精确身份探测（exited）→ OS 全局 claimant 扫描（存活孤儿保持占用，fail-closed）→ stdio 关闭 → 清理证据 → Release，证据化释放而非 PID 消失伪造。崩溃后取消场景 24/24 PASS（重启恢复分类 complete、根可派发）；崩溃不取消场景保持 held + 只读 + 拒绝新任务。证据：`crash-release-retest4.log`、`crash-release-full-rerun.log`、`kill-semantics-probe.mjs`。
- Reviewer 第二轮裁决（崩溃路径可接受后）三项处置均完成：(1) `withRealAdapterMcp` 成功标记移至全部资源（含 Authority）关闭成功之后，关闭失败必保留 fixture；(2) 新增生产路径"写入中取消"测试：真实 SQLite Worker 凭据帧写入未完成窗口内取消，`end` 恰一次、无重发、认证未应用、Release 与 secret 扫描通过（`write-cancel-first.log`）；(3) 第三次标准全量 `npm test` 单次运行 687 PASS / 0 FAIL / 2 SKIP（`full-test-final3.log`）。
- Reviewer 第三轮裁决：fixture 修复与全量回归接受；写入中取消测试被判定为"写入前取消"（在 `end()` 前拦截，未证明部分帧已写入）。已重做：凭据帧拆分为 prefix + 64 字节 body 经真实 `stream.write` 交付（write 回调证明字节已交给 OS）后扣留剩余字节，再经真实 `zcode_cancel` 取消；断言无重发、认证未应用、Release 与 secret 扫描（`write-cancel-partial.log` 1/1 PASS）。第四次标准全量 `npm test` 单次运行 687 PASS / 0 FAIL / 2 SKIP（`full-test-final4.log`），包含该最终测试且历史失败未复现。
- Reviewer 第四轮裁决：真实管道写入与全量回归接受；剩余精确缺口为写入回调忽略错误。已修复：回调检查 handoff 错误并使测试失败（`write-cancel-partial-handoff-assert.log` 1/1 PASS）；最终文件（SHA256 `CF47B6B7…1A6B80`）第五次标准全量 `npm test` 单次运行 687 PASS / 0 FAIL / 2 SKIP（`full-test-final5.log`）。
- 实时权益仅为内部注入合同，未实现真实实时权益；本阶段未运行真实 OAuth、Billing 或模型请求。Device Identity 未验证。
- typecheck、Plugin Validation、schema 12/12、未修改构建脚本的镜像标准 build、`git diff --check` 通过（此前两次 build EPERM 保留为未证实根因）。全量回归历史：三轮镜像 `npm test`（各 689 项、2 SKIP），第一轮唯一失败为误设测试环境目录在包根内触发的保留位置判定（代码行为正确，修正环境后 4/4 PASS）；第二轮唯一失败为旧 JSON `TaskStore` 路径权限回复测试满载退出超时的负载抖动（单跑复验通过，不引用 lifecycle-gate）；第三轮零失败。

测试保全曾出现失误：共享 fixture 清理误删一份崩溃 SQLite 现场，日志保留；现已按进程隔离 fixture、重建崩溃现场，并验证后续并行测试清理未删除该现场。详细路径见证据索引。

不提交、合并、推送或发布；Coding Plan 默认配置和生产 SQLite 未改动。

## 最终裁决（2026-11-03）

独立 Reviewer 终审：**Gate 2 APPROVED**，范围限于原生 Runtime Auth 与专用继承管道的本地合成架构和验证。已核对最终测试哈希（`mvp-real-adapter.test.ts` CF47B6B7…1A6B80）、部分帧写入后取消测试，以及完整回归 687 PASS / 0 FAIL / 2 SKIP。真实 OAuth、实时权益、Provider、Device Identity 及真实 E2E 仍未验证；本裁决不构成生产发布批准。后续正式功能集成需 Owner 另行授权。
