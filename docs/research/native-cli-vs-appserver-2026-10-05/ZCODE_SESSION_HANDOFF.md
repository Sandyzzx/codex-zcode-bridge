# Session Handoff 审计

> Status: RESEARCH
> Date: 2026-10-05
> 研究结论，不代表当前实现。索引见 [README.md](README.md)。

**结论：双向顺序恢复可行；“全部 Runtime 状态无损”未证明；正在运行的跨 Host attach/control 不应启用。** 所有实验只使用专用私有 SQLite、独立 fixture 和本次生成的 Session。模型均为 GLM-5.3-Flash / low。

## A — CLI → app-server

Session：`sess_861d65fd-78de-4076-9dc8-bd78d813df6f`。

CLI Read `handoff.txt`，记住第一行 `ALPHA_731`，正常退出。另起 app-server：`session/list` 可见；未 resume 的 `session/read` 报 `-32004 Session is not active`；`session/resume` 成功。续作能回忆 marker，并直接 Edit 把 `stage=one` 改为 `stage=two`，没有再次 Read。文件最终为 `ALPHA_731\nstage=two\n`。

| 检查项 | 实测结果 / 边界 |
|---|---|
| History | 3 → 6 条持久化消息，前 3 条内容摘要一致；本探针的历史保留 **CONFIRMED — RUNTIME** |
| Model / reasoning | 恢复快照保持指定 Provider、Flash、low |
| Mode | `settings.mode.current=yolo`；session 元数据却为 build，不能把 list 字段当当前权限真值 |
| Workspace | 保持原 fixture 路径 / workspace key |
| Tool state | 没有重读就 Edit 成功；与源码 read-file-state hydration 一致。只证明所测 Read/Edit 状态 |
| Usage | 累计 context-cache input 38,378 → 70,411；usage 查询 request count 2 → 4。跨轮延续成立，但 accounting 数值不是所有网络请求简单相加 |
| Memory | 不是已有 project memory 内容的恢复实验；此项 **UNKNOWN** |
| 续作质量 | marker 正确、Edit 正确、终态成功。只证明此小型续作 |

## B — app-server → CLI

Session：`sess_49430bee-2fd3-4c4a-b5da-31f0281cc412`。

app-server 完成 Read `BETA_842` 的首轮；对空闲会话 `stop` 返回 `{}`，`close` 返回 `{closed:true}`。关闭后 list 仍可见，进程退出。CLI 用同一 ID `--resume` 并明确传 `--mode yolo`，成功回忆 marker，直接 Edit 完成 stage=two。第三个 app-server 再 resume 验证：历史 3 → 6、前 3 条摘要保持，模型与 low 保持，当前 yolo，workspace 保持；累计 input 31,758 → 70,411，request count 2 → 4。

**CONFIRMED — RUNTIME：session/close 不删除这次已持久化的历史。** 此处 yolo 有显式参数覆盖，不能声称不传 mode 时也一定恢复相同权限。session title 从 first_input 变为 generated；标题等辅助状态可能另外更新，不在“主 turn 的历史内容一致”保证之内。

## C — 运行中的 CLI → 另一 app-server

Session：`sess_d168cbe0-5ad0-4d3f-b7e7-88680013ddaf`。CLI 在 Bash 中执行本次创建的 15 秒 helper；启动标记证明工具仍在运行。

| 操作 | 结果 |
|---|---|
| session/list | 可发现持久化记录，但 status=idle，与运行实况不同 |
| session/read | `-32004 Session is not active` |
| session/stop | 同样错误；无法停止另一进程持有的 Runtime |
| session/resume | **NOT RUN — safety stop**：源码显示冷 resume 会 materialize 新 Runtime；未发现跨进程执行租约。用户原任务要求出现数据风险即停止 |
| CLI 自身完成 | exit 0、完成标记存在、工具正常结束 |
| ownership error / global lock | 没有实测到，因为没有执行危险的并发 resume；**UNKNOWN** |
| history corruption / duplicate tool | 未制造；不能写成已复现或必然发生 |

**CONFIRMED — RUNTIME：持久化可见 ≠ 活动 Runtime 可控制。SUPPORTED：第二个 Host 的冷 resume 应视为新 Runtime 的恢复，不能当成连接现有 PID 的 attach。** 不支持把未执行的 concurrent mutation 误记成一次“安全 attach 失败”的完整实验。

## 持久化、恢复、所有权

官方 [server.ts L133 / L260](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts#L133) 的 session registry 是进程内 Map；[sendPrompt L1929](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L1929) 检查该 record 的 activeAbortController。SQLite 的 WAL / busy locking 保护存储访问，不等于跨 Runtime 的会话执行锁。审读 bootstrap/session-store 及相关检索未发现通用 session-owner 租约；这是范围内的 absence evidence，标 **SUPPORTED**，不是对所有未审代码“绝无锁”的证明。

[resume L1411](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L1411) 读取持久化消息、推导 mode、创建 record，再 app.resume；model 从持久化 selection entry 恢复。[core resume.ts L137](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/resume.ts#L137) 恢复 ReadFileState 与 execution state。history hydrator 在 [L188](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts#L188) 把未完成 tool 转为 interrupted 结果；若另一进程仍真实执行该 tool，就存在状态理解分歧的风险，不是安全接管协议。

## close、stop、EOF 的区别

| 信号 / 方法 | 源码语义与本次证据 |
|---|---|
| `session/stop` | [L2592](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L2592) abort 当前回合，可暂停 active goal；ACK 不证明 tool tree 已结束 |
| `session/close` | [L2716](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L2716) app.close、移除内存 record/event store；不等于删除 SQLite 历史；B 已证实 |
| `App.close` | [session-facade.ts L264](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts#L264) drain memory、停 Workflow、清资源；drain 有等待边界 |
| stdin EOF | transport disconnect 与进程 shutdown 不同于一条 `session/close`；本探针 EOF 后进程退出且历史可恢复 |
| 强杀进程树 | 操作系统取消，不保证正常 flush 或干净持久化；须验证后续 resume，而非自动假定可恢复 |

另一个边界：最初 smoke 对刚 create、未 admission prompt 的“immediate”空会话，进程退出后 resume 报 Session not found。完成首轮后才观察到可恢复持久化。不能只凭 `session/create` 的返回 ID 保证已有 durable history。

## Usage 不应宣称完全无损

A 的 `session/usage` totalTokens 从 19,268 到 19,492；同一会话 runtime context-cache 的累计 input 从 38,378 到 70,411。官方 [getTaskTokenUsage L2908](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L2908) 使用 usage store task-accounting，并返回 inputBaselineBySource。不同字段有不同口径。恢复 request count 连续不意味着所有历史 Provider Token、缓存字段、标题/后台请求都可由一个数重建。

建议 Run Ledger 保存每个已完成 request/turn 的 Provider usage，保留 querySource、logicalCallId、requestId、attempt，标完整性；session/usage 作为独立产品计量来源，禁止混加或重复计费。未完成受网络影响的请求记 UNKNOWN，不补 0。

## 建议的顺序交接门槛

1. Run Manager 为 workspace + session 持有唯一执行租约。
2. 当前输入回合与允许的背景活动已收口，记录 final result、usage 完整性和持久化摘要。
3. 旧 Host 正常释放、其工具进程已清理，确认旧进程退出；不能只等 stop ACK。
4. 新 Host 使用相同存储、身份、workspace，显式配置 policy；resume 后核对历史、model、reasoning、mode，再提交新输入。
5. 任一步未知就保留 occupied / recovery_required，不开启并行写入。

该流程是架构建议，**没有在本次修改生产 Bridge 实现**。跨机器 handoff、后台 subagent/Workflow 完整恢复、外部 Memory 对齐均仍不确定。
