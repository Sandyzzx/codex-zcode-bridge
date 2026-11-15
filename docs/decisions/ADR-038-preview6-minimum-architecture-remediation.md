# ADR-038：Preview.6 最小架构整改与历史兼容责任退役

> Status: DECISION
> Date: 2026-11-15
> Decision: Accepted — Owner 在 “Preview.6 Post-Audit Consolidated Reduction & Correctness Repair” 中批准本 ADR 所列整改。
> Applicability: ACTIVE。核心执行架构不变；旧 JSON 历史查询、Project Ledger、人类 Markdown 报告链、Codex Rollout Token 采集和 Desktop task-index 私有镜像从当前产品合同中退役。
> Verified against: `545c02f745a4e2ab38a1fa3c31880ac80b84a310` 及两份冻结审计报告。

## Context

Preview.6 的核心执行链是：

```text
Codex Host -> MCP -> SQLite Authority -> one Worker per Attempt
           -> Official Host -> official AppServer
```

该链承担 Task 幂等、Workspace 占用、永久 Claim、精确进程身份、Result/Cleanup/Release 分离和官方认证所有权，不能为了减少代码而删除。另有一部分外围职责没有进入默认 Host 执行链，或继续维护已经退役的历史系统：

- 旧 JSON Authority 的导入写入器、迁移后 Result/Event 读取器和历史查询兼容；
- 可选 Project Ledger 的独立项目状态机；
- 固定人类 Markdown 报告、Codex Rollout Token 采集和展示链；
- Bridge 对官方 Desktop `tasks-index.sqlite` 的私有写镜像；
- 每次 PR 在两个平台执行完整 Windows 回归；
- 生成物 Freshness 只手动列出部分输出。

审计同时确认了三个合同偏差：官方 Cache Read/Write Usage 未完整保留、Task `context` 在 2,000 字符处静默截断、`zcode_events(view=summary)` 只校验参数而未合并相邻模型文本。生产 Recovery 对无 Result 的 Running Attempt 还会在真实 Adapter 清理证明缺失时保持 Hold，不能把 Fake Adapter 的合成重派路径表述为生产自动恢复能力。

## Decision

### 1. 保留核心 Authority 与执行边界

以下合同保持：

- SQLite 是唯一生产 Task Authority；不新增 Companion、第二数据库或新状态机；
- 每 Attempt 一个 Worker，保留并发、Claim、Workspace Occupancy 和精确 OS 身份；
- Official Host 拥有认证、模型请求、工具、Context 和官方进程生命周期；
- Result、Cleanup、Release 继续分离，未知执行接受状态不盲重派；
- Start Plan/Coding Plan 路由和 ADR-030 单次 Billing verdict 保持；
- 固定 Official Runtime `3.18.2`，不增加动态发现、下载或 Helper 重建机制。

### 2. 退役旧 JSON 查询责任，不删除历史数据

- 删除旧 JSON cutover/import 写入方法及其 Port、调用和造库依赖；
- 删除旧迁移 Result/Event Reader、历史异常投影和只服务旧 JSON 历史的测试与夹具；
- 不删除 SQLite v14 中已有的 `migration_runs`、`authority_switch`、`json_artifacts`、`migrated_task_results` 或 `migrated_task_events` 表；
- 不新增 v15，不自动DROP、清空或重建数据库；
- 保留 SQLite v13→v14 升级、当前原生 Task/Attempt/Result/Runtime Events/Hold/Recovery 和损坏库 fail-closed 校验；
- 原生 v14 Task 继续正常工作。历史 JSON 任务不再是受支持的查询对象；
- 若旧迁移数据库同时含原生 Task，允许继续打开并读取原生 Task，但不得把旧 `migrated_task_results/events` 投影为新 Result/Event；
- 若当前完整性约束无法安全分类某种旧库，保持原文件字节并拒绝继续，不静默转换。

### 3. 退役非核心产品面

- 删除 Project Ledger 源码、MCP 注册、Bridge 接线、专用测试和文档入口。用户已有 `.agent-ledger` 文件保持不变；
- 删除固定人类 Markdown feedback template/renderer、每任务 Codex Rollout Token source/CLI 和仅服务该展示链的测试；
- 保留 `zcode_feedback` MCP 工具，改为现有结构化机器投影的文本摘要，不构成第二状态源；
- 删除 Bridge 对 Desktop `tasks-index.sqlite` 的直接写入和状态同步。Bridge Task 不再承诺显示在 Desktop 独立任务列表；官方 Session/AppServer 执行不受影响；
- 删除仅为未支持平台或实验入口维护的无效生产分支，保留 Linux CI 所需的合成/测试边界。

### 4. 修正正确性合同

- 官方 `cacheReadTokens` 映射为 `cached_input_tokens`；`cacheWriteTokens` 使用独立可选字段 `cached_write_input_tokens`。两者不可相加或互相替代；
- Usage 继续区分缺失 `null`、真实 `0`、turn/session scope、source、finality 和 conflicts；不从 Session 累计值重复累计；
- Task `context` 不再无声截断。Prompt Builder 在总 Prompt 容量内完整保留全部 accepted 字段；超过总容量时返回带稳定错误码和容量的构建错误；
- `zcode_events(view="summary")` 只合并相邻、同一 Operation/Attempt 的 `model_output`；遇到任何其他事件或 Attempt 即断开。保留 raw cursor、`next_seq`、`max_bytes`、`scan_cursor` 与 attention 语义；
- 生产 Recovery 对 Result-less Running Attempt 的默认结果是 Hold，原因必须表达 `adapter_cleanup_unverified`。只有在独立 Cleanup Proof 可用时才允许重派；Fake Adapter 不能作为生产能力证明。

### 5. CI 与生成物合同

- 复用现有 `test/test-impact-map.json`、`scripts/run-affected-tests.mjs` 和 selector，不建立第二套选择规则；
- PR Fast Gate 执行 typecheck、必要 build、plugin validation、完整 generated freshness 和 affected tests；
- Task/SQLite/Worker/Result/Windows process/auth/runtime-sensitive 变更触发 Integration Gate；
- Release/full、核心合同变化、测试执行器变化以及未知源码变更触发完整 Windows + Ubuntu 回归；
- 完整生成物清单由一个受版本控制的 manifest 驱动；删除的功能及其生成物必须从 manifest 消失；
- 不提高 Windows 并发、不降低 timeout、不跳过关键 Claim/CAS/Cleanup/Result/identity 测试。

### 6. MCP Result 与 Prompt

- 在 Host 消费方式未被证明前，不取消 MCP `content`，也不改变 32 MiB Result 合同；
- 可对大 `zcode_result` 使用短文本摘要并保留完整 `structuredContent`；只有在本地真实 MCP Client/stdio 合成验收证明文本不必复制完整对象后，才启用该表示；
- 不缩短或改变官方 System Prompt、Tool 定义和 Context 管理；Prompt 优化只接受静态与合成可证明的重复删除或容量修复。

## Consequences

正面结果：

- 生产 Authority 只保留当前 SQLite Task 生命周期；
- 已完成的历史 SQLite 字节不因产品退役而被破坏；
- 默认 Bridge 不再拥有项目管理、人类报告、Desktop 私有 SQL 或主会话 Token 采集职责；
- Usage、Events 和 Task context 的公开行为与实际实现一致；
- Windows PR 不再为文档或无关改动支付完整回归成本，同时 release/full 仍保留完整保护。

代价与风险：

- Project Ledger 和人类 renderer 的 Core 导出属于破坏性接口收缩；
- 旧 JSON 任务的 Result/Event 不再通过 Bridge 查询，需要原始迁移数据的用户必须使用历史版本或直接保留的 SQLite 历史表；
- Desktop 独立任务列表不再显示由 Bridge 同步的 Task；
- 历史完整回归结果不能证明本整改的新 CI 分层充分；发布前必须执行至少一次 Release/full 或等价完整回归；
- `events summary` 仍受单页 `limit` 和 `max_bytes` 边界约束，不保证把跨页全文合并为一个事件。

## Relationship To Existing Decisions

- [ADR-004](ADR-004-separate-control-state-and-observation.md)、[ADR-016](ADR-016-stop-the-world-json-to-sqlite-cutover.md)、[ADR-026](ADR-026-sqlite-result-contract.md) 的 SQLite 单一 Authority、Result 与 observation 分离继续有效；旧 JSON 导入执行责任由本文退役。
- [ADR-009](ADR-009-windows-identity-bound-tree-termination.md)、[ADR-024](ADR-024-scoped-sqlite-hold-and-local-cleanup-recovery.md)、[ADR-027](ADR-027-execution-and-cleanup-deadlines.md)、[ADR-034](ADR-034-normal-cleanup-worker-tree-proof.md) 的进程身份、Hold、Cleanup 与 Release 保护继续有效。
- [ADR-036](ADR-036-host-native-interruption-requeue.md) 的代码门槛保持真实；本文修正其生产能力表述，不把 Fake Adapter 路径提升为生产可用。
- [ADR-037](ADR-037-official-zcode-authentication-reuse.md) 的官方认证所有权保持不变。
