# ADR-039 用户授权行政释放验收报告

> Status: REPORT
> Date: 2026-11-21
> Scope: isolated SQLite/MCP regression only; production SQLite was not modified.

## 结论

- PASS：pre-Claim `launch_intent` 首次取消保持 `cleanup_held`；用户再次调用现有 `zcode_cancel({task_id})` 后，Operation 在同一 SQLite 事务中从 `launch_intent` CAS 为 `released`，追加 `observation_recorded(reason=user_authorized_release_unverified)`，且不生成 `cleanup_verified`。
- PASS：行政释放后，同一 queued Task 继续走现有 Scheduler/Admission，实际 Spawn 并完成到 `released`，不是仅依赖 cancel 返回值。
- PASS：只读 `zcode_status.dispatch_blocker` 报告阻塞 Task、Operation、phase（含 `launch_intent`）、Workspace、排队时长和阻塞时长；Doctor `active_tasks` 摘要报告同一阻塞身份。
- PASS：`launch_intent` 与 queued cancel 的同步竞态在 Spawn 前被权威投影复核拦截，未发生 Worker Spawn；Capacity-only 占用也会报告 `capacity_occupied` blocker。
- PASS：`cleanup_unverified` 行政释放按原始 durable cancel Result/event 绑定；已释放后的重复调用幂等返回 duplicate，不追加第二个 Release。
- PASS：既有 terminal `failed` / `completed` Recovery Hold 仍保持保守错误（如 `adapter_cleanup_unverified`）；只有投影本身已是 `cancelled` 的历史阻塞才允许进入行政释放，且 cancel event 查询跨分页读取。
- NOT RUN：本报告未修改或验证生产 SQLite 中的历史 Task89 实例；未执行真实模型任务；未合并、发布或推送。

## 事实边界

1. `cleanup_state=unverified_admin_release` 和 `user_authorized_release_unverified` 是行政释放事实，不是 Cleanup proof，不得报告为 `cleanup_verified`。
2. 仍然先复用现有 Recovery/termination；`worker_still_alive`、终止失败、identity unknown/alive 及非历史 cleanup 证据缺口不触发行政释放。
3. 旧 Result、Task ID、Prompt、Launch/Claim 历史和既有事件保持不变；重复调用返回 durable duplicate，不追加第二个 Release。
4. 所有写入仍由唯一 SQLite Authority 执行，未新增 MCP 工具、force 参数、CLI、Spawn Gate、状态机或自动恢复服务。

## 运行记录

- `npm run typecheck`：PASS。
- `npm run build:test`：PASS。
- 定向 Doctor `node --test --test-name-pattern "queued blocker"`：7 PASS / 0 FAIL（该文件全量选择）。
- 定向 SQLite/MCP composition 全文件：58 PASS / 0 FAIL，覆盖新增 `intent_complete` cancel/Spawn 竞态、pre-Claim 行政释放、重复取消、排队任务重调度、Capacity-only blocker、真实 Worker cleanup 和 shutdown 路径。
- `npm run build`：PASS；`npm run validate:plugin`：PASS；`git diff --check`：PASS。
- 首次提交后 `npm run test:affected` 完整执行至全量回归：962 PASS / 1 FAIL / 2 SKIP。失败暴露了 terminal `failed` Hold 被误入行政释放分支的真实回归；修复后定向失败文件 12 PASS / 0 FAIL。
- 后续需在干净提交状态重跑 `npm run test:affected`，确认完整 965 项回归全部通过；本轮已覆盖失败路径与新增 SQLite/MCP composition 58 项。
