# 文档路由 / Documentation

> Status: AUTHORITATIVE（仅指本索引）
> Last updated: 2026-11-22（Preview.12 Recovery Observation 限额移除）
> Last verified: 2026-11-22，核对 PR #116、PR #121、默认完整 Result/显式 Summary、Event Attempt 归属、ADR-048 默认 Event 页预算、材料事实去重与历史 v14 Hold 兼容。
> Verified against: `f51e965ebe38e85b3b8d3dea1396384aa634d2d4` + Preview.12 release candidate

English users start at [README.md](../README.md). 技术文档为中文。先读当前事实，按问题加载合同；研究或历史材料不作为当前实现或发布证明。

## Master 默认路径 / Default reading

1. [PROJECT_STATE.md](PROJECT_STATE.md)：当前发布身份、已验证范围和未认证边界。
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
| 官方 ZCode 认证复用合同与 Preview.6/Preview.7 实现 | [ADR-037](decisions/ADR-037-official-zcode-authentication-reuse.md)、[ARCHITECTURE.md](ARCHITECTURE.md) |
| 已安装官方 AppServer：统一 Provider Runtime、Coding Plan 优惠兼容、Start Plan 离线兼容 | [ADR-040](decisions/ADR-040-installed-official-appserver-runtime.md)、[ADR-041](decisions/ADR-041-thin-official-host-end-state.md)、[Coding Plan 正式证据](evidence/coding-plan-official-discount-verification-20261118.md)、[Start Plan 离线研究](research/start-plan-official-appserver-compatibility-20261118.md)、[11-19 统一 Runtime 交付报告](reports/unified-official-appserver-startplan-20261119.md) |
| 未知官方版本的安全检查与指纹授权实验探测 | [ADR-042](decisions/ADR-042-unknown-runtime-experimental-authorization.md)、[3.19.0 兼容性报告](reports/zcode-3.19.0-compatibility-20261120.md) |
| SQLite Schema 支持 | [ADR-043](decisions/ADR-043-sqlite-v14-only.md) | `SQLite v14 ONLY`；v13 与旧升级 Marker 非破坏性拒绝 |
| SQLite v13 退役验收 | [验收报告](reports/sqlite-v13-retirement-20261121.md) | v14-only 支持、v13 非破坏性拒绝、测试/生成物退役与完整回归证据 |
| Preview.11 发布与已知边界 | [发布报告](reports/preview11-release-20261122.md) | 默认完整 Result、opt-in 摘要、Event 分页、用户授权阻塞释放与真实 A/B `BLOCKED` |
| Preview.12 发布与 Recovery 兼容 | [发布报告](reports/preview12-release-20261122.md) | 无固定观察次数、重复材料事实去重、超过 8 条 Hold 消解、旧 v14 Trigger 兼容与真实 A/B `BLOCKED` |
| Preview.7 Post-Audit 最小架构、正确性、Legacy JSON 与 CI 整改 | [ADR-038](decisions/ADR-038-preview6-minimum-architecture-remediation.md)、[PROJECT_STATE.md](PROJECT_STATE.md) |
| Start Plan 与安装版 AppServer 离线兼容性 | [研究](research/start-plan-official-appserver-compatibility-20261118.md) |
| 本次 Runtime、Cost Lab Web 与 Start Plan 集成交付 | [验收报告](reports/official-runtime-integration-costlab-web-startplan-20261118.md) |
| Preview.4 / ZCode 3.18.0 历史 Official Host 证据 | [历史 Implementation Summary](research/zcode-official-host-integration-v1/IMPLEMENTATION_SUMMARY.md)、[历史 Final Acceptance](research/zcode-official-host-integration-v1/FINAL_ACCEPTANCE_REPORT.md)（仅供历史追溯，不是 3.18.2 认证候选的验收证据） |
| Thin Adapter Final Audit 与 End-State（2026-11-19） | [架构审计报告](reports/thin-adapter-final-audit-20261119.md)、[最终收敛报告](reports/thin-adapter-end-state-20261119.md) |
| MCP、Task/Result、Attention、取消合同 | [INTERFACES.md](INTERFACES.md) |
| Result 摘要、Event 归属与默认 Event 分页 | [ADR-047](decisions/ADR-047-compatible-result-summary.md)、[ADR-048](decisions/ADR-048-bounded-default-event-pages.md)、[Token Efficiency 发布门禁](research/token-efficiency-phase0-20261121/TOKEN_EFFICIENCY_RELEASE_GATE.md) |
| Core API、fork、Host/Worker 打包 | [SHARED_CORE.md](SHARED_CORE.md) |
| Node/ZCode 配置、SQLite v14-only 边界 | [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md) |
| 测试入口、压力触发和退役边界 | [testing/README.md](testing/README.md) |
| 公开产品入口 | [README.md](../README.md)、[中文说明](../README.zh-CN.md) |
| 插件安装/安全 | [插件说明](../plugins/codex-zcode-bridge/README.md)、[SECURITY](../plugins/codex-zcode-bridge/SECURITY.md) |

## 状态与追溯 / Status and history

AUTHORITATIVE 描述当前事实或合同；DECISION 记录已批准取舍；RESEARCH 是证据与研究；ARCHIVED 仅供历史追溯。每份文档自带日期和核对范围；更新不等于已验证，以文档自身标注为准。

[ADR 索引](decisions/README.md) 区分当前有效、部分被替代和完全被替代。历史文件保持原路径，避免破坏引用。不要默认加载 `docs/archive`、`docs/research`、旧审计日志或生成 bundle。

当前 Preview 发布候选身份为 `2.0.0-preview.12`。`package.json`、`package-lock.json`、插件 manifest、MCP server version、官方签名 Runtime Host 与固定官方 Host/BOM 必须来自同一提交、Tag 和 Release。发布支持范围仍限定为 Windows x64、Node.js `24.16.0` 与 ZCode Desktop `3.18.2.10443`。Preview.12 在 Preview.11 的 Result、Event 与用户授权释放合同上移除 Recovery Observation 固定次数限制，对未变化 active 材料事实去重，并兼容超过 8 条历史 Hold 的 count/root 消解；SQLite v14 仍是唯一当前 Schema。ADR-042 允许其他安全但未知的精确安装指纹在用户授权后进入 `OFFICIAL_RUNTIME_EXPERIMENTAL`，但不把该版本加入发布支持范围，也不提升 Provider、折扣或 Start Plan 能力。ADR-041 implementation 为 `a676c6cd14573f2620339f992a345ed0715541ff`；Final Closure implementation 为 `f19ab1d75dcced7613bfe6e12c84d780d01f7127`。旧 JSON/CLI 生产链退役决策见 [ADR-029](decisions/ADR-029-legacy-runtime-retirement.md)。ADR-041 后插件不再分发 `app-server/zcode.cjs` 或随附 builtin Provider 配置，所有 Provider 使用安装版 AppServer。

ADR-032 已接受且已在 Preview.5 实现“现有 Worker 内官方 Host”。ADR-033 的账户 refresh 协调、ADR-034 的正常 Cleanup 复用和 ADR-035 的平台选择由固定上游 patch 与同一 Worker 实现。ADR-037 已接受“官方 Host 拥有认证、Bridge 不维护第二套凭据/身份系统”的目标；Preview.6 已实现该接线。Preview.6/Preview.7 历史路径上的真实 Coding Plan 完整 E2E 和 Start Plan 核心功能路径曾通过；但 2026-11-19 统一安装版 Runtime 的 Start Plan 真实 Entitlement/E2E/Billing Observation 尚未运行。历史 Start Plan 完整 E2E 因 Workspace 内 PowerShell cache 保持 FAIL。Desktop 3.18.0/3.18.1 保持 `NOT_VERIFIED`，不得写成 PASS 或不兼容。

ADR-038 以已发布的 Preview.6 为冻结基线，保留 SQLite/Worker/官方认证与 Runtime 核心，删除旧 3.18.0 Runtime 分发资源及已经退出的外围功能，并修正 Usage、Task context、Events summary、Recovery 说明、CI 分层和生成物 Freshness。Preview.7 已实现该决策并进入发布验证。

Preview.7 继承 Preview.6 固定 ZCode `3.18.2` / `fec975905a2abd4c07e35c40d51fa097a2258ec9` 与 AppServer `0.17.1`，有序 patch 集可从固定源码 HEAD 重放并生成同一源码树。2026-11-19 的集成分支在此基础上将 Model Catalog、Coding Plan、Start Plan 与其他受支持 Provider 接入同一安装版 AppServer Session Factory，并移除打包 AppServer Runtime；Final Closure 增加了基于 Runtime 实际选择的动态 capability gate 与生产 Runtime Auth fail-closed。Start Plan 新 Runtime 的真实 E2E 和倍率验证随后单独执行，未通过时不得合并。Windows x64、Node `24.16.0` 的认证测试、Host/native 加载、clean install、签名 runtime host smoke 以及带代表性数据的 Preview.5 → Preview.6 → Preview.5 隔离升级回滚已经通过。六个 `@napi-rs/keyring` native closure/license/metadata 文件受 BOM/hash 校验；Windows helper 使用来自官方 Desktop `3.18.2.10443` 的有效 Authenticode 文件，Owner 已确认再分发权利，Fresh Rebuild 不再是门槛。跨机器制品复现、Desktop 3.18.0/3.18.1 实机矩阵、真实其他 Provider E2E、真实 OAuth refresh 和一般 Desktop Main 独立性仍未验证；前两项与真实 refresh 风险仅按 Owner 裁决接受于 Preview。

历史 Companion 研究保留原正文，但顶部“历史/被 ADR-032 替代”的适用性说明优先。旧官方 Host `ASTRA_REVIEW.md` 正文只覆盖更早候选；Preview.4 的 `APPROVED / PR_READY: YES` 结论来自 [ASTRA_REVIEW_CURRENT.md](research/zcode-official-host-integration-v1/ASTRA_REVIEW_CURRENT.md)。Preview.5 增加 PR #85 的 R7 集成、v14 兼容迁移与 Administrative Recovery 修复。

当前事实放 `docs` 顶层，设计取舍放 `decisions`，研究放 `research`，一次性交付放 `reports`，历史放 `archive`；草稿放已忽略的 `docs/_draft`。CHANGELOG 由 release-please 维护，不手改。
