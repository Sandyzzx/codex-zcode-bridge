# 官方 Host 集成：架构冻结核对报告

> Status: RESEARCH — 记录文档交付和只读核验；正式决定为 ADR-032。
> Date: 2026-11-11，Asia/Shanghai。
> Freeze baseline: `372e90622772b070357a278f1da3dea58fa42dee` / tree `9a0799b537b9b81af396f2fd45e39a00e7c8f295`。
> Branch: `codex/official-host-architecture-freeze-20261111`；独立工作区 `D:/codex-zcode-bridge/.run/official-host-architecture-freeze-20261111`。

## 交付结论

Owner 已明确授权方案 5 的架构冻结，已新增 [ADR-032：现有 Worker 内官方 Host](../decisions/ADR-032-existing-worker-official-host-integration.md)，状态 **Accepted**。它仅接受目标拓扑、职责、固定制品策略与禁令，不宣称实施或能力完成，也不授权 POC。

目标为 Bridge Host/Core → Existing Worker → CodingAgentAdapter → 内部 Upstream Binding → 官方 Agent Service/ProcessManager → 官方 AppServer（AgentRuntime）。不新增 Companion 服务、Companion IPC/业务数据库、平行 RuntimeAdapter、共享 AppServer Pool 或第二套任务/恢复系统。将来如有 ABI、账户共享或性能实证，只能经新 ADR 重新审查。

## 最新 Preview 与工作区核对

| 检查 | 结果 |
|---|---|
| 开始项目根 / master | `D:/codex-zcode-bridge` / `aabbb0a959ee234508c62731ed5122f28dfcf5b0`，有既有 WIP |
| 本地 preview / origin/preview | 均为 `372e90622772b070357a278f1da3dea58fa42dee` |
| 远端 preview | `git ls-remote --heads origin preview` 返回相同 SHA |
| `0b70edbb` 之后提交 | `b3a3bf42a436e074d82e9e5c975a21c352e32dc3`（分支工作流）、`372e90622772b070357a278f1da3dea58fa42dee`（PR #77 merge） |
| 新增提交影响 | 只改 AGENTS.md 八行双分支工作流，不改变 Worker/Adapter/认证/清理代码；不要求重开拓扑结论 |
| 独立工作区 | 经不存在性检查后从最新 origin/preview 新建临时 codex 分支；未切换原 master/preview 工作区 |
| ADR 编号 | 当前编号最高 031，未占用 032；不填用历史保留的缺号 |
| 已阅读输入 | Astra REVIEW 和四份 Owner 架构收敛报告；当前 ADR/索引/架构与 Preview 工作流 |

未 fetch/reset/rebase/stash 或清理任何原有工作区；没有提交、push、PR、merge、tag 或 release。新增本地临时分支与工作区是本任务明确授权的准备动作，不是发布。

## 冻结与未冻结合同核对

| 项目 | 冻结结果 |
|---|---|
| Worker/Manager/SQLite/CodingAgentAdapter | 原有接口、Authority 和执行壳保留；具体官方接线留待实施 |
| 正常 Runtime 所有权 | 官方 ProcessManager 独占 AppServer/helper；Bridge 保留 Worker 管理和身份绑定异常兜底 |
| 并发 | 现有 Capacity、路径、Claim、Hold、Recovery、Cleanup、Release 合同保留；不接受整任务账户锁来降低并发 |
| 数据 | 无新业务库；官方 Session/必要辅助存储不能成为第二 Task Authority |
| 制品 | 固定源码/lockfile、匹配 Host/AppServer、Node/native/helper/资源；不依赖 Desktop 安装目录/Main 作为长期条件 |
| 新路径能力 | 未构建、未运行；Accepted 不等于 3.18.0 最小 Host、ABI、账户或 Cleanup 映射通过 |
| ADR-030 | 文件和生产实现未变；Preview.3 单次任务权威 verdict、Private Lease/HANDLE/ACK 继续有效 |
| 账户和 Cleanup 两项草案 | 仍在研究目录，Proposed only；未分配正式 Accepted 编号，未替代生产合同 |
| 实施/POC授权 | 本轮没有；[POC-1 计划](../research/zcode-official-host-architecture-freeze-2026-11-11/POC_1_ENTRY.md) 需另行授权 |

## 文档变更清单

共 **12 份 Markdown 文档**：4 份既有概览/索引修改，8 份新增。5 份冻结前研究输入原本只在主工作区未跟踪目录中，为保证本独立分支引用完整而带入；不修改原文件，其副本只加适用性说明，研究正文逐字保留。

| 文件 | 动作/用途 |
|---|---|
| docs/decisions/ADR-032-existing-worker-official-host-integration.md | 新增正式 Accepted 目标决策 |
| docs/decisions/README.md | 新增 032 与 Proposed 草案/POC 路由 |
| docs/ARCHITECTURE.md | 保留当前实现，新增独立目标章节 |
| docs/PROJECT_STATE.md | 区分目标已接受与能力未交付，移除 Companion 仍为目标的歧义 |
| docs/README.md | 更新架构冻结/研究/POC入口 |
| docs/research/zcode-companion-independent-review-2026-11-11/REVIEW.md | 带入历史研究，仅增适用性说明 |
| docs/research/zcode-companion-owner-architecture-convergence-2026-11-11/OWNER_ARCHITECTURE_DECISION_REVIEW.md | 同上，旧 candidate 表述作为历史保留 |
| docs/research/zcode-companion-owner-architecture-convergence-2026-11-11/PREVIEW_BASELINE_DELTA.md | 同上，保留完整增量记录 |
| docs/research/zcode-companion-owner-architecture-convergence-2026-11-11/SOURCE_ARTIFACT_BOUNDARY.md | 同上，保留制品/ABI未知项 |
| docs/research/zcode-companion-owner-architecture-convergence-2026-11-11/ADR_PROPOSALS.md | 同上，明确两项 Proposed 不被架构冻结升级 |
| docs/research/zcode-official-host-architecture-freeze-2026-11-11/POC_1_ENTRY.md | 新增下一阶段范围、输入、成功/停止标准 |
| docs/reports/2026-11-11-official-host-architecture-freeze.md | 本报告 |

## Git diff 与复查方法

完整 [Git diff 文件](../../.run/architecture-freeze-evidence/changes.patch) 位于本工作区已忽略的项目内证据目录，包含 `git diff --binary -- docs` 和对每个新增文档的 `git diff --no-index -- /dev/null <file>` 等价输出；生成时 Windows 使用 Git 的 NUL 输入。未 git add，也未修改 index 来让未跟踪文件出现在普通 diff 中。该 patch 是本地复查产物，不是发布制品。

普通 `git diff --stat` 只显示四份 tracked 修改，不包含八份未跟踪文档；应结合本表、`git status --short --untracked-files=all` 和完整 patch 阅读。历史正文大部分新增行来自带入输入，不能当作本轮新架构设计代码量。

必要复查：`git diff --check`、新旧正式 ADR 的零改动核对、所有新增/修改文档本地目标和行号检查、Markdown fence/空白/编码检查、五份研究副本去掉适用性说明后与原文比较、原主工作区 11 个 WIP 文件 SHA256 比较。没有通过 staging、提交或构建生成 diff。

## 尚未解决的问题

1. 官方 3.18.0 最小 Host 的真实构建与运行，及最小组合的副作用/辅助存储范围。
2. Node/native/helper/动态资源闭包。Bridge 实际 Node gate >=24.16.0 <25；共同24.16.0只是候选，不是ABI验收。
3. 官方账户 profile 供给、刷新/失效、同 profile 多 Worker 并发；不能用 POC 单活代替产品并发证明。
4. 可持久、可恢复的官方 Job 事实导出及新 Bridge Cleanup Proof/验证器映射；dispose、根退出、Job empty、Worker退出、Cleanup、Release不能合并。
5. 实际制品 BOM、许可、schema/credential/backend兼容与数据回滚。
6. 真实 Start Plan 的独立账户能力。当前安装版历史真实证据不覆盖新源码 Host；本轮真实请求为零。

## POC-1 的单独进入条件

Owner 另行批准后，先核实届时 Preview、固定输入/工具链/路径/副作用和允许的依赖构建，再在隔离研究 Worker 中验证真正3.18.0官方服务+匹配AppServer/helper，全部模型请求指向loopback Mock。

最小场景为装配、create/model/单次submit、stream、官方Read及二次Mock请求、cancel、关闭、顺序resume和一项故障反例。必须保留实际制品身份、资源归属、原始实验记录和未验证项。拿不到Job持久证据时可报告Runtime关闭，但不能给完整Bridge Cleanup/Release PASS。

若需真实账户/设备数据、不可控副作用、ABI冲突、大段官方核心补丁、失去进程归属或需要绕过当前合同，应停止对应步骤、保留事实并提交Owner；不得自行引入服务/Pool/Broker/新状态机。完整计划见POC-1文件。本轮不执行。

## 验证与最终状态

文档引用/格式、历史正文保留、改动范围、原WIP和Git状态做静态核对；产品构建、typecheck、npm test:affected/T0、完整测试和所有Runtime实验均 **NOT_RUN**。原因是Owner本轮只允许文档变更和只读验证，明确禁止构建/POC；未运行会重建bundle的T0流程。文档检查不称为产品测试PASS。`STRESS_TESTS_NOT_APPLICABLE`。

| 本轮实际核对 | 结果 |
|---|---|
| 12份变更文档，133个本地文件/行号引用 | 0坏目标；未检查远端网页或Markdown锚点 |
| Markdown fence、尾随空白、UTF-8替换字符 | 0错误；git diff --check通过 |
| 5份带入研究正文 | 去掉新增适用性说明后，与原文件内容完全相同 |
| 主工作区11个原WIP文件 | SHA256全部不变；master/preview/origin-preview指针保持原值 |
| 新工作区src/plugins/package/既有正式ADR | 无变更；原Preview和官方源码工作区仍干净 |
| Git index与提交 | 未staging；HEAD保持372e9062，没有新commit |

```text
ARCHITECTURE_DECISION: ACCEPTED
TARGET: EXISTING_WORKER_OFFICIAL_HOST
INDEPENDENT_COMPANION: REMOVED_FROM_TARGET
NEW_IPC: NOT_REQUIRED
NEW_TASK_DATABASE: NOT_REQUIRED
EXISTING_WORKER_CONCURRENCY_CONTRACT: PRESERVED
ACCOUNT_AND_CLEANUP_ADRS: PROPOSED_ONLY
POC_EXECUTED: NO
PRODUCTION_CODE_CHANGED: NO
OFFICIAL_SOURCE_CHANGED: NO
SQLITE_CHANGED: NO
EXISTING_ADR_030_CHANGED: NO
REAL_ACCOUNT_REQUESTS: 0
REAL_MODEL_REQUESTS: 0
STARTPLAN_REQUESTS: 0
BILLING_REQUESTS: 0
COMMIT_CREATED: NO
PUSHED: NO
PR_CREATED: NO
MERGED: NO
RELEASED: NO
```

停止于本次文档冻结交付，保留独立工作区、临时分支和全部WIP，等待POC单独授权。
