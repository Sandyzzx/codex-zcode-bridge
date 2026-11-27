# Preview.6 Post-Audit 架构减法与正确性整改报告

> Status: RESEARCH
> Last updated: 2026-11-15
> Verified against: `265b705b4572a8352e7a955099054289a3f0dcfd`

本报告记录 ADR-038 的一次性实施证据。历史审计、E2E 失败与发布结论保持原样；本分支只创建 Draft PR，不合并、不打 Tag、不发布。

## 1. 基线与实现 HEAD

- Repository：`Sandyzzx/codex-zcode-bridge`
- 冻结基线：`codex-zcode-bridge-preview-v2.0.0-preview.6`
- Base branch：`preview`
- Base commit：`545c02f745a4e2ab38a1fa3c31880ac80b84a310`
- Worktree：`D:\codex-zcode-bridge\.run\preview6-post-audit-remediation-20261115`
- Branch：`codex/preview6-post-audit-remediation-20261115`
- 验证候选 HEAD：`265b705b4572a8352e7a955099054289a3f0dcfd`
- 验证候选 tree：`5af528d8f56d113146886f4cd09c46994cd9f3c3`
- 相对 `origin/preview`：ahead `6` / behind `0`
- 平台：Windows x64、Node.js `24.16.0`
- Draft PR：[#96](https://github.com/Sandyzzx/codex-zcode-bridge/pull/96)

实现提交：

1. `f39011a46` `docs: accept preview6 minimum architecture remediation`
2. `7e717621c` `chore: remove obsolete official runtime assets`
3. `60aa49ab9` `refactor: complete preview6 post-audit remediation`
4. `10ee84d42` `test: paginate lifecycle release observation`
5. `19fd1d1be` `fix: stabilize generated artifact line endings`
6. `265b705b4` `fix: normalize generated SQL inputs`

主工作区中既有的 `AGENTS.md` 修改和未跟踪 `$null` 未触碰；所有整改写入独立 Worktree。

## 2. Stage 1–4 完成状态

| Stage | 状态 | 结果 |
|---|---|---|
| Stage 1：Official Runtime 资源减法 | PASS | 删除 3.18.0 固定 Runtime 目录；3.18.2 Host、BOM、Provenance、NOTICE 与官方签名 Helper 保留 |
| Stage 2：正确性与观测修复 | PASS | 补齐 Cache Write Usage；Context 超限显式失败；Events summary 真正合并；Recovery 文档改为生产实际能力 |
| Stage 3：Legacy JSON 与外围功能退役 | PASS | 旧 JSON import/read API、Ledger、人类 Markdown renderer、Rollout Token 采集与 Desktop task-index 镜像退役 |
| Stage 4：CI 与执行效率 | PASS | Fast/Integration/Release 分层、12 文件生成物清单、T0-only、shadow comparison 与跨 Windows checkout 的确定性生成物字节已实现 |

## 3. 实际删除的文件与模块

### Runtime 与外围实现

- 删除 `plugins/codex-zcode-bridge/worker/vendor/official-host/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/` 下全部 15 个文件。
- 删除 `src/ledger/bridge.ts`、`mcp.ts`、`store.ts`、`types.ts`，即 Project Ledger 的独立状态、存储与 MCP 接线。
- 删除 `src/adapters/task-index-sync.ts`；`ZCodeAppServerAdapter` 不再写入官方 Desktop 私有 task index。
- 删除 `src/feedback/renderer.ts`、`src/feedback/template.ts` 与 `src/feedback/codex-master-token.ts`。
- 删除 `src/observability/codex-master-token-cli.ts`、`codex-master-token-usage.ts`、`codex-rollout-token-source.ts`、`thread-token-usage.ts`。
- 删除仅用于旧人工统计或真实 probe 的 `scripts/minimal-real-token-e2e.mjs`、`scripts/probe-codex-rollout-tail-live.mjs`、`scripts/probe-codex-rollouts.mjs`、`scripts/probe-installed-app-server.mjs`、`scripts/real-appserver-token-e2e.mjs`。
- 删除打包 Skill 中的 `codex-master-token-usage.mjs`。

### Legacy JSON 兼容

从 SQLite Store 与 lifecycle port 删除以下旧兼容入口：

- `recordRawJsonArchiveCutover`
- `importJsonAuthoritySnapshot`
- `readMigratedResult`
- `readMigratedEvents`
- `readMigratedArtifact`
- `readMigratedHistoryExceptions`

`json_artifacts`、`migrated_task_results`、`migrated_task_events`、migration receipts 和 Schema v14 表没有被 DROP；仍存在的历史行继续参与字节、digest 和 Schema 完整性校验。

### 生产平台入口

Linux、macOS 与 Windows 非 x64 不再选择实验性直接 Adapter；它们在构造前以 `unsupported_worker_platform` fail closed。direct Adapter 只保留隔离测试注入。

## 4. 新增与删除代码行数

截至验证候选 HEAD，相对 Base：

- Git 全量文本差分：`114` 个文件，`+16,746 / -19,116`。
- 不含 binary 删除中的不可计行内容。
- 全量差分包含 4 个大型生成 bundle、测试 inventory 与历史表测试，不等于生产 TypeScript LOC。
- 生产源码、测试、脚本、生成 bundle 与插件入口合计：`78` 个文本文件，`+2,191 / -11,243`，净减少 `9,052` 行。
- `src/`：`27` 个文件，`+216 / -4,104`，净减少 `3,888` 行。
- `test/`：`24` 个文件，`+625 / -2,214`，净减少 `1,589` 行。
- `scripts/`：`14` 个文件，`+253 / -1,142`，净减少 `889` 行。

GitHub 对二进制删除可能显示更大的 deletion 计数；报告采用 `git diff --numstat` 与文本分组结果，不把二进制字节数当 LOC。

## 5. 分发包大小变化

受控的 `git archive` 插件子树 ZIP 对照：

| 版本 | Bytes | MiB | SHA-256 |
|---|---:|---:|---|
| Base plugin subtree | 17,075,998 | 16.285 | `27734F3B7A5CDFF9C4C8D68861CE29B34A3CC11A72ABE3850F9B90773742FEFC` |
| Remediation plugin subtree | 9,695,143 | 9.246 | `F9B774143B9FE95268A55D9261A81455000398BC5ADA5052B14BEF3D66964157` |
| Delta | -7,380,855 | -7.039 | — |

这是固定输入、同一 `git archive` 方法的受控插件子树对照，不是 Marketplace 或 GitHub Release 最终制品。未执行 Release 打包，因此不能把该差值宣称为最终发布包净变化。

删除的旧 3.18.0 Runtime 文件集合共 `15` 个、`38,816,895` bytes / `37.019` MiB 未压缩。Current 3.18.2 签名 Helper 仍为 `179,608` bytes，SHA-256 为 `C2C8FF5FF28CBDDC4F177C094AA67C322830889612251BD173BAAABC89379AB4`，Authenticode `Valid`，PE `Amd64`。

## 6. 删除的测试与保留依据

随退役功能删除：

- `test/codex-master-token-usage.test.ts`
- `test/codex-rollout-token-source.test.ts`
- `test/codex-rollout-token-tail.test.ts`
- `test/feedback-template.test.ts`
- `test/ledger-bridge-review.test.ts`
- `test/ledger-core.test.ts`
- `test/ledger-mcp.test.ts`
- `test/thread-token-usage.test.ts`

这些测试只覆盖已删除的人类报告、Rollout Token、Ledger 或展示层。Task Status、SQLite Authority、Runtime Events、Usage、Result、Cleanup/Release、Claim、CAS、Recovery 与 Worker identity 测试均保留。

`test/host-and-index.test.ts` 重命名并收敛为 `test/host-contract.test.ts`：保留 Host 启动合同，删除 Desktop task-index 镜像断言。

新增或重写的定向测试包括 Cache Usage 全链、Task Context 边界、Events summary、mixed Legacy/Native v14、integration-only 历史不可查询、完整生成物 inventory 与 CI impact shadow comparison。

## 7. Legacy JSON 停止支持的实际影响

- Bridge 不再导入旧 JSON Authority 快照。
- 不再提供旧 JSON 迁移 Result、Event、Artifact 或 historical exception 查询 API。
- 旧迁移 Task 不再被当作受支持的 SQLite Task。
- 新安装、原生 v14 与 mixed v13 迁移库仍可正常打开；mixed 库中的原生 Task、Result 与 Runtime Event 保持可用。
- 历史表和历史字节不删除，不自动重建，不 DROP，不引入 SQLite v15。
- 用户原有 JSON 文件不由 Bridge 读取、导入、修改或删除。
- 如果现有 v14 文件不满足当前 Schema/digest 约束，仍 fail closed；没有 JSON fallback。

## 8. SQLite v14/v13 数据兼容结果

定向测试覆盖：

- explicit offline v13 copy upgrade 保留所有 row/event/digest 与 source bytes。
- v14 正常打开；裸 v13 继续要求显式升级或现有 Lifecycle Gate 自动升级。
- fresh native v14 Task、Result、Runtime Event reopen 后保持可读。
- mixed migrated + native v14 authority 保留 native Task，旧迁移 Task 不再可查询，同时历史表行数不变。
- administrative abandonment 不转写为 Result 或 Cleanup Verified。
- automatic v13 startup upgrade 保留 occupied Running Attempt、Recovery evidence 与既有 Hold。
- rename/publication 中断可恢复；blocked root 不修改 SQLite bytes 或删除 Hold。

Schema 保持 v14；本轮没有新 migration、DDL 清理或生产 SQLite 写入。

## 9. Cache Usage、Events Summary、Context 的验证证据

### Cache Usage

`test/usage-contract-chain.test.ts` 使用官方结构的安全合成 Payload 验证完整链路：

`cacheReadTokens=40` → `cached_input_tokens=40`；`cacheWriteTokens=0` → 独立可选 `cached_write_input_tokens=0`。Payload 继续经过 Runtime Event、normalize、canonical Result、MCP `taskResultSchema`、SQLite Result commit、reopen 后逐字段一致。缺失保持 `null`，真实 `0` 保持 `0`，source/scope/observed_at/finality/conflicts 持久化。

### Events Summary

`test/events-summary.test.ts` 验证：

- 仅合并同一 Operation/Attempt、无 evidence 的相邻 `model_output`。
- Permission、Interaction、错误、终态、其他事件类型、Attempt 与 evidence 都形成边界。
- 合并行保留最后扫描 cursor/store sequence；`omitted_events` 为实际合并数。
- `max_bytes` 在合并后应用；超限返回 `scan_incomplete` 和可继续 cursor。
- raw-shaped rows 不被原地修改。

`taskProgressPageSchema` 已包含 `omitted_events`，Manager 只在该值大于 0 时输出；raw view 不增加该字段。

### Task Context

`test/task-prompt.test.ts` 覆盖普通、2,500+ Unicode/中文/组合字符、恰好 60,000 字符边界和超限。Context 不再按隐藏的 2,000 字符上限截断；总 Prompt 超过 `MAX_PROMPT_CHARS=60,000` 时抛出 `task_prompt_exceeds_capacity`，包含 actual/max facts，不裁剪 requirements、acceptance criteria 或路径约束。

## 10. CI 实际前后执行时间

历史 PR #95 基线 run [43603288764](https://github.com/Sandyzzx/codex-zcode-bridge/actions/runs/43603288764)：

- Run 总时长约 `13m21s`（`14:08:25Z` → `14:21:46Z`）。
- Windows `Verify` 约 `13m17s`。
- Ubuntu `Verify` 约 `1m25s`。
- Windows/Ubuntu SQLite matrix 分别约 `38s` / `24s`。

本候选首次 run [43698757980](https://github.com/Sandyzzx/codex-zcode-bridge/actions/runs/43698757980)：

- Select impact：`12s`，PASS。
- Fast PR gate：`26s`，PASS；本变更强制 FULL，因此 Fast 只执行 T0，完整回归交给 Release。
- Release Ubuntu：`1m33s`，PASS。
- Integration 与 SQLite matrix：按 impact policy 正确 SKIP；本 `FULL` 变更由 Release 和本地完整功能回归覆盖。
- Release Windows：`13m14s`，FAIL。904 项中 901 PASS、1 FAIL、2 SKIP；唯一失败是 `SQLite preserves JSON workspace semantics and the Host-selected execution worktree` 在 Task 已 `completed` 后等待 `released` 30 秒超时。

该失败在本地无法按单测稳定复现：修复前同一用例连续 `5/5` PASS，相邻两用例 `2/2` PASS，完整 `composition.test.ts` `52/52` PASS。调查同时确认等待器只读取首个最多 200 行 Event 页；Store 与 Recovery 代码已经使用 `nextCursor/hasMore` 遍历分页，但测试 helper 没有，违反 bounded-read API。已把 helper 改为按 `next_seq` 遍历全部页，并保留 30 秒观察边界及原有 Release 断言。修复后相邻用例 `2/2`、完整 `composition.test.ts` `52/52` PASS。

首次 Windows 失败发生在 Release 观察之外的精确生产根因仍为 `UNCONFIRMED`；现有证据不能区分远端资源压力造成的迟发与测试只读首页造成的 false negative。最终 CI 状态以 PR #96 修复后最新 check 为准，不能把 running、absent 或 skipped 解释为成功。

第二次 run [43702985715](https://github.com/Sandyzzx/codex-zcode-bridge/actions/runs/43702985715) 中，分页修复后的完整 Windows 测试已达到 `904` 项、`902 PASS`、`0 FAIL`、`2 SKIP`，Plugin Validation 也 PASS；失败转移为 `check:generated` 报告的 8 个 `.mjs`/vendor 文件。干净 Windows checkout 的隔离复现确认，`core.autocrlf=true` 使生成文件先以 CRLF 落地，而 esbuild 与 npm vendor 输入固定输出 LF。提交 `19fd1d1b` 随后把 12 个生成物声明为 `text eol=lf`。

第三次 run [43704755481](https://github.com/Sandyzzx/codex-zcode-bridge/actions/runs/43704755481) 中，Windows 测试为 `905` 项、`903 PASS`、`0 FAIL`、`2 SKIP`；剩余失败缩小为 4 个 SQL。原因是生成 SQL 的 CRLF 源文件仍被 `copyFile()` 原样复制到 LF 目标。提交 `265b705b` 把同一复制链的 4 个源 SQL 也固定为 LF，并增加生成物和源 SQL 的属性回归测试。

最终候选 run [43706143312](https://github.com/Sandyzzx/codex-zcode-bridge/actions/runs/43706143312)：

- Select impact、Fast PR gate、Ubuntu Release gate：PASS。
- Windows Release gate：PASS。
- Windows full suite：`906` tests，`904 PASS`、`0 FAIL`、`2 SKIP`，`duration_ms=634780.8143`。
- Windows Worker identity、Plugin Validation、12-file generated freshness、`git diff --check`：PASS。
- Integration 与 SQLite resource matrix：按 `FULL` impact policy 正确 SKIP；完整覆盖由 Release full suite 承担。

## 11. MCP/Prompt 优化中未验证的假设

- 未通过当前 Codex Host 的大型 `zcode_result` A/B 证明 Text JSON 是否只用于兼容还是仍被实际读取；因此保留 Text 与 `structuredContent`，32 MiB Result 合同不变。
- 未运行真实模型来比较 Prompt 前缀稳定性和缓存命中；本轮只消除已证实的静默截断与明显的重复展示链路。
- Test Impact Map 已通过当前 selector、executable manifest、shadow selection 和多项域测试，但未被证明是未来所有跨模块依赖的完备依赖图。未知源码、测试基础设施、CI 与核心合同变化仍自动 FULL。
- Linux/macOS 只验证了生产入口 fail closed，没有恢复为受支持运行时。
- mixed v14 测试证明历史字节保留和 native 查询可用，不承诺旧迁移 Task 的业务查询。
- 真实 Coding Plan/Start Plan 模型、Billing、OAuth refresh 与生产 SQLite 本轮没有执行。

## 12. 保留的必要复杂度

- 一个 SQLite v14 Task Authority 与现有 Lifecycle Manager。
- 每 Attempt 独立 Worker、Royal/Launch Claim、generation/revision CAS。
- exact process identity、recorded-tree scan、Resource Facts、Cleanup Digest 与 Release CAS。
- Result、进程退出、Cleanup Verified 与 Release 的分离。
- unknown request acceptance 不盲目重派；Result-less Running Attempt 缺少 Adapter Cleanup Proof 时保留 Hold。
- 官方 ZCode Auth/Billing/Provider/Runtime 所有权与固定 3.18.2 制品。
- 32 MiB Result、MCP Text 兼容面、Attention/Interaction、Browser Host 与 Safety Gate。
- SQLite v13→v14 升级和历史表完整性校验；仅为保留字节正确性，不重新开放旧 JSON 业务查询。

## 13. 尚未完成的 R11–R14 项目

- R11：BOM、产品版本、Runtime 和发布来源的更大范围合并与动态管理保留后续 ADR；本轮只完成删除旧 Runtime 与生成物 Freshness 所需最小调整。
- R12：涉及官方新接口的集成保留后续研究。
- R13：涉及重大 Runtime/生命周期架构变化保留后续研究。
- R14：跨版本动态资源发现、下载、共享 Runtime 或其他大型方案未进入本轮。
- Desktop 3.18.0、3.18.1 实机矩阵与真实 OAuth refresh 仍为 `NOT_VERIFIED`；不能由 3.18.2 合成或实机结果推断 PASS。

## 14. PR 链接与远程 CI 状态

- Draft PR：<https://github.com/Sandyzzx/codex-zcode-bridge/pull/96>
- PR base：`preview`
- 验证候选 HEAD：`265b705b4572a8352e7a955099054289a3f0dcfd`
- 验证候选 tree：`5af528d8f56d113146886f4cd09c46994cd9f3c3`
- 修复提交前的本地 Windows 完整回归：`904` tests，`902 PASS`、`0 FAIL`、`2 SKIP`，`duration_ms=1196817.4362`。
- 修复提交后的定向门禁：`23/23 PASS`；模拟 `core.autocrlf=true` 的干净 Windows checkout 构建后 12/12 generated artifacts fresh。
- `test:clean-entrypoints`：`4/4 PASS`。
- 提交后 typecheck、build、plugin validation、生成物 Freshness 与 `git diff --check`：PASS。
- 生成物 Freshness：`12` 个 tracked files。
- Test inventory：`845` declarations，覆盖 `86` 个 mapped files。
- 远程 CI：验证候选 HEAD `265b705b` 的 Select impact、Fast、Ubuntu Release 与 Windows Release 全部 PASS；Windows 完整回归为 `906/904 PASS/0 FAIL/2 SKIP`。
- 第一次 Windows lifecycle 失败的历史结论保持 `UNCONFIRMED`；后续三次运行未复现，不能把 rerun 成功写成已确认的远端根因。

```text
RUNTIME_ASSET_REDUCTION: PASS
USAGE_CONTRACT: PASS
TASK_CONTEXT_INTEGRITY: PASS
EVENT_SUMMARY: PASS
RECOVERY_CONTRACT: PASS
LEGACY_JSON_RETIREMENT: PASS
NON_CORE_REMOVAL: PASS
SQLITE_NATIVE_COMPATIBILITY: PASS
CI_SIMPLIFICATION: PASS
ARTIFACT_FRESHNESS: PASS
CORE_LIFECYCLE_REGRESSION: PASS
FINAL_PR: CREATED
READY_FOR_OWNER_REVIEW: YES
```

`READY_FOR_OWNER_REVIEW` 仅表示 PR #96 的本地与远程 PR gate 已通过，等待 Owner 审查。本轮没有 Merge、Tag 或 Release；该状态也不等于 Preview.6 已完成发布裁决。
