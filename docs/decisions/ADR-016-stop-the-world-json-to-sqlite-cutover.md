# ADR-016（v3）：SQLite Fresh Bootstrap 与旧 JSON 脱钩

> Status: DECISION
> Decision: ACCEPTED — OWNER DECISION OD 2026-11-02；实现与验收待完成
> Date: 2026-10-30（2026-11-01、2026-11-02 修订）
> Version: 3
> Scope: Task Authority only；Settings 与 Ledger 保持各自既有权威边界

## Version History

- **v1（2026-10-30）：** 冻结停机切换、staging 回读、空 SQLite Authority 与失败保护；曾计划导入并校验历史 Task 生命周期。
- **v2（2026-11-01）：** Owner 收缩迁移范围。旧 JSON 仅完整归档，不导入 SQLite；SQLite 从空数据库管理切换后的新任务。历史 Result、Interaction、`respawn.claim` 与 Workspace 数据不再作为 SQLite 转换阻断项。保留停机确认、活动进程清理、归档完整性、Authority 唯一性、原子发布和切换失败保护。
- **v3（2026-11-02，OD）：** 取消 JSON → SQLite 迁移。所有没有可验证 SQLite 生产数据库的安装统一使用 Fresh SQLite Bootstrap；旧 JSON 数据完全脱离启动判定和 SQLite 运行，不读取、迁移、归档、修改或删除。只有 Bootstrap 成功后才发布 SQLite Authority。既有有效 SQLite 原样恢复；SQLite 残留损坏或状态不明时 fail closed。

## Context

Owner 于 2026-11-02 接受 OD：从本版本起 SQLite 是唯一生产 Task Authority。凡当前安装没有可验证的 SQLite 生产数据库，无论 Marketplace 新装、旧 JSON 升级或其他既有安装，均走相同的 Fresh SQLite Bootstrap。SQLite 负责启动后的新任务；旧 JSON 历史与 SQLite 启动、状态恢复和任务生命周期完全脱钩。

本决策取代 v2 的 JSON 停机归档/导入 CLI 切换流程。运行时不得扫描旧 `.tasks`、从 JSON 迁移状态、创建 JSON 归档或回退 JSON。旧 JSON 文件留存与否由用户自行决定；Bridge 不触碰这些文件。

## Runtime Gate

- 产品安装范围仍由 `package.json` 与 `launch-node24.mjs` 的已发布运行时合同决定。SQLite 启动必须在加载 SQLite 模块前检查其 Node 版本门槛；不支持的版本明确失败，不回退 JSON。
- Authority 选择不再提供 JSON 生产模式。没有 `authority.json` 时使用默认 SQLite 数据根；历史合法 `authority:"json"` 配置只作为升级兼容输入，不得使 Bridge 读取或启动 JSON Task Authority。有效 SQLite 自定义 data root 配置继续用于定位已有 SQLite 数据库。
- 本 ADR 不自行扩大 Node 引擎范围；README/manifest 的发布要求必须与最终验证过的 Launcher 和 SQLite 运行时一致。

## Decision

1. **SQLite 是唯一生产 Authority。** 新安装、升级安装和其他没有有效 SQLite 的安装都不能启动 JSON Task Authority。SQLite 失败时不得静默回退 JSON。
2. **无有效数据库时自动 Bootstrap。** 启动发现默认/已配置的本地 SQLite 数据根没有数据库，且没有表明既有或中断 SQLite 状态的文件时，自动安全创建目录、初始化 Schema、写入 fresh-install receipt、provision Capacity 并验证完整性。Bootstrap 完成前 MCP 业务服务不得接受请求；失败须报告 `SQLITE_INITIALIZATION_FAILED` 并拒绝启动。
3. **只在发布成功后承认 Authority。** Authority receipt 必须在 Schema、Capacity 和完整性校验都成功后持久提交。存在 receipt 但缺少 Capacity、receipt 不一致或数据库未通过校验时拒绝启动。不能留下被业务服务接受的半初始化根。
4. **升级不访问 JSON。** Bootstrap 不扫描、解析、归档、复制、修改或删除 `.tasks`、JSON Task 文件或 Workspace 内容。旧 JSON 任务不导入、不恢复、不 Continue；是否由用户另行留存不属于 Bridge 行为。
5. **区分从未初始化与已有 SQLite 故障。** 仅在没有 SQLite 数据库且没有 SQLite bootstrap/cutover/poison/intent/WAL/SHM/staging 等 SQLite 状态痕迹时创建新库。数据库存在时必须按当前受支持 Schema 与 receipt 正常打开；损坏、版本未知、receipt 缺失/矛盾或其他 SQLite 痕迹不完整时 fail closed，不覆盖或重建。
6. **已有有效 SQLite 原样保留。** 合法 fresh-install 或历史 cutover receipt 的有效数据库按既有升级合同打开；schema 升级只能使用显式、受版本控制的 SQLite migration，不能重置数据库。并发 MCP 请求共享同一启动 Bootstrap Promise；初始化必须幂等，重启不能重置任务。
7. **Bootstrap 使用跨进程独占 OS 锁。** Windows 上一次 Bootstrap 的完整状态检查、Intent 写入、Schema/Receipt/Capacity 初始化、回读与发布均由一个持久 `<database>.bootstrap.lock` 文件的独占句柄保护。锁文件可以长期存在；活跃所有权只由 `FileShare.None` 句柄判定。释放由锁辅助进程写入 `released` 审计记录并关闭句柄，文件本身保留。锁记录中的 owner PID 与启动 fingerprint 不能授予锁；等待者只有在取得新的独占句柄后，才能用该精确身份拒绝接管一个“句柄已消失但原 owner 进程仍存活”的异常现场。原 owner 必须同时检查锁辅助进程是否存在；辅助进程被终止或异常退出时，后续状态/发布步骤立即以 `sqlite_bootstrap_lock_lost` fail closed，且不得清理可能属于下一恢复者的 pending/temp 文件。等待者在有界时间内重试；超时、原 owner 身份存活/未知或无法确认锁状态时 fail closed。不得删除其他活动进程持有的 lock/marker 文件。
8. **中断恢复有证据边界。** 只有取得上述跨进程独占锁后，才允许检查并恢复 SQLite 专用中断状态。Bootstrap 发布采用事务/原子发布；只有能证明 Authority 尚未发布、没有接受业务写入且 staging 属于中断 Bootstrap 的情况才可安全重试，其他不确定状态保持 fail closed。marker 中的进程身份仅用于审计，不能替代锁所有权。不得仅凭数据库文件缺失、临时 marker 存在或为空就覆盖重建。
9. **保留安全根路径与 admission。** 使用 `%LOCALAPPDATA%\\CodexZCodeBridge\\state\\bridge.sqlite` 默认路径，维持本地绝对路径、目录身份、symlink/reparse、Workspace Admission、Claim、Worker identity、Cleanup、Recovery 与 Release 门禁。用户不需要 workspace 白名单或 Trusted Local 配置文件。
10. **不再提供 JSON 生产迁移/回退。** v2 的停机 JSON writer seal、raw archive、`--prepare`/`--apply`、Authority switch 与回退流程均为历史实现，不再是当前产品运行路径或用户升级步骤。源码/测试证据可为追溯保留，但不能由当前插件入口或受支持命令触发。旧 JSON 永远不是回退 Authority。

### Superseded: Narrow Historical Result Exception — Owner Approval 2026-10-31

该政策属于 2026-10-31 的历史迁移实现，已由 2026-11-01 的原始归档方案取代。保留本节用于追溯，不构成当前迁移要求：

| 存储路径 | 内部绑定 | SHA-256 | Bytes |
|---|---:|---|---:|
| `CAD2BIM_FULL_AUDIT_RM02_001/attempts/3/result.json` | Attempt 2 | `539c76d236155688feb906a8dfb9764f92a2f76ff8e16b97e6177c2e7bd95530` | 13,981 |
| `CAD2BIM_FULL_AUDIT_RM02_001/attempts/4/result.json` | Attempt 3 | `ec6faea33c6b3b7c299b2c4a6094c431b670d807e00398ed03364ec5a1c61cd3` | 12,989 |
| `PROJECT-ALIGNMENT-DOC-HYGIENE-CLOSE-1-COMMIT-20260930/result.json` | Attempt 1；当时当前 Attempt 为 2，Attempt 2 Result 缺失 | `494235a230178fe2aeb0128210bba0cf8fec5029202b07b0a1b3648476d3e12e` | 6,247 |

旧实现对三处异常、旧格式 Interaction、`respawn.claim`、`worker-stderr-repro.log` 和 `.tasks/workspaces/` 的差异处理记录必须保留为历史证据，但当前切换不再逐项白名单、重映射、修复或导入这些数据。

## Bootstrap Acceptance Under v3

Bootstrap 验收使用全新的隔离用户数据目录和模拟 Marketplace Bundle；不读取真实生产数据，并同时满足：

1. Marketplace 全新安装和存在旧 JSON `.tasks` 的升级安装都不读取、不改动 JSON，且执行相同 Bootstrap；
2. 第一次 MCP 工具调用在 Bootstrap 成功后可用，初始化前请求不会被接受；两个独立进程并发启动、锁等待与锁超时都遵守独占句柄协议，成功路径只产生一个初始化和 Capacity provision；
3. Host 重启后 SQLite 数据及 Task 状态保持不变，receipt 不重复，Capacity 不重复创建；已存在有效 SQLite 用户正常恢复；
4. 初始化目录不可写、坏 schema、损坏数据库、权限错误、symlink/reparse 或不完整 SQLite 痕迹均明确失败且不转 JSON；
5. 使用多个独立 Node 进程验证两个进程同时首次启动、活动持有者保护、独立终止锁辅助进程后原 owner 失锁失败且他人不得接管、Intent、Schema、Ready Receipt 前和 Capacity 后强制退出、锁超时、崩溃后接管及多个恢复进程；只有取得独占锁、原 owner 已证退出且未发布状态的证据完整时才幂等恢复；
6. 首次任务覆盖 admission、capacity、Claim/Worker identity、Result、Cleanup、Release、Continue 与重启 Recovery；SQLite `integrity_check=ok`；
7. 发布 Bundle 含全部 bootstrap/runtime/schema 资源，隔离 Marketplace 安装不执行任何手动激活命令；
8. 历史 JSON 存在与否不改变 SQLite 的 Authority 选择；不得为证明此项而读取、导入、归档或修改用户 JSON 内容。

## Required Evidence Under v3

- schema 版本与 fresh-install/cutover receipt 的完整性校验；
- SQLite `integrity_check`、外键与 Capacity policy 一致性；
- initialized database 不被重置，未发布中断状态只按可验证 marker 恢复；
- 多个并发 MCP startup/request 只有一个 Bootstrap 完成，业务请求在其前不可达；独立进程的锁等待、超时和崩溃接管均有真实退出码证据；
- SQLite 缺失、损坏、配置矛盾和运行时不受支持时没有 JSON 回退；
- 旧 JSON 有/无两种 fixture 均保持字节与目录状态不变，且不进入 SQLite 投影；
- Marketplace 隔离安装的实际加载 Bridge/Worker/Schema 资源与冻结候选一致；
- 全新与升级模拟、失败和恢复仅使用项目内隔离 root，不接触真实生产数据库、`.tasks` 或 Provider。

## Runtime Procedure Under v3

1. 插件启动时解析默认或已配置 SQLite 根并执行路径安全校验。
2. 若发现有效 SQLite 数据库，执行 schema、receipt、完整性和 Capacity 校验后恢复该数据库；不重置现有任务。
3. 进程内 Promise 合并只作为短路优化；真正的跨进程所有权由 `<database>.bootstrap.lock` 上的 Windows 独占 `FileShare.None` 句柄持有。取得锁后统一执行状态检查、中断恢复、SQLite 初始化、receipt/Capacity 提交、staging 回读和原子发布，最后关闭句柄并保留锁文件。
4. 只有 Bootstrap/恢复验证完成后才创建 MCP Manager 与服务并接受业务请求。失败输出 `SQLITE_INITIALIZATION_FAILED` 并终止启动；不回退 JSON。
5. 若数据库缺失但存在 SQLite 状态残留，或任一状态不确定，停止并保留现场；仅在已验证的未发布 Bootstrap 中断协议范围内重试。

### Historical v2 cutover marker recovery (not used by v3 bootstrap)

发布过程在 SQLite 数据库旁写入 `<database>.cutover-pending.json`，随后以 write-through rename 发布 staging 数据库并进行独立回读。回读通过后，pending marker 以 write-through rename 转为 `<database>.cutover-published.json`。正常 `Store.open()` 与不带豁免的 `openForRecovery()` 在 pending marker 存在、published marker 缺失或两份 marker 同时存在时必须拒绝启动；authority receipt 还必须与 published marker 的 migration、cutover、source 和 archive identity 完全一致。

Windows 上 transfer fence、数据库发布和 published marker 的最终转换均使用 `MoveFileExW` 的 `MOVEFILE_WRITE_THROUGH`，并对目标目录执行 `FlushFileBuffers`。若原生命令返回不确定结果，调用方必须失败；不得把可见文件误报为耐久发布。

若进程在 marker 写入后、发布验证或 marker 最终转换前中断，operator 不得删除 marker 后直接启动，也不得恢复旧 JSON。必须先在停机状态核对：

1. marker 中的 `migration_id`、`cutover_id`、source manifest 与 archive identity；
2. 最终数据库不存在、存在但无法通过只读完整性和 `authority_switch` 回读，或已完整验证；
3. `.staging`、`-wal`、`-shm`、`ROOT_POISONED.json` 与 `WRITER_INTENT.json` 的实际状态。

只有最终数据库已通过只读回读且 published marker 与其 migration、cutover、source 和 archive identity 完全一致时，才可把现场作为已发布数据库继续检查。若最终数据库不是完整可信的 Authority，保持 JSON 与 SQLite 均停止写入；修复或重新迁移必须在新的隔离 root 完成。published marker 的存在和内容一致性是发布见证，不能在证据不足时手工创建、删除或改名。

## Consequences

- 新安装和旧 JSON 升级拥有相同的首次 SQLite Bootstrap 体验；不存在 JSON 生产运行路径或静默回退。
- Bridge 不再读取或自动归档旧 JSON。旧文件是否保留由用户自行决定；其历史任务不会出现在新 SQLite 中。
- 已有有效 SQLite 保持原样并恢复；损坏、状态矛盾或未完成发布状态不会触发覆盖重建。
- v1/v2 停机迁移合同、Result 异常政策、归档和 marker 证据仍保留在版本历史与旧实现中，仅供追溯，不是 v3 的操作步骤。
- Workspace Admission 按 ADR-017 的单用户可信本地边界执行必需检查；多用户、远程和同账户敌对文件替换不在 v1 支持范围。
- 本 ADR 是已批准决策，不代表 v3 实现、Marketplace E2E 或生产安装验收已经通过。
