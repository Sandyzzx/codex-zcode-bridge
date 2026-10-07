# 文档索引 / Documentation

英文使用者从 [README.md](../README.md) 开始。技术文档为中文。本文是文档路由：先看状态等级，再按读者路径选文档。

English readers start at [README.md](../README.md). This index is bilingual; the technical documents themselves are written in Chinese.

## 状态等级 / Status levels

每份文档顶部标注四种状态之一。这是本仓库最重要的一条约定：没有状态标注的文档不能被当成事实依据。

| 状态 | 含义 | 使用方式 |
|---|---|---|
| `AUTHORITATIVE` | 当前事实或合同 | 可以据此开发和判断 |
| `DECISION` | 已批准的架构决策 | 引用它回答"为什么不那样做" |
| `RESEARCH` | 研究结论 | 只作参考，不代表当前实现 |
| `ARCHIVED` | 历史材料 | 默认不读，只用于追溯 |

现状说明：下面的现有文档在本次整理前没有状态标注，状态由本索引统一指定。文档下次被修改时补上顶部标注。

## For Master Agents

按顺序读，不要通读全仓库文档。标 `待建` 的条目属于下一批整理，本批尚未提交：

1. `docs/PROJECT_STATE.md` —— 当前状态快照（稳定 / 实验 / 不支持 / 调查中）`待建`
2. `docs/ARCHITECTURE.md` —— 系统现在怎么工作
3. `docs/INTERFACES.md` —— 合同与兼容边界
4. `docs/decisions/README.md` —— 已批准决策索引 `待建`
5. 只在需要证据时读 `docs/research/` `待建`

不要默认读 `docs/archive/`。

## For Coding Agents

1. 本任务涉及的合同文档（`INTERFACES.md` / `ZCODE_RUNTIME.md` / `SHARED_CORE.md`）
2. 对应组件的架构（`ARCHITECTURE.md`）
3. `AGENTS.md` 里的硬规则

实现不能自行改写合同。需要改合同先提 `DECISION`。

## 索引 / Index

### 权威文档 AUTHORITATIVE

| 文档 | 语言 | 最后更新 | 最后核对 |
|---|---|---|---|
| [README.md](../README.md) | en | 2026-10-05 | 未记录 |
| [README.zh-CN.md](../README.zh-CN.md) | zh | 2026-10-03 | 未记录 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | zh | 2026-10-03 | 未记录 |
| [INTERFACES.md](INTERFACES.md) | zh | 2026-10-06 | 未记录 |
| [SHARED_CORE.md](SHARED_CORE.md) | zh | 2026-10-06 | 未记录 |
| [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md) | zh | 2026-10-03 | 未记录 |
| [plugins/codex-zcode-bridge/README.md](../plugins/codex-zcode-bridge/README.md) | zh | 2026-10-03 | 未记录 |
| [plugins/codex-zcode-bridge/SECURITY.md](../plugins/codex-zcode-bridge/SECURITY.md) | zh + en | 2026-10-03 | 未记录 |
| [plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md](../plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md) | zh | 2026-10-06 | 未记录 |

`最后核对` 表示上一次有人把文档内容与代码逐条对照的日期。这一列目前全部为空，说明此前没有这个习惯；新建和修改文档时必须填写，否则该文档只能算"最后更新"，不能算"已验证"。

### 报告与历史 REPORT / ARCHIVED

| 文档 | 状态 | 说明 |
|---|---|---|
| [TASK_FEEDBACK_V01_IMPLEMENTATION_REPORT.md](../TASK_FEEDBACK_V01_IMPLEMENTATION_REPORT.md) | REPORT | Task Feedback v0.1 的交付报告，一次性材料 |
| [PHASE7_LIVE_PROGRESS.md](PHASE7_LIVE_PROGRESS.md) | ARCHIVED | Phase 7 兼容说明；有效内容待提炼进 `INTERFACES.md` 后移入 `archive/` |

### 自动生成 Generated

| 文档 | 说明 |
|---|---|
| [CHANGELOG.md](../CHANGELOG.md) | 由 release-please 维护，不要手改 |

## 新文档放哪里

| 内容 | 位置 |
|---|---|
| 当前事实、合同 | `docs/` 顶层，数量控制在 10 份以内 |
| 已批准决策 | `docs/decisions/ADR-NNN-<slug>.md` |
| 研究结论与证据 | `docs/research/<topic>-<YYYY-MM-DD>/` |
| 一次性交付报告 | `docs/reports/` |
| 已被取代的材料 | `docs/archive/<phase-or-topic>/` |
| 未定稿草稿 | `docs/_draft/`（已 gitignore，不进仓库） |

## 仓库外的材料

以下内容有意不放进仓库，追溯时按下表位置查找：

| 位置 | 内容 |
|---|---|
| `C:\Users\Sandy\.codex\archived_docs\codex-zcode-bridge\` | 全库审计报告、生命周期可观测性方案、ccteam 对比、整改报告、验收证据 JSON |
| `<repo>\.tasks\notes\` | 会话期笔记；属于桥接运行数据根，不是版本化文档 |

桥接运行数据根 `.tasks/` 只放任务记录，不要在那里存放研究用的外部仓库克隆。
