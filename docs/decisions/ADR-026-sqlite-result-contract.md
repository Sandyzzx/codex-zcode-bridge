# ADR-026：SQLite Result 语义、容量与兼容升级（Owner 已批准）

> Status: DECISION
> Decision: APPROVED — Owner 于 2026-11-05 授权 R2 本地实现与隔离副本验证；不授权生产 Migration
> Date: 2026-11-05
> Amendment: 2026-11-12 — Owner 要求将 Preview.4 合并到 Stable 1.7.0。有效 v13 根现可在启动 bootstrap 锁内自动调用本 ADR 的副本升级；保留 v13 备份、验证发布后清除 marker、失败 fail-closed，显式离线工具继续保留。该修订不授权清除 Hold、改写运行事实或以旧备份覆盖 v14 新事实。
> Proposal evidence baseline: `aabbb0a959ee234508c62731ed5122f28dfcf5b0`，Node 24.16.0 / Windows；下文 Context 为批准前 v13 的历史证据，R2 实施与验收另记。

## Context — 问题与实测

AgentReport parser 和公开 TaskResult 接受普通字符串数组；Store 另设 256 项、4096 字符及控制字符禁令。Adapter 捕获至 2,000,000 个 JS 字符，Worker Result pipe 限 16 MiB，而当前 `manager_operations.result_json` 的 SQL CHECK 与 Store 都限制整个 Result 为 **65,536 UTF-8 字节**。合法报告可以在执行完成后拒收，Task 保持 running。

本轮实验经过真实 parser → buildTaskResult → canonical JSON → 当前 Store 提交 → SQLite 回读，没有改 CHECK 或绕过 Claim：

- ASCII、中文、emoji、引号转义、NUL 转义五类内容，各生成 canonical Result 为 65,535 / 65,536 / 65,537 字节。前两档全部逐字节落库并回读相同；第三档全部 result_too_large、Task 仍 running。
- 多行 issue、257 个文件名在 parser/normalize 合法，却因 Store 的额外文本/数量限制拒收。
- 2,000,000 字符普通输出以及控制字符的 JSON 扩展都超过旧 SQL 上限。字符数、原始 UTF-8 大小和 JSON 序列化大小不能混用。

可复现实验：[probe.mjs](../research/sqlite-result-contract-20261105/probe.mjs)。运行 `npm run build:test` 后执行该脚本；仅新建项目内自有数据库。结果保存在 `.run/execution/result-contract-evidence.json`。这是当前缺陷证据，**不是新容量已经实现/迁移通过**。

## Decision — 推荐决策（Owner 已批准）

### 1. 一个语义合同，一种精确计量

保留公开 TaskResult/AgentReport 字段和任务状态。报告正文、issues、tests command/details 和 files_changed 是报告数据，允许合法 JSON 字符串、Unicode、多行和超过 256 项；不把它们隐式转换成 OS 文件操作参数。删除 Store 对这些字段独有的 4096 字符/控制字符/256 项限制；Array/string/boolean/TestReport status 等类型语义统一使用一份可供 Worker TS 和 Store ESM 调用的合同定义。

身份、Task/Attempt/Claim/Generation/Revision、时间和模型标识等仍按各自元数据合同校验，不能用“自由文本”放宽身份门。公共 MCP schema 的结构校验与 Store 的身份/CAS 职责保留，但不再维护三套互相矛盾的报告文本规则。复用现有 canonical JSON 排序/序列化，不增加依赖、配置开关、第二 Authority 或状态机。

唯一容量计量是 `Buffer.byteLength(canonicalTaskResult, "utf8")`，SQL 用相同的 `length(CAST(result_json AS BLOB))`；不是 JS length、字段逐项长度之和或未经转义的原始响应长度。canonical JSON 的 optional absence/null、字段值和 digest 语义保持不变。

### 2. TaskResult 总上限推荐 32 MiB；帧另留 256 KiB 元数据空间

- `MAX_TASK_RESULT_BYTES = 33,554,432`（32 MiB），覆盖完整 canonical TaskResult，包括 zcode_output、结构化报告、report_candidate 和元数据。
- `MAX_WORKER_RESULT_FRAME_BYTES = MAX_TASK_RESULT_BYTES + 262,144`。Result 对象嵌入帧中，不二次转成 JSON 字符串；额外空间仅用于有明确长度上限的 Operation/路径/身份/cleanup proof。完整 proof 仍传 digest/count，不能把整个任意进程树复制进 envelope。
- 不引入可配置容量。单个共享定义供 Worker 编码、Manager 读取与 Store 使用，SQL CHECK 固化同一数值，测试验证一致；Manager 必须在缓冲和解析前执行帧上限。
- queued-cancel 的 TaskResult 使用同一容量定义；历史 migrated_task_results 的已有数据/读取兼容单独保留，不借此重写历史结果或摘要。

32 MiB 的取舍：现有 app-server 单帧 16 MiB、文本捕获 2M 字符，结构化报告与捕获文本在 Result 中同时存在；JSON 控制字符还可能放大至每字符 6 字节。64 KiB 显然不够，8 MiB 不能完整承接现有捕获范围。32 MiB 提供现有有界输入的组合空间，又避免取消所有内存/磁盘上限。需在实施验收中测最坏合法组合及并发峰值；这里没有凭空保证所有任意大外部响应都合法。

此提案不改变现有 Adapter capture 合同，也不以再次截断 Result、减少 files/issues/tests、去掉 report_candidate 或丢失输出换取提交成功。

### 3. 编码失败与提交不确定分开

完整 Result 生成后只做一次共享语义/容量判定，**在 Worker 已完成执行但退出之前**保留可解释失败原因。Manager/Store 对传入内容继续检查边界和 Claim，不重复执行 Adapter。

符合上述输入和字节合同的结果必须能落库；已观察到的多行/257 项/70KiB/2M capture 不得再掉入 running 黑洞。编码和最终帧的边界组合须在实现前测出，不得只把一个数字调大后宣布闭合。

真正越过新合同的原始非法帧/结果必须明确暴露 `result_too_large` 或 schema 错误与实际字节数；不得把裁剪后内容冒充已提交完整 Result，不吞掉错误、不自动重派。若需把这种已执行但无法提交的现场转为普通 failed，必须与无 Result Recovery 的明确语义一起实施：保留“报告未提交”事实、精确资源状态和 CAS；不以伪造成功/cleanup verified 终结。此项不能借扩大 CHECK 顺带跳过生命周期裁决。

COMMIT ACK 丢失/transaction_outcome_unknown 则按 Claim、operation revision、digest/event 回读对账；不得归为普通 invalid payload 然后再次提交不同报告或重跑 Worker。

### 4. v13 → v14 必须显式升级，不静默变更

仅修改 SQL CHECK 也会改变本仓库的精确 schema 身份，不能冒充 v13。建议新 schema v14，迁移只调整相关表的长度约束、相应 schema/运行时版本和共享校验，保留全部主键、外键、触发器、唯一约束、事件 cursor、Claim、Result digest 与 append-only 事实。

迁移程序单独实施、审查、授权：停机/排除 writer、备份和校验旧库，在隔离副本上验证全量行/事件/摘要/容量与外键，成功后才使新代码接受 v14。未知 schema、有效历史 cutover receipt、WRITER_INTENT/ROOT_POISONED 或未解释的运行现场不能被迁移程序“顺便修复”。不重新读取 JSON Authority，不删除/重建用户数据根，不修改 sqlite_master 绕过 CHECK。

批准本 ADR 仅授权后续实现该合同及隔离验证；**不自动授权实际生产库迁移**。迁移失败保留 v13 备份和现场；新库写入后不能直接降级旧二进制，须使用验证过的 forward fix 或另行批准的数据回退方案，不能用旧备份覆盖迁移后新增任务。

## Rationale — 取舍与不采纳的方案

| 方案 | 不采纳理由 |
|---|---|
| 把所有报告截到 64 KiB | 改变正确内容、丢数据，违背本轮边界 |
| 只改 Store 常量/只改管道数字 | SQL CHECK、精确 schema 身份或对端仍会拒绝 |
| 将大报告写 JSON 文件，SQLite 只存路径 | 新增结果 Authority、原子提交和恢复责任，增加迁移复杂性 |
| 取消全部上限 | 单用户本地也需要可预测的内存和磁盘资源边界 |
| 为每层增加不同的保护阈值或重试 | 继续制造不一致，且可能重复执行 |

## Consequences — 实施验收与回滚门槛

1. 本轮证据中的字节、Unicode/escaping、类型/数组边界通过真实生产 Worker→Manager→Store；32MiB 两侧、envelope 极限、optional/null/digest 均有精确测试。
2. SQLite 原值/UTF-8 bytes 回读一致；合法输入没有截断、删字段或隐式转换。错误路径不得残留无诊断的 running；资源未证实时不能 Release。
3. v13 副本迁移到 v14 的逐表/逐行/事件/digest 不变、FK/完整性通过，fresh v14 与旧有效 cutover 库兼容有证据。实际生产迁移仍另需批准。
4. COMMIT ACK 丢失、磁盘失败、schema 不匹配、晚到结果和 cancel/Recovery 竞争维持永久 Claim、一次提交/Release；不添加自动执行重试。
5. Windows 完整回归、适用的 Ubuntu 回归和 Result/CAS 压力；最大结果下测量编码、传输、持久化与默认并发内存峰值。MCP 同时提供 structuredContent/text 时要计入外层重复序列化，并对实际 Host 接收限制验证，不能把 SQLite 可存等同于 Host 已验收。新 Schema 写入前可回退代码，写入后按兼容/迁移计划处理。

## Owner 批准点

Owner 已批准三项实质决定：**共享文本/数量语义；32MiB Result 与 256KiB envelope 空间；显式 v14 升级及非自动生产迁移**。实现验收独立记录，生产数据库迁移仍须另行授权。
