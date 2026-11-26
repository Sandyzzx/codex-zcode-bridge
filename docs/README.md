# 文档路由 / Documentation

> Status: AUTHORITATIVE（仅指本索引）
> Last updated: 2026-11-26（Preview.18 候选：ADR-064 Executor 启动能力、Writer Intent 身份恢复与用户授权释放）
> Last verified: 2026-11-26，核对 ADR-064 的 Executor recovery 真实进程 13/13、SQLite writer intent 35/35、forced cleanup Store、Result paging、Web HTTP 清理与 process-lock PID reuse 定向测试。完整本地/双平台 Release Gate 与真实 Host 场景以 Preview.18 最终报告记录。
> Verified against: `57e0a70b` 基线上的候选工作树；提交后由最终报告记录候选 SHA。

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
| Preview.13 发布与统一取消释放 | [GitHub Release](https://github.com/Sandyzzx/codex-zcode-bridge/releases/tag/codex-zcode-bridge-preview-v2.0.0-preview.13) | 完整捕获响应 AgentReport 解析、四种终态 Result 统一 `zcode_cancel`、安全证明保留与真实 A/B `BLOCKED` |
| Preview.15 发布 | [GitHub Release](https://github.com/Sandyzzx/codex-zcode-bridge/releases/tag/codex-zcode-bridge-preview-v2.0.0-preview.15)、[发布记录](reports/preview15-publication-20261124.md) | Preview.15 prerelease 已发布：Tag 与 Release commit 一致，ZIP/SHA256 可下载且回验一致，Latest 仍为 Stable |
| Preview.16 发布 | [GitHub Release](https://github.com/Sandyzzx/codex-zcode-bridge/releases/tag/codex-zcode-bridge-preview-v2.0.0-preview.16)、[发布记录](reports/preview16-publication-20261124.md) | Preview.16 prerelease 已发布：Owner Binding + 安装即生效 Auto Wake；Tag 与 Release commit 一致，ZIP/SHA256 可下载且回验一致，Latest 仍为 Stable |
| Preview.17 候选 | [A 报告](reports/preview17-a-executor-recovery-20261125.md)、[B 研究](research/preview17-master-goal-autonomy-20261125.md)、[C 报告](reports/preview17-c-webui-20261125/REPORT.md)、[D 报告](reports/preview17-d-icon-20261125.md)、[真实 Host E2E](reports/preview17-real-host-e2e-20261125.md) | Executor 崩溃恢复与 Release 事实 Continue、Master 验收驱动返工（真实两轮 Continue 闭环）、单页 Task Workspace（搜索、共享 bucket、品牌图标字节、动作前置、成本证据折叠）、Original E 恢复与顶层 interface 接线；未创建 Tag/Release，本地完整门禁通过，Windows/Ubuntu CI 与 merge 以最终 PR/交付报告为准 |
| Preview.18 候选 | [ADR-064](decisions/ADR-064-executor-startability-and-user-release.md) | Worker/launch 不确定性 Operation 级隔离、exact process identity 恢复、SQLite 用户授权清理、Spawn error 保护、Result envelope/content digest 分离；完整门禁与发布事实以最终 PR/交付报告为准 |
| Preview.15 集成与验证 | [验证记录](reports/preview15-final-integration-verification-20261124.md)、[发布准备](reports/preview15-release-20261124.md) | PR #135 + 4.0.0 适配 + ADR-054/055/056 + P1/P2 整改的候选验证：Protocol Smoke 与真实任务 E2E 为 REAL PASS；发布事实以 Release Gate 运行为准 |
| Preview.16 Owner Binding + Auto Wake | [ADR-059](decisions/ADR-059-owner-binding-and-installed-auto-wake.md)、[架构合同](architecture/BRIDGE_ASYNC_EXECUTION_V1.md)、[真实 Host E2E](reports/preview16-real-host-e2e-20261124.md) | `PASS — REAL`：`_meta.threadId` 唯一身份来源、Task/Attempt/Binding 同事务、并发隔离、无授权文件 Queue、ACK 与 Turn Started 分离、Late Wake 独立补偿、receipt Console link；真实安装制品 + 真实 Codex Host 完成一次非空工程 Auto Wake 闭环 |
| Preview.14 发布 | [GitHub Release](https://github.com/Sandyzzx/codex-zcode-bridge/releases/tag/codex-zcode-bridge-preview-v2.0.0-preview.14)、[发布报告](reports/preview14-release-20261123.md) | 独立 Executor、Thin MCP、CLI/Web/Wake 已发布为 prerelease；ZIP 与 SHA256 可下载，Latest 仍为 Stable |
| Async Executor PR 2–6 | [架构合同](architecture/BRIDGE_ASYNC_EXECUTION_V1.md)、[ADR-045](decisions/ADR-045-async-executor-ownership.md)、[PR 2 证据](reports/async-executor-pr2-20261122.md)、[PR 2.5 证据](reports/async-executor-pr2.5-20261122.md)、[统一 RC 证据](reports/async-executor-release-candidate-20261122.md)、[Web real-process E2E](reports/async-executor-web-real-host-e2e-20261122.md) | `PASS — REAL LOADED/IDLE TRUSTED-LOCAL WAKE`：Lease、IPC、Thin MCP、CLI/Web、Host 退出与 synthetic-Worker Result/Cleanup/Release PASS；loaded/idle Queue、Turn、Native MCP Result readback、Master 生命周期独立验收与 Desktop visible PASS REAL；严格 C/D、Desktop fully exited、Official Runtime provenance 和非空工程交付为 `NOT_RUN` |
| Task CLI candidate | [ADR-049](decisions/ADR-049-task-cli-control-surface.md) | `IMPLEMENTED / PARTIAL`：同一 Executor Control Client、bounded Task list、Result 摘要/文件预算与已运行 Executor 检测；不拥有 SQLite |
| Task CLI evidence | [PR 3 report](reports/async-executor-pr3-20261122.md)、[实机验收](reports/async-executor-real-host-acceptance-20261122.md) | `PASS — TARGETED`：同一 Control 面的 bounded list/Result、`task console-url` 与 start/stop 合同保持；`wake-authorize` 已由 ADR-059 退役 |
| Task Web Console candidate | [ADR-050](decisions/ADR-050-local-task-web-console.md)、[PR 4 report](reports/async-executor-pr4-20261122.md)、[Web real-process E2E](reports/async-executor-web-real-host-e2e-20261122.md) | `PASS — TARGETED / REAL BROWSER + SYNTHETIC WORKER`：动态发现/复用、Deep Link、跨页 summary、Result pending 独立显示、MCP Host 退出后 Web/Executor 继续可用；不等同真实 Desktop 或 Official Runtime |
| Task Workspace + Diagnostics | [WEB_CONSOLE.md](WEB_CONSOLE.md)、[ADR-062](decisions/ADR-062-single-page-task-console.md)、[验收报告](reports/preview17-c-webui-20261125/REPORT.md) | `IMPLEMENTED / TARGETED`：单一 loopback Origin、单页 Tasks、三行任务列表、详情四段、搜索与共享 bucket、动作前置、Workspace 与 Provider 成本未观测状态、Master/Worker 分栏、i18n/theme、真实 Chromium、Executor 生命周期独立；独立 Runtime/Cost Lab 主导航已退役 |
| Runtime Auto-Learn | [ADR-053](decisions/ADR-053-runtime-auto-learn-compatibility.md)、[WEB_CONSOLE.md](WEB_CONSOLE.md)、[验收报告](reports/operations-console-runtime-auto-learn-20261123.md) | `IMPLEMENTED / TARGETED`：静态 fingerprint 证据、授权零模型探针、Provider/Billing scope 分隔、Candidate Report；真实 Provider/Manifest 提升未运行 |
| Executor Wake | [ADR-051](decisions/ADR-051-executor-wake-delivery.md)、[ADR-059](decisions/ADR-059-owner-binding-and-installed-auto-wake.md)、[Preview.16 real E2E](reports/preview16-real-host-e2e-20261124.md) | `PASS — REAL`：无 `wake-policy.json`/Owner Grant/模型匹配/loaded-idle 前置门禁；安装即接受 Auto Wake（默认开启，可关闭），单次官方 Queue；`web_notify`、ACK、`turn_started` 与 Master Accepted 分离；真实 Host 已观察到 Queue 触发的原 Thread 新 Turn 与原生 MCP 回读 |
| Async Master Handoff | [ADR-052](decisions/ADR-052-async-master-handoff.md)、[PR 6 report](reports/async-executor-pr6-20261122.md)、[Master Skill](../plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md) | `PASS — REAL LIFECYCLE / SKILL ADHERENCE NOT_RUN`：Scope 与 Handoff 分离；可靠受理后结束 Turn/停止轮询；loaded/idle Wake 后 Master 生命周期独立验收真实通过；真实模型 Skill 遵循率、严格 C/D 与 Desktop fully exited 仍 `NOT_RUN` |
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

当前 Preview 候选身份为 `2.0.0-preview.18`。`package.json`、`package-lock.json`、两份插件 manifest、MCP server version、固定 Official Host/BOM 与图标资产必须来自同一最终候选；合并到 `preview` 本身不创建 Tag、GitHub Release 或 Stable 支持声明。发布支持范围仍限定为 Windows x64、Node.js `24.16.0` 与 ZCode Desktop `3.18.2.10443`，其他安全安装按 ADR-054 运行但兼容性保持未验证。Preview.18 在既有独立 Executor、Thin MCP、Owner Binding、Auto Wake 与 Async Master Handoff 之上加入 ADR-064 启动能力整改、用户授权清理、精确身份锁恢复与 Result content digest 合同；SQLite v14 仍是唯一当前 Schema。Provider、折扣或 Start Plan 能力不因合并自动提升。旧 JSON/CLI 生产链退役决策见 [ADR-029](decisions/ADR-029-legacy-runtime-retirement.md)。

Async Executor PR 2–6 已通过 PR #131 合并至 Preview，并由 PR #133 发布为 Preview.14 Release commit `8d58e9e3`；合并后 CI `45130689135` 通过。历史候选 `c75c3433` 的 1060 项本地完整回归、4/4 注册压力矩阵、生成物与插件校验仍只属于该提交。隔离 Host 真实完成 loaded/idle trusted-local Queue、新 Turn、Native MCP Result readback、Result digest、Cleanup/Release、Master 生命周期独立验收与 Desktop Visible；严格 C/D、Desktop fully exited、Official Runtime provenance 和非空工程交付仍为 `NOT_RUN`。历史失败与 readback 诊断保留在 [trusted-local evidence](reports/trusted-local-wake-20261123.md)。

ADR-032 已接受且已在 Preview.5 实现“现有 Worker 内官方 Host”。ADR-033 的账户 refresh 协调、ADR-034 的正常 Cleanup 复用和 ADR-035 的平台选择由固定上游 patch 与同一 Worker 实现。ADR-037 已接受“官方 Host 拥有认证、Bridge 不维护第二套凭据/身份系统”的目标；Preview.6 已实现该接线。Preview.6/Preview.7 历史路径上的真实 Coding Plan 完整 E2E 和 Start Plan 核心功能路径曾通过；但 2026-11-19 统一安装版 Runtime 的 Start Plan 真实 Entitlement/E2E/Billing Observation 尚未运行。历史 Start Plan 完整 E2E 因 Workspace 内 PowerShell cache 保持 FAIL。Desktop 3.18.0/3.18.1 保持 `NOT_VERIFIED`，不得写成 PASS 或不兼容。

ADR-038 以已发布的 Preview.6 为冻结基线，保留 SQLite/Worker/官方认证与 Runtime 核心，删除旧 3.18.0 Runtime 分发资源及已经退出的外围功能，并修正 Usage、Task context、Events summary、Recovery 说明、CI 分层和生成物 Freshness。Preview.7 已实现该决策并进入发布验证。

Preview.7 继承 Preview.6 固定 ZCode `3.18.2` / `fec975905a2abd4c07e35c40d51fa097a2258ec9` 与 AppServer `0.17.1`，有序 patch 集可从固定源码 HEAD 重放并生成同一源码树。2026-11-19 的集成分支在此基础上将 Model Catalog、Coding Plan、Start Plan 与其他受支持 Provider 接入同一安装版 AppServer Session Factory，并移除打包 AppServer Runtime；Final Closure 增加了基于 Runtime 实际选择的动态 capability gate 与生产 Runtime Auth fail-closed。Start Plan 新 Runtime 的真实 E2E 和倍率验证随后单独执行，未通过时不得合并。Windows x64、Node `24.16.0` 的认证测试、Host/native 加载、clean install、签名 runtime host smoke 以及带代表性数据的 Preview.5 → Preview.6 → Preview.5 隔离升级回滚已经通过。六个 `@napi-rs/keyring` native closure/license/metadata 文件受 BOM/hash 校验；Windows helper 使用来自官方 Desktop `3.18.2.10443` 的有效 Authenticode 文件，Owner 已确认再分发权利，Fresh Rebuild 不再是门槛。跨机器制品复现、Desktop 3.18.0/3.18.1 实机矩阵、真实其他 Provider E2E、真实 OAuth refresh 和一般 Desktop Main 独立性仍未验证；前两项与真实 refresh 风险仅按 Owner 裁决接受于 Preview。

历史 Companion 研究保留原正文，但顶部“历史/被 ADR-032 替代”的适用性说明优先。旧官方 Host `ASTRA_REVIEW.md` 正文只覆盖更早候选；Preview.4 的 `APPROVED / PR_READY: YES` 结论来自 [ASTRA_REVIEW_CURRENT.md](research/zcode-official-host-integration-v1/ASTRA_REVIEW_CURRENT.md)。Preview.5 增加 PR #85 的 R7 集成、v14 兼容迁移与 Administrative Recovery 修复。

当前事实放 `docs` 顶层，设计取舍放 `decisions`，研究放 `research`，一次性交付放 `reports`，历史放 `archive`；草稿放已忽略的 `docs/_draft`。CHANGELOG 由 release-please 维护，不手改。
