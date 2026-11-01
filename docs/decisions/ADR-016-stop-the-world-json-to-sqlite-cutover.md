# ADR-016（v2）：JSON 到 SQLite Task Authority 的停机切换

> Status: DECISION
> Decision: ACCEPTED — OWNER DIRECTIVE 2026-11-01
> Date: 2026-10-30（2026-11-01 修订）
> Version: 2
> Scope: Task Authority only；Settings 与 Ledger 保持各自既有权威边界

## Version History

- **v1（2026-10-30）：** 冻结停机切换、staging 回读、空 SQLite Authority 与失败保护；曾计划导入并校验历史 Task 生命周期。
- **v2（2026-11-01）：** Owner 收缩迁移范围。旧 JSON 仅完整归档，不导入 SQLite；SQLite 从空数据库管理切换后的新任务。历史 Result、Interaction、`respawn.claim` 与 Workspace 数据不再作为 SQLite 转换阻断项。保留停机确认、活动进程清理、归档完整性、Authority 唯一性、原子发布和切换失败保护。

## Context

ADR-014 已冻结单一 Task Authority、停写迁移、staging 回读和不可回退 JSON 的原则，但当前候选把“没有 SQLite 文件”误当成 fresh install。只要 SQLite 根为空，非空 JSON `.tasks` 就可能被静默忽略并创建空库，形成数据丢失。

Owner 已明确选择停机切换：SQLite 将成为唯一 Task 持久化 Authority。项目不实现 JSON/SQLite 双写、热切换或长期双后端兼容。

2026-11-01 Owner 进一步收缩迁移范围：旧 JSON 只作为完整、只读归档保留过去；新的 SQLite 数据根从空数据库开始，只管理切换后的新任务。历史 Task、Attempt、Result、Event、Interaction 和 Workspace 不导入 SQLite，也不要求通过 SQLite 生命周期校验。

## Runtime Gate

- 产品安装范围继续由 `package.json` 的 Node.js `>=22.18` 约束；JSON Authority 在该范围内的启动行为保持不变。
- SQLite Authority 仍要求稳定 Node.js `>=24.16.0 <25`。该门槛在 SQLite 模块加载前执行；Node.js 22 配置为 JSON 或不存在的 `authority.json` 时可正常启动，配置为 SQLite 时必须以 `sqlite_runtime_unsupported` 拒绝。
- `launch-node24.mjs` 是兼容 Node.js 22 语法和产品引擎范围的入口 shim，不代表所有 Authority 都要求 Node.js 24。正式提高产品引擎、CI 或 esbuild 目标仍需单独 Owner 决策。

## Decision

1. **正常启动不执行隐式迁移。** 无 SQLite 数据库且 legacy JSON Task 根非空时，启动必须 fail closed，并要求管理员显式执行停机迁移。不得把“缺少数据库文件”解释成 fresh install。
2. **Fresh Install 必须有持久收据。** 仅在 legacy JSON Task 根不存在或没有可迁移内容时，才可由显式 fresh-install 入口初始化；数据库内写入单次 `fresh_install_receipt`。缺失收据的 SQLite 根不得作为生产 Authority 启动。
3. **停止旧 Authority 的全部生产者。** 切换前必须停止新 admission，正常结束或安全处置运行中的 Worker，并封存 JSON writer fence。无法证明 writer、Worker 或 runtime identity 已退出时保持 blocked。
4. **原始字节归档。** `.tasks` 的全部普通文件、目录和链接元数据必须复制到独立归档，并记录相对路径、类型、字节数、SHA-256、source root 和 Manifest digest。归档不跟随链接目标，不读取或修改 Workspace 指向的外部工作区，不解析 Task、Attempt、Result、Event、Interaction 或 Workspace 的业务语义。
5. **全新 SQLite。** 发布目标必须是一个新的空 SQLite 数据根。迁移不从 JSON 导入历史 Task、Attempt、Result、Event、Interaction、Workspace 或 Artifact 投影；历史 queued/running Task 不在 SQLite 中恢复、Continue 或重新派发。
6. **收据绑定。** SQLite 的 `authority_switch` 收据必须绑定 migration/cutover identity、原始 source root digest、archive directory、archive manifest digest、source tasks root、文件数、字节数和 runtime roster。数据库内的历史投影表必须为空。
7. **staging、回读、原子发布。** 迁移先构造私有 staging SQLite 数据库，写入空 Authority 收据与容量策略，再由独立打开路径回读收据、空历史投影和容量状态。发布前再次验证原始归档与 sealed source 未漂移，随后使用既有 write-through rename 和 pending/published marker 原子发布。
8. **切换后不读旧权威。** `authority_switch` 存在后，SQLite 是唯一在线 Task Authority。SQLite 缺失、损坏、busy、schema 不匹配或结果未知时，启动和写入必须停止；不得自动恢复旧 JSON 快照，也不得把旧 JSON 当作 fallback。
9. **数据回退。** SQLite 接受新写入后，若必须回到 JSON，只能另行设计并验收包含 SQLite 新写入的完整回迁或重放；不能直接恢复切换前的 JSON 快照。

### Superseded: Narrow Historical Result Exception — Owner Approval 2026-10-31

该政策属于 2026-10-31 的历史迁移实现，已由 2026-11-01 的原始归档方案取代。保留本节用于追溯，不构成当前迁移要求：

| 存储路径 | 内部绑定 | SHA-256 | Bytes |
|---|---:|---|---:|
| `CAD2BIM_FULL_AUDIT_RM02_001/attempts/3/result.json` | Attempt 2 | `539c76d236155688feb906a8dfb9764f92a2f76ff8e16b97e6177c2e7bd95530` | 13,981 |
| `CAD2BIM_FULL_AUDIT_RM02_001/attempts/4/result.json` | Attempt 3 | `ec6faea33c6b3b7c299b2c4a6094c431b670d807e00398ed03364ec5a1c61cd3` | 12,989 |
| `PROJECT-ALIGNMENT-DOC-HYGIENE-CLOSE-1-COMMIT-20260930/result.json` | Attempt 1；当时当前 Attempt 为 2，Attempt 2 Result 缺失 | `494235a230178fe2aeb0128210bba0cf8fec5029202b07b0a1b3648476d3e12e` | 6,247 |

旧实现对三处异常、旧格式 Interaction、`respawn.claim`、`worker-stderr-repro.log` 和 `.tasks/workspaces/` 的差异处理记录必须保留为历史证据，但当前切换不再逐项白名单、重映射、修复或导入这些数据。

## Stage 2 Acceptance Under v2

Stage 2 隔离预演只在生产数据的隔离副本上执行，并同时满足：

1. 当前支持的 JSON Authority 参与注册后再正常退出，`--prepare` 能证明全部 writer、已开始 Attempt、Worker 与 Runtime identity 已退出并进入 `sealed`；
2. `.tasks` 的全部普通文件、目录和链接元数据进入独立 raw archive，清单、文件数、字节数和 source identity 可复核；Workspace 链接不被跟随；
3. `authority_switch` 绑定 migration、source、archive 与 runtime roster，SQLite 中的历史 Task、Attempt、Result、Event、Artifact、Interaction 和 historical-exception 投影均为零；
4. 全新 SQLite Authority 能创建和管理切换后的新 Task，并覆盖 Result、Cleanup、Continue 与 Manager 重启恢复；这些行为不读取或续接旧 JSON Task；
5. 归档、source、staging 回读或 marker 任一步不一致都保持 fail closed；SQLite 接受新写入后不得恢复旧 JSON 快照；
6. 任何真实生产 `--apply`、Authority 切换、Push、Merge、Tag 或 Release 仍需 Owner 单独授权。

## Required Evidence

- schema 版本、migration run 与 authority switch receipt 的完整性校验；
- JSON writer fence、Worker 退出证明与 runtime roster 在发布前保持一致；
- raw archive 在创建、staging 回读和最终发布前均与 sealed source 一致；
- Workspace 链接和 Git 指针只作为原始条目记录，不跟随目标、不修改目标；
- staging 与最终 SQLite 的 Task、Attempt、Result、Event、Artifact 投影为空；
- `authority_switch` 收据与 archive identity、source identity、runtime roster 一致；
- source drift、archive tampering、pending marker、缺失 published marker 和损坏收据均 fail closed；
- 无 receipt 的 SQLite 根以及“空 SQLite + 非空 JSON”组合均拒绝启动；
- 迁移、损坏、恢复和回滚演练只使用隔离 root，不接触真实 `.tasks` 或 Provider。

## Operational Procedure

1. 在现有 JSON `Authority` 仍运行时执行 `npm run migrate:json-to-sqlite -- --prepare --json-data-root <absolute-json-root>`。该步骤关闭新 admission 和 dispatch，并输出仍未退出的 writer 或 Task blocker；未 `sealed` 时以非零码退出。
2. 正常停止 MCP Host，等待已知 Manager 和 Worker 退出。不得根据进程名终止未知进程，也不得把未知身份改判为退出。
3. 再次执行同一 `--prepare` 命令。只有在全部 writer、开始过的 Attempt、Worker 与 Runtime identity 均被证明退出后才进入 `sealed`；失败时保持 `draining` 和原 blocker。
4. 运行 `npm run migrate:json-to-sqlite -- --apply --json-data-root <absolute-json-root> --sqlite-root <absolute-sqlite-root> --backup-root <absolute-archive-root>`。`--apply` 先创建或逐字节核验 raw JSON history archive，再以该 archive 和 sealed source 身份初始化空 SQLite Authority；archive 不完整、Workspace 目标被跟随或源在 archive 后变化时不得发布 SQLite Authority。
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
- Workspace Admission 按 ADR-017 的单用户可信本地边界执行必需检查；多用户、远程和同账户敌对文件替换不在 v1 支持范围。
- Legacy JSON 只保留在独立 raw archive 中；SQLite 不保存历史 Task/Result/Event 投影。
- 完整迁移与回退验收完成前，生产配置继续保持 `JSON_ONLY / SQLITE DISABLED`。
