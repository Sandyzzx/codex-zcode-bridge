# Project State

> Status: AUTHORITATIVE
> Last updated: 2026-10-08
> Last verified: 2026-10-08，本地源码与回归；发布与真实运行边界见下文。

当前状态快照，回答"现在什么能用、什么不能用"。路线图和优先级不在这里。

## 版本与发布

- 当前发布：`1.2.2`（`package.json`、`plugins/codex-zcode-bridge/plugin.json`）。
- 发布方式：release-please 监听 `master`，合并后自动开版本 PR；合并版本 PR 才产生 tag 与 GitHub Release。
- CI：`.github/workflows/ci.yml`，ubuntu 与 windows 两个作业，跑 typecheck、build、test、validate:plugin，并校验生成的 bundle 已随源码提交。
- 本地未发布修复：`codex/long-session-reliability-fixes`，包含按身份核验 Windows 进程树、原子释放锁、严格报告提示与续作、provider namespace 兼容、业务观察与清理反馈，以及调度单次快照。版本号未改，未更新安装缓存或重启其他会话服务；不能把本地代码当作已加载版本。决策见 ADR-005，验证结果见 [本次报告](reports/2026-10-08-long-session-reliability.md)。

## 稳定

- TaskManager 生命周期：`queued` / `running` / `completed` / `failed` / `cancelled` / `waiting_for_master`，含 attempt 独占、续跑归档、清理验证。
- MCP 默认工具 13 个，清单见 `INTERFACES.md`。
- `zcode_events` 的增量事件、cursor 与 raw/summary 视图。
- `zcode_feedback` 的 `TaskFeedbackSnapshotV01`。
- 工作区隔离：执行目录由调用宿主准备，Bridge 不创建也不删除 worktree。
- 模型选择：可按任务覆盖 provider/model，不持久化为工作区默认。
- 并发：同一 data root 内默认最多 8 个 worker，可用 `ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS` 在 1–8 之间调整。

## 实验

- `zcode_progress_probe`：默认关闭，只有直接调用 `createBridgeServer({ enableExperiments: true })` 才注册。
- Desktop 索引同步：best effort，事务内校验 schema 与 Bridge owner；尚未写入真实 Desktop 数据库。

## 不支持

- Start Plan 的 headless 认证：app-server 需要桌面渲染器提供的验证码会话，Bridge 不伪造、不绕过。当前 headless 开发路径使用 Coding Plan。见 `research/start-plan-headless-2026-09-27.md`。

## 调查中 / NOT RUN

以下边界没有实跑验证，不能当成已知可用：

- `session/read` 原生当前状态查询：未接入。
- 真实 ZCode app-server RPC 探针与跨版本兼容：只在记录过的 0.16.9 路径上观测过。
- 真实 ZCode 权限审批往返：现有回归使用假运行时，未经真实交互验证。
- 跨 Host 并发 attach/control：研究阶段结论为 NO-GO，除非上游提供 ownership/control 协议。
- 真实 GUI 关闭时序、UI 响应与取消时延。
- 真实 Desktop 数据库写入与刷新行为。
- PID 重用，以及自行脱离进程组的后代进程。
- Windows 树采样后新增的后代，以及采样与发信号之间的身份变化；已运行的真实 Windows 树清理回归不能覆盖这些窗口。
- 旧不可读取 owner 与崩溃遗留 reclaim guard 的安全恢复；没有按年龄清除旧锁。
- 长会话真实 provider/报告一次合格率。调度已减少同次重复扫描，仍有随历史库增长的全量校验成本。

## 核对来源

`package.json`、`src/host/stdio.ts`、`src/mcp/server.ts`、`src/worker/run-task.ts`、`src/adapters/zcode-app-server-adapter.ts`、`docs/ARCHITECTURE.md`、`docs/INTERFACES.md`、GitHub Actions 运行记录。文中标注"未运行"的条目没有被上述来源证实，保持未验证状态。
