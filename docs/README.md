# 文档路由 / Documentation

> Status: AUTHORITATIVE（仅指本索引）
> Last updated: 2026-11-07
> Last verified: 2026-11-07，核对 ADR-029 当前文档路由、保留文件与渐进加载范围。
> Verified against: a46137fe46b567271a7756be819361132625278c + ADR-029 本地候选（未发布）

English users start at [README.md](../README.md). 技术文档为中文。先读当前事实，按问题加载合同；研究/历史材料不作为当前实现。

## Master 默认路径 / Default reading

1. [PROJECT_STATE.md](PROJECT_STATE.md)：当前候选、已发布版本和未认证边界。
2. 执行/排队/恢复问题读 [ARCHITECTURE.md](ARCHITECTURE.md)；字段/结果/交互问题读 [INTERFACES.md](INTERFACES.md)。不要求每次读完两份。
3. 只有解释取舍时读 [decisions/README.md](decisions/README.md) 对应主题的 ADR；不通读全部 ADR。

普通 Bridge 委派按 [Master Skill](../plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md) 的动作路由加载 references，不要求预读仓库架构或历史报告。

## 当前文档 / Current references

| 问题 | 文档 |
|---|---|
| 系统怎样工作、谁持有事实 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| MCP、Task/Result、Attention、取消合同 | [INTERFACES.md](INTERFACES.md) |
| Core API、fork、Host/Worker 打包 | [SHARED_CORE.md](SHARED_CORE.md) |
| Node/ZCode 配置、SQLite 离线升级 | [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md) |
| 测试入口、压力触发和退役边界 | [testing/README.md](testing/README.md) |
| 公开产品入口 | [README.md](../README.md)、[中文说明](../README.zh-CN.md) |
| 插件安装/安全 | [插件说明](../plugins/codex-zcode-bridge/README.md)、[SECURITY](../plugins/codex-zcode-bridge/SECURITY.md) |

## 状态与追溯 / Status and history

AUTHORITATIVE 描述当前事实/合同；DECISION 记录已批准取舍；RESEARCH 是证据和研究；ARCHIVED 仅供历史追溯。每份文档自带日期/核对范围，更新不等于已验证；以文档本身标注为准。

[ADR 索引](decisions/README.md) 区分当前有效、部分被替代、完全被替代。历史文件保持原路径，避免破坏引用。不要默认加载 docs/archive、docs/research、旧审计日志或生成 bundle。

本轮退役决策见 [ADR-029](decisions/ADR-029-legacy-runtime-retirement.md)。R2 宿主限制的历史验收见 [R2 报告](research/r2-final-acceptance-20261106/R2_FINAL_ACCEPTANCE.md)，R3 期限证据见 [R3 报告](reports/sqlite-r3-deadlines-2026-11-06.md)；这些不是当前候选重新执行的结果。

当前事实放 docs 顶层，设计取舍放 decisions，研究放 research，一次性交付放 reports，历史放 archive；草稿放已忽略的 docs/_draft。CHANGELOG 仍由 release-please 维护，不手改。
