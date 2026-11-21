# Token Efficiency 候选设计

> Status: RESEARCH
> Last updated: 2026-11-22
> A0: `1f9ff9ef37528205e76156e13fe06ed2b1fd3711`
> Implementation: `6f814bf8736baa59295e686af8733c88d4202ca0`
> Preview base: `450c18afc0c8af2700734399c5aebd87a36df795`（PR #116 已合并）

| 变体 | 候选采用的行为 | 兼容性与取证 |
|---|---|---|
| B1 轮询 | 启动阶段读取 Events 和 runtime 身份。省略 `max_bytes` 时默认使用 32 KiB 有界页，持续消化 `has_more`/`scan_incomplete`；稳定后用已有 Attention。宿主可可靠接收退出且能绑定本次 MCP Authority 时，空闲阶段复用 Thin Waiter | 默认 raw、字段和工具 Schema 不变；只改变省略预算时的分页。新 Skill 显式请求 `include_attempt`，用逐条持久 Attempt 核对启动和验收证据。游标、合并且全部生命周期记录可回读，ADR-048 允许默认返回一条超限事件以防 cursor 卡死 |
| B2 结果 | `zcode_result(view="summary")` 在已提交 Result 上选择有界投影。2 KiB 以内直接返回完整结果。投影保留执行状态、错误码、决策标记、全部测试的状态计数与省略提示 | `task_id` 单参数仍返回原对象、文本及原工具错误。可选 `expected_attempt` 防止读取较新的 Result 并误归于旧 Attempt。安装版 Host 证明模型只消费 `structuredContent`；超过 16 MiB MCP 行的全量回读仍受现有 Host 上限约束 |
| B3 工件 | Master 在 TaskPackage 和验收中使用实际执行目录中的相对路径、Git SHA 和已有 Result，短证据可直接传递 | 区分活路径与快照。按原 Task、执行根和 Attempt 核对。文件缺失或内容变化时使用可核实的现存证据 |
| B4 缓存 | 保留 Worker Prompt 和 Master Skill 入口字节作为对照。各次 MCP 连接使用确定性的注册顺序 | B2/B5 更新可改变 Master 的前缀内容。冷、热、重启和恢复时的实际命中与写入费用仍需测量 |
| B5 工具目录 | 精简工具描述。同名工具继续广告对象根 `outputSchema` 并服务端校验 | 12 个原有 `outputSchema` 均存在。`zcode_result` 的 `zcode_output` 对静态 Schema 生成器变为可选，并新增互斥 `projection` 分支；这是需明确接受的公共 Schema 源级变化。任务路由、重试幂等、显式授权、独立验收及恢复约束仍明确 |

## 实现边界

- ADR-047 在接口实现前记录读取方案。`src/mcp/result-summary.ts` 投影 `TaskManager.getResult` 的原结果。状态、错误和身份来自同一个已提交 Result。投影对文件名和命令进行整项保留，避免把截断的路径或命令当作原值。摘要中的测试仍是 Agent 声明。
- 大 Result 的 `projection` 列出截短或省略的字段，包括原始输出及存在的报告修复候选、模型、Usage 和 Timing。用同一 `task_id` 和 `expected_attempt` 读取完整对象。继续任务前先取齐当前验收证据。公共 Result 仍选择当前 Attempt，SQLite 中的原证据继续持久化。
- 已提交 Result、关闭或清理证明、占用释放各自独立。Release 前后都可以读 Result。运行中缺 Result 的错误及含未核实副作用的失败按原语义返回。
- `include_attempt` 仅使用 SQLite 事件行原有 `operation_attempt`。同一页的 Attention 可以指向更新的 Attempt。Skill 用逐事件字段筛选 Startup、Result Commit 和 Release 后，再核对 `result_commit_ref`。默认和显式 `false` 沿用 A0 输出。读路径保留 `max_bytes` 和过长事件的续页行为。
- MCP SDK 对 legacy 协议使用对象根。候选通过共享对象 Schema 和互斥 `oneOf` 描述 `zcode_output` 与 `projection`，运行时也检查互斥。默认输出继续经过 SDK 校验以及原文本序列化。
- MCP 目录消费者如校验固定 Schema 哈希，需刷新目录。生成静态类型的消费者需处理 Result 的两个 Schema 分支。默认调用的 `structuredContent`、文本和错误已分别按 `2025-06-18` 和 `2025-11-25` 协商版本验证。
- SQLite v14、Writer、Host/Worker、注册顺序、Provider 配置及账单流水在 A0 对照范围。候选由现有入口读取和呈现数据。安装版 Codex Host 只把 `structuredContent` 注入下一次模型请求，文本通道不会重复进入模型上下文；真实 Provider 缓存和费用仍未测。
- 安装版 AppServer 的 MCP 行上限为 16,777,216 bytes。32 MiB Result 直读被丢弃，SQLite 原证据保留，但 MCP-only 完整回读不可用。摘要模式可避免先把大正文送入上下文；验收需要完整原文时，超限必须记录缺项并保持未决，不能把摘要当作完整证据。

## 其他候选

Phase 0 对照 `70c1d10b` 增加默认事件预算，会改变 raw 分页；该行为经 ADR-048
接受并进入统一 Preview 候选，但不计入 27.6% 离线代理降幅。`8b58c381` 的 71.1%
目录代理 Token 缩减主要来自删除全部 `outputSchema`，该分支也改了成功与错误文本。
`d6ce456e` / `0b689159` 提供 Result 投影参考。组合分支 `0db2745d` 包括默认
Event 分页变化和更广的 Result 投影。当前 Preview 保留 PR #116 的可选摘要、完整编码
和逐事件归属，并只吸收 Track A 的默认 Event 分页；没有引入 Stable 分支的大范围
Result 重写或 `outputSchema` 删除。
Worker Prompt 重排、历史 Attempt 的公共按键读取、原文分块和 Artifact 存储各自需要独立决策与证据。
