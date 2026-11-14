# 文档路由 / Documentation

> Status: AUTHORITATIVE（仅指本索引）
> Last updated: 2026-11-14
> Last verified: 2026-11-14，核对 `origin/preview` 的生产链、ADR-032–037，以及当前本地候选的 Coding Plan/Start Plan 核心真实 E2E、Workspace 边界处置、ZCode 3.18.2 只读认证复用、隔离升级回滚、BOM 和完整回归；3.18.0/3.18.1 实机安装组合仍未验收。
> Verified against: `a754545eb83d8e314c727c3ca0df0a2d3f47325d`；base `origin/preview` = `9bec5a27d6182a83620c32105e80210f8731f514`

English users start at [README.md](../README.md). 技术文档为中文。先读当前事实，按问题加载合同；研究或历史材料不作为当前实现或发布证明。

## Master 默认路径 / Default reading

1. [PROJECT_STATE.md](PROJECT_STATE.md)：已发布版本、当前候选和未认证边界。
2. 执行、排队、恢复与官方 Host 问题读 [ARCHITECTURE.md](ARCHITECTURE.md)；字段、结果与交互问题读 [INTERFACES.md](INTERFACES.md)。
3. 只有解释取舍时读 [decisions/README.md](decisions/README.md) 对应主题的 ADR；不通读全部 ADR。

普通 Bridge 委派按 [Master Skill](../plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md) 的动作路由加载 references，不要求预读仓库架构或历史报告。

## 当前文档 / Current references

| 问题 | 文档 |
|---|---|
| 系统怎样工作、谁持有事实 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 现有 Worker 内官方 Host 目标 | [ADR-032](decisions/ADR-032-existing-worker-official-host-integration.md) |
| 账户 refresh 协调 | [ADR-033](decisions/ADR-033-official-account-refresh-coordination.md) |
| 正常 Cleanup 复用 Worker-tree Proof | [ADR-034](decisions/ADR-034-normal-cleanup-worker-tree-proof.md) |
| 官方 ZCode 认证复用合同与当前候选实现 | [ADR-037](decisions/ADR-037-official-zcode-authentication-reuse.md)、[ARCHITECTURE.md](ARCHITECTURE.md) |
| Preview.4 / ZCode 3.18.0 历史 Official Host 证据 | [历史 Implementation Summary](research/zcode-official-host-integration-v1/IMPLEMENTATION_SUMMARY.md)、[历史 Final Acceptance](research/zcode-official-host-integration-v1/FINAL_ACCEPTANCE_REPORT.md)（仅供历史追溯，不是 3.18.2 认证候选的验收证据） |
| MCP、Task/Result、Attention、取消合同 | [INTERFACES.md](INTERFACES.md) |
| Core API、fork、Host/Worker 打包 | [SHARED_CORE.md](SHARED_CORE.md) |
| Node/ZCode 配置、SQLite 升级 | [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md) |
| 测试入口、压力触发和退役边界 | [testing/README.md](testing/README.md) |
| 公开产品入口 | [README.md](../README.md)、[中文说明](../README.zh-CN.md) |
| 插件安装/安全 | [插件说明](../plugins/codex-zcode-bridge/README.md)、[SECURITY](../plugins/codex-zcode-bridge/SECURITY.md) |

## 状态与追溯 / Status and history

AUTHORITATIVE 描述当前事实或合同；DECISION 记录已批准取舍；RESEARCH 是证据与研究；ARCHIVED 仅供历史追溯。每份文档自带日期和核对范围；更新不等于已验证，以文档自身标注为准。

[ADR 索引](decisions/README.md) 区分当前有效、部分被替代和完全被替代。历史文件保持原路径，避免破坏引用。不要默认加载 `docs/archive`、`docs/research`、旧审计日志或生成 bundle。

当前 Preview 发布制品为 `2.0.0-preview.5`。`package.json`、`package-lock.json`、插件 manifest、MCP server version、固定官方 Host/BOM 和 R7 Runtime Events/Usage 均来自同一版本提交与 Tag。旧 JSON/CLI 生产链退役决策见 [ADR-029](decisions/ADR-029-legacy-runtime-retirement.md)。

ADR-032 已接受且已在 Preview.5 实现“现有 Worker 内官方 Host”。ADR-033 的账户 refresh 协调、ADR-034 的正常 Cleanup 复用和 ADR-035 的平台选择由固定上游 patch 与同一 Worker 实现。ADR-037 已接受“官方 Host 拥有认证、Bridge 不维护第二套凭据/身份系统”的目标；当前本地候选已实现该接线。真实 Coding Plan 完整 E2E 和 Start Plan 核心功能 E2E 已通过；历史 Start Plan 完整 E2E 因 Workspace 内 PowerShell cache 保持 FAIL。当前候选尚未提交到远程或发布，实际 Desktop 3.18.0/3.18.1/3.18.2 安装组合仍必须分别验收。

已发布的 Preview.5 固定 ZCode `3.18.0` / `b95ebaffeab641907b38652f45c1502bd762972d`。当前本地认证复用候选固定 ZCode `3.18.2` / `fec975905a2abd4c07e35c40d51fa097a2258ec9` 与 AppServer `0.17.1`，有序 patch 集可从固定源码 HEAD 重放并生成同一源码树。Windows x64、Node `24.16.0` 的认证测试、Host/native 加载、完整隔离回归以及 Preview.5 → 候选 → Preview.5 隔离升级回滚已经通过。六个 `@napi-rs/keyring` native closure/license/metadata 文件仍受 BOM/hash 校验；完整动态资源闭包与逐项再分发审查保持 `PARTIAL`。跨机器/空缓存可复现、fresh Windows helper rebuild、Desktop 3.18.0/3.18.1 实机矩阵和一般 Desktop Main 独立性仍未完成。

历史 Companion 研究保留原正文，但顶部“历史/被 ADR-032 替代”的适用性说明优先。旧官方 Host `ASTRA_REVIEW.md` 正文只覆盖更早候选；Preview.4 的 `APPROVED / PR_READY: YES` 结论来自 [ASTRA_REVIEW_CURRENT.md](research/zcode-official-host-integration-v1/ASTRA_REVIEW_CURRENT.md)。Preview.5 增加 PR #85 的 R7 集成、v14 兼容迁移与 Administrative Recovery 修复。

当前事实放 `docs` 顶层，设计取舍放 `decisions`，研究放 `research`，一次性交付放 `reports`，历史放 `archive`；草稿放已忽略的 `docs/_draft`。CHANGELOG 由 release-please 维护，不手改。
