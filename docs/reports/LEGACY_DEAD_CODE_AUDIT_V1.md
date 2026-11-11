# Legacy & Dead Code 审计 v1

> Status: RESEARCH
> Date: 2026-11-11
> Verified against: `52015d12f37011f4d389e07941c31491457611ef`（审计基线）；本轮各批次为独立候选，尚未合并。
> 范围：仓库受跟踪资产、入口/依赖图、文档引用、测试清单、Skill 与合成回归；不读取或操作生产数据库、账户凭据或设备身份。

## 结论与边界

完成仓库资产盘点，执行三类有证据的清理：归档四份旧 Release Notes、修正失效文档和 Skill 指引、删除一个随 JSON cutover 退役但遗漏的 durability helper。未删除任何测试或 npm 依赖。当前 SQLite Authority、Start Plan/Coding Plan 认证、多轮 Runtime Auth、Result/Cleanup/Release、v13 离线升级的生产实现保持原字节。

候选已通过 Windows 全量 889 项（888 PASS、1 既有 SKIP、0 FAIL）及 SQLite Stress 3/3。后续 Skill 文案通过自己的 T0 和 7/7 合约回归。不能据此宣称所有历史资产都已失去价值，也不能宣称 Test Impact 的传递依赖选择已完备：发现一个既有 Auth→Host 组合测试漏选，作为后续独立测试映射修复候选保留。没有为了清理数量而重建执行器或调度器。

## 基线身份与现场保护

| 对象 | 核对结果 |
|---|---|
| 远程 preview | `52015d12f37011f4d389e07941c31491457611ef` |
| 远程/本地 master 与 Stable 1.6.0 Tag | `aabbb0a959ee234508c62731ed5122f28dfcf5b0` |
| Preview.3 annotated Tag | `2662e7e7ab9d1d1dac44e8de7c5b1b98c95378a4` → `bfd3406fe2197a313ff1d34cd57fde79f5f95ff1` |
| PR #71 / #72 / #73 | 均已合并至 preview；merge 分别为 `434d874c` / `bfd3406f` / `52015d12` |
| 开始时 Open PR | Dependabot #42、#38、#37、#36；未修改其分支 |
| 基线 CI（历史、非本轮测试） | [42953705900](https://github.com/Sandyzzx/codex-zcode-bridge/actions/runs/42953705900)，exact baseline SHA，success |
| 审计 Worktree | `D:\codex-zcode-bridge\.run\legacy-dead-code-audit-20261111` |

主工作区位于 master，已有 `.gitignore`、`test/helpers.ts`、`test/test-impact-map.json`、`$null` 和两份本地生产预检/AB 报告 WIP；保持原状。未清理旧 Worktree、Branch、stash、Git pack 或未知引用。所有新产物都在项目内部。`.run/audit-evidence/` 保留本轮工具辅助证据；旧报告提及的私有归档没有被删除或复制到公共仓库。

## 完整资产清单与方法

[ASSET_INVENTORY.csv](legacy-dead-code-audit-20261111/ASSET_INVENTORY.csv) 对基线 **417 个 Git 资产**逐文件记录 path/category/bytes/LOC/decision/evidence/Git blob。[STATIC_EVIDENCE.json](legacy-dead-code-audit-20261111/STATIC_EVIDENCE.json) 记录入口、实际 esbuild source inputs、Bundle 哈希和未变合同。清单是冻结基线的静态证据，不是新建的测试调度清单。

| 类别 | 文件数 | 说明 |
|---|---:|---|
| src | 108 | 含 TS/MJS、声明与 SQL，不是全部运行时模块 |
| test | 93 | 85 个 `.test.ts/.test.mjs` 加 8 个支持/映射文件 |
| scripts | 21 | 正式构建/执行器与手工研究探针 |
| docs | 133 | Markdown、历史实验脚本、JSON 证据等 |
| plugin | 40 | Manifest、Hook、Skill、Bundle、vendor、许可证及图标 |
| 根文件与其它配置 | 22 | README、Release Notes、工作流、TS/package 配置等 |

检查正式入口：MCP main、stdio Host、Worker、Core export、Thin Waiter、offline upgrade、admin CLI、token CLI、browser backend；核对静态 import、字面量动态 import、公共 exports、Manifest/Hook/package 脚本、构建和测试引用。八个编译入口的 esbuild 图包含 94 个 src inputs；类型消除或独立实验不在该图，不能单凭缺席就删除。对异常候选再逐项追溯 Git 历史和实际职责。

## 清理决策矩阵

下表是可行动候选与容易被误判的资产；其他逐文件分类见 CSV。`KEEP/NEEDS_REVIEW` 不授权删除。

| Asset / Category | Current Usage | Historical Value | Replacement | Evidence | Risk | Recommendation | Validation |
|---|---|---|---|---|---|---|---|
| 四份 `RELEASE_NOTES_v1.3.0-rc.*.md` / 文档 | 已非产品入口 | Tag、旧安装与故障追溯 | Preview.3 README/CHANGELOG | Tag、GitHub Release 列表、rc.2/3/4 supersedes 正文 | 低，旧链接/说明误导 | ARCHIVE，保留原正文 | 原/新 Git blob 相同、链接检查 |
| ARCHITECTURE / SHARED_CORE / ZCODE_RUNTIME / 文档 | 当前权威但仍称本地1.6候选，启动参数落后 | 保留合同历史 | 当前源码与已发布 Preview.3 | package、共同 launch helper、PR #71/#72/#73 | 中，不能反向改合同 | REFACTOR，仅校正既有事实 | T0、源码/生成物哈希 |
| ADR-001/030/031 与索引 / 文档 | 旧 CLI 保留、二次 Billing 表述过时 | 决策原文应保留 | ADR-029 / 已批准任务级 verdict | 当前 PROJECT_STATE、PR #71、Auth 合成测试 | 中 | REFACTOR，加适用性注释，保留原历史正文 | 无生产合同修改、引用检查 |
| 2026-09-27 headless Start Plan 记录 / 文档 | “仅 Coding Plan 可用”已失效 | 当时验证码/认证限制证据 | 当前 PROJECT_STATE | 日期、已认证版本和当前产品说明 | 低 | ARCHIVED 标注，不删除历史证据 | 链接、支持边界复核 |
| 两处研究源码链接、两处 R3 私有证据链接 / 文档 | 前者相对层级错误，后者目标不在 Git tree | 历史验收结论保留 | 正确相对路径/私有文件名说明 | 本地存在性、旧报告归档范围 | 低 | REFACTOR，仅修路径/可见性说明 | 检查器坏链接 4→0 |
| `src/runtime/durable-file-system.ts` / 源码 | 无生产/测试/公共 Core 调用 | 曾服务 JSON cutover/quiescence | ADR-029 退役该整条执行器 | `f27f7afc` 的两个原消费者、当前全仓引用/入口图 | 低 | SAFE_TO_DELETE，删除 201 行 | 全量、fresh Core 无遗留 JS/DTS、Bundle 不变 |
| `test/test-impact-map.json` 中上述路径 / 配置 | 指向已删除模块 | 无独立合同价值 | 同批源码删除 | map diff 仅删除此一行 | 低 | SAFE_TO_DELETE，删除一行映射 | 既有 selector/manifest/runner 对账，全量 |
| `json-history-result-exceptions.*` / 源码 | Store 对历史 receipt/归档身份的校验 | 保护已存在的 SQLite Authority | 无 | Store import、历史例外测试 | 高 | KEEP | 全量历史校验与 v13 升级 |
| v13 Schema / upgrade CLI / runtime roster / admin / 源码 | 离线升级、恢复与安全验证 | 旧库安全与事实完整性 | 无 | 入口图、shipped standalone upgrade、验证器 | 高 | KEEP | 升级与 admin/Cleanup/Release 回归 |
| `process-lock` / `atomic-rename` / DirectWorkspaceProvider / 源码 | Settings/Ledger/公共 Core 仍使用 | fork 兼容合同 | 无 | imports、`src/core.ts`、各自回归 | 中高 | KEEP | settings、Ledger、Core、workspace 测试 |
| `src/observability/thread-token-usage.ts` 与测试 / 源码 | 独立 observer，未接入当前 Host，也未由 Core 导出 | 16 个协议/未知值/重放实验场景 | Rollout reader 解决不同来源问题 | 独立研究报告、测试；非同一输入协议 | 用途未来决策不确定 | KEEP/NEEDS_REVIEW，不能删其测试后称覆盖不变 | 本轮 16 项仍在全量中 |
| `src/sqlite-candidate/wp6c/fake-result-adapter.ts` / 源码 | 私有测试能力通过 Worker 正式组合链使用 | 生命周期注入验证 | 无 | Worker 的受限 import / driver test capability | 高 | KEEP，目录名不等于死代码 | 真实进程 Claim/Result/Cleanup/Release 测试 |
| scripts 手工 token、Magpie、resource 探针 / 脚本 | 不在自动 CI；显式入口供研究复现 | 版本/协议/资源原始研究 | 无已证实等价替代 | CLI 入口、研究引用、无执行调度 | 部分安装版/API可能过期，不确定 | KEEP，未运行会产生真实请求的探针 | 静态检查，不调用模型/账户 |
| Start Plan、Coding Plan、Frames、Recovery 多层测试 / 测试 | 单元、Adapter 与跨进程职责不同 | 崩溃/ACK/重放/敏感信息边界 | 无等价单一替代 | 85 文件清单、组合与协议区别 | 高 | KEEP，无证据支持删除重复测试 | 全量、独立压力 |
| Skill monitoring reference / Skill | 仍要求旧 JSON full_request 与错误 questions 位置 | 无需继续指导当前调用 | SQLite `details.params` | `SqliteLifecycleMcpAuthority.getEvents()` | 中，错误审批输入 | REFACTOR，移除无效路径指引 | 原 Skill 7/7、引用 0 坏链 |
| Skill auto 范围 / Skill | 原文允许一般授权任务自动选策略 | Master/Worker 边界仍有效 | Owner 本轮只读代码 auto 约束 | 本任务明确要求 | 中，属指导边界 | REFACTOR，写任务明确 whole_task/staged | 原授权、审批、停止断言保持 |
| 七个直接 npm 依赖 / 依赖 | 三个运行依赖，四个开发依赖都有调用 | 构建/类型与许可 | 无 | import、构建脚本、TS types、测试 MCP client | 中高 | KEEP，移除依赖 0 | npm ci、build、plugin validation |
| shipped Bridge/Worker/browser/Schema / 生成资产 | 实际安装制品 | 离线启动与升级 | 源码正式重建 | build-plugin、validate-plugin、Manifest | 高 | KEEP，不手删生成文件 | 11 项 Git 归一内容/哈希完全相同 |

### Release Notes 专项结论

`rc.1` Tag peel 为 `be06ce3c480cee6c71cde00e91a6137ad67648e3`；`rc.2` 为 `f2bf7a5f6f23eed90c1f7aea314a06aca27eb111`；`rc.3` 为 `cab82a918514c6329f4982477b7eb0e8ada6cc01`。核对本地和远程 Tag。GitHub 当前公开 Release 列表包含 `rc.3` 和正式 1.3.0；未列出 rc.1/2，也没有 rc.4 Tag/Release。

这些文件含明确 Marketplace 安装命令，但“用户是否实际安装过、是否曾有后被删除的 Release”不确定。不能将目前缺少 Release 推导为从未发布。因此全部归档到 `docs/archive/release-notes/`，四份原始正文 Git blob 原样保留；不删 Tag、不改 CHANGELOG，不把历史 Windows Schema/Recovery 缺陷记录丢弃。

### 测试/依赖的保留与后续问题

清单对账：85 个 executable source files 全在 88 项 manifest 中（另三项为 Fixture）；Windows 自动功能文件 84，压力文件 1；Linux 的既有 Windows-only 排除保持。原 selector 测试验证 manual/fixture 不会误跑及实际 `--list` 一致性，均通过。

**已复现的既有漏选**：以 `changedFiles: ["src/runtime/start-plan-production-auth.ts"]`、`platform: "win32"` 调用原 selector，结果为 TARGETED，仅选择六个文件，不选择 `mvp-real-adapter.test.ts`，尽管后者含真实 Host→Issuer→Worker 合成认证场景。目录完整性不等于依赖完整性。本轮删除 map 一行触发 FULL_SUITE，实际运行覆盖了该组合链，当前候选验收未漏跑；建议后续单独补 `provider-catalog` 对组合测试的映射及选择断言，不在清理中扩展 CI 分层架构。全局 Test Impact 完备性结论为 PARTIAL。

七个直接依赖均有用途：MCP server 用于 stdio/MCP；Playwright 是 browser vendor 来源；Zod 用于 MCP/browser schema；MCP client 用于协议测试；esbuild 构建 Bundle；TypeScript 编译/清单 AST；@types/node 提供 Node types。仓库使用 package-lock，无 pnpm-lock。`npm audit` 当前返回三项 high（MCP client/server、Zod）；本轮未进行升级或 `audit fix`，不将有实际用途但有 advisory 的依赖归为死依赖。已存在的 Dependabot PR 保持原状。

`docs/testing/test-inventory.json` 是已有静态/历史索引，其中保留旧依赖记录；不驱动执行，不因删除一项 helper 就重写该历史生成物。工作流仍保持 Windows/Ubuntu Verify 与独立资源压力边界，未删除 Job 或放宽 timeout。旧 Hook 对 mode 的提示、历史研究探针运行版本等超出“死资产删除”的语义差异保留为 NEEDS_REVIEW，未修改配置执行逻辑。

## 批次、验证与交付

三个独立候选均直接基于同一 preview 基线，不互相依赖，不触碰 master：

| Batch | 内容 | 验证 | 交付 |
|---|---|---|---|
| A | Release Notes 归档、失效说明/链接、审计报告与基线清单 | T0；Markdown 链接；原正文 blob 核验 | 独立文档 Draft PR |
| B | 删除 durability helper 及一行失效映射 | T0 + Windows 全量 889 / 888 PASS / 1 SKIP；Stress 3/3；Bundle freshness | [PR #74](https://github.com/Sandyzzx/codex-zcode-bridge/pull/74)，head `ba9bddcffc5f1bb7e3bad67718e1e1152c6191eb` |
| C | 测试/工具审计 | 无足够依据删除测试/脚本；只列后续映射问题 | 无空 Commit/空 PR |
| D | SQLite 交互指引与只读 auto 范围 | 独立 test:affected，Skill 7/7，0 SKIP；T0 | [PR #75](https://github.com/Sandyzzx/codex-zcode-bridge/pull/75)，head `12714763d40ef16a07b2dc3b0df8583173659c57` |

| 实际执行 | 结果 / 时间 |
|---|---|
| npm ci --ignore-scripts | PASS，隔离 Worktree；未改 Lockfile |
| npm run test:affected -- --base HEAD（B 修改尚未提交时） | FULL_REGRESSION_PASS，889 / 888 PASS / 1 SKIP / 0 FAIL；Node test 1,242.740 s |
| typecheck / build / validate:plugin / diff-check | 均由 test:affected T0 实际执行通过 |
| npm run test:stress | 3/3 PASS，11.722 s；本任务明确要求的最终独立资源门，不是 Skill/文档变更触发 |
| Start Plan/Coding Plan/Worker/Result/Cleanup/Release | 包含于上述全量；Auth 重复/并发交付、Host fake Billing、Coding key、R1–R5 均运行 |
| Skill test:affected | 7/7 PASS，0 SKIP；0.156 s 是 Node test 时间，T0 时间另计 |
| 文档最初 T0 | PASS；dry-run/NO_TESTS_APPLICABLE 不计作执行测试 PASS |
| Bundle consistency | 11 个生成/资源文件 Git 归一字节与基线一致；Core fresh build 不再产生 helper JS/DTS |
| 本地 Markdown 目标与 Skill reference | 基线坏目标 4；修正后 0；只检查本地目标，不声称外网链接或所有 Markdown anchor 已验证 |
| Ubuntu 本地 / 真实模型 / Billing / OAuth | NOT RUN / 0 / 0 / 0；平台验证由新 PR CI 另报 |

全量与压力结果最初由工具会话产生，关键计数和耗时已固化于 STATIC_EVIDENCE；未伪造整份原始全量日志。Skill 与后续文档门禁日志保留在项目内 `.run/audit-evidence/`。不把历史基线 CI 或第二次 T0 当作本轮完整全量替代。

## 实际减少与未证明收益

| 指标 | 变化 |
|---|---|
| 删除生产文件/物理 LOC | 1 / 201（Git diff 口径） |
| 删除配置行 | 1，失效 impact entry |
| 归档文件 | 4，原正文内容不变；根目录减少四份候选安装说明 |
| 删除测试/损失行为覆盖 | 0 / 无因删除造成的覆盖损失 |
| 移除直接依赖 | 0 |
| 简化模块 | 1；不再编译旧 MoveFileEx/FlushFileBuffers helper |
| 简化脚本 | 0；手工研究探针有追溯用途，未删除 |
| Bridge/Worker/其它生成 Bundle | Git 归一字节变化 0；helper 原本不进入 shipped runtime graph |
| 全量耗时变化 | UNKNOWN：本轮没有对同机同条件旧版本重新计时，不能宣称节省百分比 |
| 维护复杂度 | 删除一个无人调用的 Windows/Posix durability 实现；去掉无效文档路径；不声称降低运行时性能成本 |

仍保留历史 acceptance/research、ADR 原文、receipt/JSON archive validation、v13 Schema/离线复制、admin、Recovery、私有认证和多层生命周期测试。它们的价值是历史事实或安全合同，不以热路径使用频率判断可删。

## Owner 复核门与回滚

各 Batch 独立 Commit/PR；不自动合并。A/D 是文档或 Skill 指导候选，B 删除已退役内部实现。回滚用独立 revert 审核，不 reset、不改历史、不操作数据库；没有数据迁移可回滚。新 PR 的 exact-head CI 与 Review 必须完成后才讨论合并。

本报告证明的是有限清理候选和所列验证。Test Impact 传递依赖漏选、依赖 advisory、研究探针新版本兼容性仍是明确未关闭项；不宣称“全仓没有任何死代码/风险”。生产 SQLite、凭据、Device ID、旧 Hold、Stable/master 保持原样，真实 Billing/模型请求均为 0。
