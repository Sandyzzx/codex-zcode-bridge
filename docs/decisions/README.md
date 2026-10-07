# 决策记录 / Decisions

> Status: AUTHORITATIVE（仅指本索引）
> Last updated: 2026-10-07

本目录保存已批准的架构决策和带日期的决策记录。决策回答"为什么这样定"，当前实现仍以 `ARCHITECTURE.md` / `INTERFACES.md` 为准。

## 现有记录

| 文档 | 状态 | 说明 |
|---|---|---|
| [roadmap-decisions-2026-09-27.md](roadmap-decisions-2026-09-27.md) | DECISION | 2026-09-27 的路线图与决策讨论。仍然成立的结论需要提炼进 `ARCHITECTURE.md` / `INTERFACES.md`；本文本身不是当前事实来源。 |
| [reliability-repair-plan-v2-2026-10-03.md](reliability-repair-plan-v2-2026-10-03.md) | DECISION | Bridge 可靠性修复计划。A/B 主要改动已实现；C/D 与宿主启动核验仍有未完成项。 |

## 待补的 ADR

以下主题目前只存在于权威文档的正文叙述里，没有独立决策记录。补写 ADR 时应以现有权威文档为准，搬运已有结论，不新增决策：

- 生产执行路径使用 ZCode app-server，历史 CLI 路径只作 legacy 模块保留。
- Manager 独占任务生命周期，worker 通过 attempt claim 进入执行。
- 执行目录（worktree）由调用宿主准备，Bridge 不创建也不删除。
- 本地 metadata、rollout、日志与 Desktop 索引只作观察面，不作控制面。

## 命名

新决策使用 `ADR-NNN-<slug>.md`，正文至少包含 Status、Date、Context、Decision、Rationale、Consequences。
