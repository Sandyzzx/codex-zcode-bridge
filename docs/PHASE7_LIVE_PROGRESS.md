# Phase 7 — 在 Codex 中查看实时进度

## 范围

Phase 7 是分支 `phase7-live-progress` 上的增量扩展。V0.1 冻结架构、原有五个 MCP 工具名称和 `TaskResult` 结构均保持不变。MCP server 新增 `zcode_events`；默认 worker adapter 使用 ZCode 本地 `app-server` stdio 协议，在任务运行时接收 session 事件。

## Codex 可以展示什么

`zcode_events` 返回持久化事件，包含递增的 `seq`、时间戳、类型、简短摘要和可选详情。支持按游标读取和长轮询（`wait_ms` 最大 25 秒）。事件文件为 `<data-root>/.tasks/<task_id>/events.jsonl`，大小受 TaskStore 事件字节上限限制。

Worker 会记录任务生命周期、ZCode 启动、session 创建/恢复、runtime 报告的所选模型、可见助手文本增量、工具调用生命周期摘要、可用时的最终 usage、报告解析和终态。不会持久化隐藏推理或原始工具输入/结果。可见助手文本只是输出证据，不能证明其陈述正确。

现有 `zcode_status` 和 `zcode_result` 行为保持不变：`zcode_status` 返回精简快照，`zcode_events` 返回增量事件流，`zcode_result` 返回终态规范化报告。

## Codex 使用流程

1. 调用 `zcode_task` 并保存返回的 `task_id`。
2. 首次使用 `after_seq: 0`。调用 `zcode_events` 时设置 `wait_ms: 25000`；每次响应后将游标更新为 `next_seq`，继续读取直到状态进入终态。
3. 在当前 Codex 对话中向用户概述每批进度。合并可见文本增量，不要逐个播报很小的片段。将所选模型描述为 session 配置；工具事件说明工具名和生命周期状态。
4. 调用 `zcode_result`，检查实际工作区改动并独立验证验收标准，然后再决定是否通过。

`delegate-zcode` 插件 Skill 已包含这些说明，因此 Codex 委派任务时会自动轮询进度流。

## 本机 runtime 协议证据

2026-09-27 在本机已安装的 ZCode CLI 0.16.9 上验证；当时没有发送模型 prompt：

- `zcode.cjs app-server --stdio` 会启动 ZCode Protocol NDJSON server，并发出 `startup/storageState` 通知。
- `session/create` 需要响应名为 `session/requestRuntimePreferences` 的 server 请求。`nativeSearchEnhancementsEnabled`、`memoryEnabled` 和 `askUserQuestionAutoResolutionEnabled` 响应字段被接受。
- `session/create` 返回的 session 快照包含 `session.sessionId`、`session.workspace`、`settings.model.current`、`settings.mode.current` 和 `runtime.eventSeq`。
- `session/subscribe` 接受 `deliveryKind: desktop-continuous`、`includeSnapshot` 和 `afterSeq`，并返回事件游标和快照。
- 本机 bundle 定义的 `session/event` 类型包括 `turn.started`、`turn.completed`、`turn.failed`、`model.streaming` 和 `tool.updated`。`turn.completed` 含有 `response`、usage、token 数和工具调用数。可见文本增量通过 `model.streaming` 且 `kind: text_delta` 传递；推理增量使用其他 kind，不会记录。

以上是对本机打包私有协议的观察，不代表稳定的公开兼容承诺。升级 runtime 后必须重新检查启动握手、session 方法、事件封装及字段。Phase 7 实现当时没有发送真实模型请求，因此流式文本、工具事件、usage 和完成处理当时尚未完成 E2E 验证。后续双轮真实 E2E 结果记录在 [路线图与决策记录](ROADMAP_DECISIONS.md)。

session 快照中的模型表示该 session 的配置模型。旧版 session 事件流本身无法证明每次内部重试或路由请求实际使用的 provider 模型，因此事件流不会声称精确的模型请求次数。

## 故障与恢复

进度事件只追加并保存在本地。MCP server 重启后，可以从持久化游标继续使用 `after_seq` 读取。如果 ZCode worker 退出，TaskManager 现有恢复逻辑会将任务标记为 `worker_lost`；事件流仍可用于诊断。读取时会忽略 JSONL 中被中断的最后一行。

## 操作步骤

构建仓库后，需要刷新本机安装的 Codex 插件，并新建 Codex 对话，确保加载新增 MCP 工具和更新后的 Skill。插件继续使用本仓库的 `dist/src/mcp/main.js` 和本机 ZCode 配置路径。
