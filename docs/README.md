# 文档路由 / Documentation

> Status: AUTHORITATIVE（仅指本索引）
> Last updated: 2026-11-11
> Last verified: 2026-11-11，产品入口沿用 bfd3406f 核对；本轮核对 ADR-032 目标冻结、两项 Proposed 草案及 POC-1 路由，未执行新路径。
> Verified against: 372e90622772b070357a278f1da3dea58fa42dee（本轮文档路由）

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
| 下一阶段已接受目标（尚未实施） | [ADR-032：Worker 内官方 Host](decisions/ADR-032-existing-worker-official-host-integration.md) |
| MCP、Task/Result、Attention、取消合同 | [INTERFACES.md](INTERFACES.md) |
| Core API、fork、Host/Worker 打包 | [SHARED_CORE.md](SHARED_CORE.md) |
| Node/ZCode 配置、SQLite 离线升级 | [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md) |
| 测试入口、压力触发和退役边界 | [testing/README.md](testing/README.md) |
| 公开产品入口 | [README.md](../README.md)、[中文说明](../README.zh-CN.md) |
| 插件安装/安全 | [插件说明](../plugins/codex-zcode-bridge/README.md)、[SECURITY](../plugins/codex-zcode-bridge/SECURITY.md) |

## 状态与追溯 / Status and history

AUTHORITATIVE 描述当前事实/合同；DECISION 记录已批准取舍；RESEARCH 是证据和研究；ARCHIVED 仅供历史追溯。每份文档自带日期/核对范围，更新不等于已验证；以文档本身标注为准。

[ADR 索引](decisions/README.md) 区分当前有效、部分被替代、完全被替代。历史文件保持原路径，避免破坏引用。不要默认加载 docs/archive、docs/research、旧审计日志或生成 bundle。

当前 Preview 基线与套餐入口见 [PROJECT_STATE.md](PROJECT_STATE.md) 和根目录 README。旧 JSON/CLI 生产链退役决策见 [ADR-029](decisions/ADR-029-legacy-runtime-retirement.md)。R2 宿主限制、R3 期限和 Start Plan Gate 2 的历史材料保留用于追溯，不代表 Preview.3 的当前验收。

Preview.3 的 Start Plan 真实证据目前只覆盖 Windows、官方 AppServer `0.17.1` 和 `GLM-5.3-Flash`。其他 Start Plan 模型、其他平台、CAPTCHA 与 unusual-activity 的无人值守处理仍未认证；不要把单模型真实请求成功写成通用能力。

当前事实放 docs 顶层，设计取舍放 decisions，研究放 research，一次性交付放 reports，历史放 archive；草稿放已忽略的 docs/_draft。CHANGELOG 仍由 release-please 维护，不手改。

历史资产的本轮分类与有限清理见 [Legacy & Dead Code Audit v1](reports/LEGACY_DEAD_CODE_AUDIT_V1.md)；该报告是候选证据，不能替代当前合同或各 PR 的验收。

官方 Host 集成的拓扑/职责/制品策略已由 ADR-032 Accepted 冻结，独立 Companion 已移出当前目标。依据为 [Astra 审查](research/zcode-companion-independent-review-2026-11-11/REVIEW.md) 与 [架构收敛报告](research/zcode-companion-owner-architecture-convergence-2026-11-11/OWNER_ARCHITECTURE_DECISION_REVIEW.md)；历史正文保留，新增适用性说明指向正式决定。[账户和 Cleanup 草案](research/zcode-companion-owner-architecture-convergence-2026-11-11/ADR_PROPOSALS.md) 仍 Proposed；[冻结核对报告](reports/2026-11-11-official-host-architecture-freeze.md) 与 [POC-1 计划](research/zcode-official-host-architecture-freeze-2026-11-11/POC_1_ENTRY.md) 明确未决能力和单独授权门槛。
