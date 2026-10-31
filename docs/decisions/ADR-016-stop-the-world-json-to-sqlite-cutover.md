# ADR-016：JSON 到 SQLite Task Authority 的停机切换

> Status: DECISION
> Decision: ACCEPTED — OWNER DIRECTIVE 2026-10-30
> Date: 2026-10-30
> Scope: Task Authority only；Settings 与 Ledger 保持各自既有权威边界

## Context

ADR-014 已冻结单一 Task Authority、停写迁移、staging 回读和不可回退 JSON 的原则，但当前候选把“没有 SQLite 文件”误当成 fresh install。只要 SQLite 根为空，非空 JSON `.tasks` 就可能被静默忽略并创建空库，形成数据丢失。

Owner 已明确选择停机切换：SQLite 将成为唯一 Task 持久化 Authority。项目不实现 JSON/SQLite 双写、热切换或长期双后端兼容。

## Runtime Gate

- 产品安装范围继续由 `package.json` 的 Node.js `>=22.18` 约束；JSON Authority 在该范围内的启动行为保持不变。
- SQLite Authority 仍要求稳定 Node.js `>=24.16.0 <25`。该门槛在 SQLite 模块加载前执行；Node.js 22 配置为 JSON 或不存在的 `authority.json` 时可正常启动，配置为 SQLite 时必须以 `sqlite_runtime_unsupported` 拒绝。
- `launch-node24.mjs` 是兼容 Node.js 22 语法和产品引擎范围的入口 shim，不代表所有 Authority 都要求 Node.js 24。正式提高产品引擎、CI 或 esbuild 目标仍需单独 Owner 决策。

## Decision

1. **正常启动不执行隐式迁移。** 无 SQLite 数据库且 legacy JSON Task 根非空时，启动必须 fail closed，并要求管理员显式执行停机迁移。不得把“缺少数据库文件”解释成 fresh install。
2. **Fresh Install 必须有持久收据。** 仅在 legacy JSON Task 根不存在或没有可迁移内容时，才可由显式 fresh-install 入口初始化；数据库内写入单次 `fresh_install_receipt`。缺失收据的 SQLite 根不得作为生产 Authority 启动。
3. **迁移只接受 sealed snapshot。** 迁移前必须停止 admission、排空或确认全部 Worker 已退出，并封存 JSON writer fence。迁移工具拒绝活动 writer、running Task、`cleanup_unverified`、未知文件、符号链接、损坏 JSON、分叉投影和孤立记录。
4. **保留完整字节。** 迁移数据库保存经路径校验的完整 legacy Artifact 字节、大小和 SHA-256。未知文件不会被忽略；迁移在该文件被明确归类并纳入 allowlist 前失败。
5. **保留业务投影。** queued Task 以新的 Attempt 继续调度；Terminal Task 的历史 Result 和公开 Event 必须可读。迁移不得伪造历史 Claim、Operation、Launch、Worker identity 或 Lifecycle Event。
6. **staging、回读、发布。** 迁移先构建私有 staging SQLite 数据库，在一个事务中导入可验证快照，再由独立打开路径回读 Task、Attempt、Result、Event、Artifact、计数与摘要。回读及源快照复核通过后，写入不可变 `authority_switch` 收据并原子发布为新数据库。
7. **切换后不读旧权威。** `authority_switch` 存在后，SQLite 是唯一在线 Task Authority。SQLite 缺失、损坏、busy、schema 不匹配或结果未知时，启动和写入必须停止；不得自动恢复旧 JSON 快照，也不得把旧 JSON 当作逐字段 fallback。
8. **数据回退。** SQLite 接受新写入后，若必须回到 JSON，只能另行设计并验收完整回迁或重放，保留迁移后的 Claim、Operation、Result、Recovery 和清理事实；不能直接恢复切换前的 JSON 快照。

## Required Evidence

- schema 版本、migration run 与 authority switch receipt 的完整性校验；
- source manifest 在扫描、导入和发布前保持一致；
- staging DB 的独立回读结果与源 manifest 一致；
- terminal Result/Event 与 queued Task 的可读性；
- running、cleanup unknown、unknown file、claimed snapshot 和 source drift 均 fail closed；
- 无 receipt 的 SQLite 根以及“空 SQLite + 非空 JSON”组合均拒绝启动；
- 迁移、损坏、恢复和回滚演练只使用隔离 root，不接触真实 `.tasks` 或 Provider。

## Operational Procedure

1. 在现有 JSON `Authority` 仍运行时执行 `npm run migrate:json-to-sqlite -- --prepare --json-data-root <absolute-json-root>`。该步骤关闭新 admission 和 dispatch，并输出仍未退出的 writer 或 Task blocker；未 `sealed` 时以非零码退出。
2. 正常停止 MCP Host，等待已知 Manager 和 Worker 退出。不得根据进程名终止未知进程，也不得把未知身份改判为退出。
3. 再次执行同一 `--prepare` 命令。只有在全部 writer、开始过的 Attempt、Worker 与 Runtime identity 均被证明退出后才进入 `sealed`；失败时保持 `draining` 和原 blocker。
4. 运行 `npm run migrate:json-to-sqlite -- --apply --json-data-root <absolute-json-root> --sqlite-root <absolute-sqlite-root> --backup-root <absolute-archive-root>`。`--apply` 先创建或逐字节核验完整 JSON history archive，再把迁移源绑定到该 archive digest；archive 不完整或源在 archive 后变化时不得创建 SQLite Authority。
5. 仅在 `authority_switch` 回读与启动验收通过后切换部署配置。SQLite 接受新写入后不得恢复旧 JSON 快照；回退只能通过另行验收的完整回迁或重放。

### Pending marker recovery

发布过程在 SQLite 数据库旁写入 `<database>.cutover-pending.json`，随后以 write-through rename 发布 staging 数据库并进行独立回读。回读通过后，pending marker 以 write-through rename 转为 `<database>.cutover-published.json`。正常 `Store.open()` 与不带豁免的 `openForRecovery()` 在 pending marker 存在、published marker 缺失或两份 marker 同时存在时必须拒绝启动；authority receipt 还必须与 published marker 的 migration、cutover、source 和 archive identity 完全一致。

Windows 上 transfer fence、数据库发布和 published marker 的最终转换均使用 `MoveFileExW` 的 `MOVEFILE_WRITE_THROUGH`，并对目标目录执行 `FlushFileBuffers`。若原生命令返回不确定结果，调用方必须失败；不得把可见文件误报为耐久发布。

若进程在 marker 写入后、发布验证或 marker 最终转换前中断，operator 不得删除 marker 后直接启动，也不得恢复旧 JSON。必须先在停机状态核对：

1. marker 中的 `migration_id`、`cutover_id`、source manifest 与 archive identity；
2. 最终数据库不存在、存在但无法通过只读完整性和 `authority_switch` 回读，或已完整验证；
3. `.staging`、`-wal`、`-shm`、`ROOT_POISONED.json` 与 `WRITER_INTENT.json` 的实际状态。

只有最终数据库已通过只读回读且 published marker 与其 migration、cutover、source 和 archive identity 完全一致时，才可把现场作为已发布数据库继续检查。若最终数据库不是完整可信的 Authority，保持 JSON 与 SQLite 均停止写入；修复或重新迁移必须在新的隔离 root 完成。published marker 的存在和内容一致性是发布见证，不能在证据不足时手工创建、删除或改名。

## Consequences

- 本次候选可以删除“缺库即空库”的隐式行为。
- Workspace Admission 仍关闭；本决策不解决 Workspace identity。
- Legacy JSON Artifact 在 SQLite 中保留为审计材料，不形成双读 Authority。
- 完整迁移与回退验收完成前，生产配置继续保持 `JSON_ONLY / SQLITE DISABLED`。
