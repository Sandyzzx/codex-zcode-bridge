# ADR-043：SQLite v14 ONLY

> Status: DECISION
> Date: 2026-11-21
> Decision: APPROVED — Owner 指令正式停止 SQLite Schema v13 支持，只保留当前 v14 生产生命周期。
> Scope: SQLite 启动、拒绝语义、Schema/CLI 分发、升级测试与构建生成物。

## Context

Bridge 生产 Authority 已经是 SQLite v14。历史 v13 自动升级与离线副本升级长期保留了两套迁移代码、冻结 DDL、CLI、打包资源、生成物和专用测试，但它们不再是当前生产生命周期的一部分。继续支持 v13 会增加启动分支、数据搬运风险和 CI 成本。

## Decision

1. 当前 Bridge 只支持 SQLite Schema v14。Fresh Bootstrap、已有 v14 打开、历史 v14 Task/Result/Event/Receipt、Recovery、Cleanup 与 Release 合同保持不变。
2. 删除 v13 自动升级、离线复制升级、升级中断恢复、升级回滚、冻结 `schema-v13.sql`、`upgrade-sqlite-v14` CLI 及其构建/打包引用。
3. Store 在创建任何可写 SQLite 句柄之前，以只读 `PRAGMA user_version` 预检 Schema。发现 v13 时稳定返回 `unsupported_sqlite_schema`，用户提示为 `SQLite v14 ONLY`。
4. 生产 Lifecycle Gate 传播同一 `unsupported_sqlite_schema`，不把它降级为通用的 `sqlite_existing_database_unverified`。
5. 已知 v13→v14 未完成升级 Marker 时保留文件和现场并明确拒绝；不删除、不恢复、不重命名、不覆盖。v13 数据库、WAL、SHM 和 Marker 均不得因拒绝而改变。
6. 未知 Schema、损坏数据库、Writer 冲突和其他无法解释的现场继续 fail closed，不得误判为 Fresh Install。
7. 不创建 v15，不修改 v14 Schema，不删除 `migration_runs`、`authority_switch`、`json_artifacts`、`migrated_task_results`、`migrated_task_events`、`manager_admin_abandonments` 或 `runtime_task_events`。

## Consequences

- 支持声明统一为 `SQLite v14 ONLY`。
- 历史 ADR、研究和报告保留原文，用于解释为何曾有升级实现；其中 v13 升级能力由本 ADR 标记为 SUPERSEDED / RETIRED。
- 已有 v14 数据不受影响；已有 v13 安装只能由仍支持 v13 的旧版本处理，然后再升级到当前 Bridge。
- 旧 `authority: "json"` 仅作为安装配置兼容提示，继续选择 Fresh SQLite v14；该行为不恢复 JSON Authority，也不改变 v14 Schema。
