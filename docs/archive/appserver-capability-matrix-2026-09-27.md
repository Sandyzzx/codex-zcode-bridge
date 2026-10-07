# ZCode app-server 能力普查

> Status: ARCHIVED
> Date: 2026-09-27
> Superseded by: 2026-10-05 的 app-server 能力探针与 Native CLI 对比（`ZCODE_APPSERVER_EVENT_CAPABILITY_PROBE.md`、`docs/research/`）。
> 历史材料，不指导当前开发。保留用于追溯当时的能力边界与证据等级。

调查日期：2026-09-27
本机版本：ZCode Desktop `3.14.3.7762` / CLI `0.16.9`
Runtime 入口：`<ZCode 安装目录>\resources\glm\zcode.cjs`
Runtime SHA-256：`B1DF2EF3E5BD76C4AF3ECB296BC003A10D3F13191A26610BD0BA940FEADAD529`

本调查只读检查本机 CLI bundle 和 app-server dispatcher，并复用此前通过的双轮真实 E2E 作为实际调用证据。**没有启动额外模型调用、创建额外 session，或写入 ZCode 数据库。** 未知请求参数仍待后续隔离探测。

## 先回答：app-server 是谁提供的？

`app-server` 是 **ZCode 自带的 Agent runtime / CLI 能力**。本机实际启动的是随 ZCode 安装的 `zcode.cjs app-server --stdio`。ZCode 官方 CLI 源码也将 `app-server` 作为原生 CLI 子命令，并把打包态 app-server 描述为 Desktop host 使用的内部协议子进程：[官方 CLI `run.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/src/run.ts)。

本项目实现的是 **Bridge → ZCode 的客户端接入层**：`ZCodeAppServerAdapter` 启动 ZCode 进程、通过 stdio 收发本机协议请求、订阅事件，并把事件映射到 Bridge 的持久化事件流。Codex 侧 MCP server 则是 **Codex → Bridge 的接口**。因此它既不是我们编写了 ZCode Agent，也不是通过 ZCode 的 MCP 工具调用 Agent。

官方仓库包含 app-server 命令实现，但当前查到的官方产品文档没有承诺该 stdio 协议是稳定的第三方 SDK/API。官方源码注释将打包态 app-server 称为 Desktop host 的内部协议子进程；本机 app-server 协议、方法和 payload 应视为版本相关接口，升级后需要重新核验。以上“目前未见稳定兼容承诺”是基于公开文档范围的结论，不代表证明 ZCode 永远不会发布正式 API。

## 证据等级

| 等级 | 含义 |
|---|---|
| **官方资料** | ZCode 官方文档或官方仓库源码明确记载。证明产品/源码具有该能力，不自动证明第三方兼容承诺。 |
| **本机分发实现** | 在本机 `0.16.9` bundle 的方法注册表或 app-server dispatcher 中发现。证明该构建包含相应分发路径；尚未通过请求验证的参数和效果仍属未知。 |
| **本机实际验证** | 本机已向 app-server 发送请求或收到事件，并检查了结果。 |
| **Bridge E2E** | Bridge 经实际 MCP 工具完成了端到端验证。 |

## 能力矩阵

| 能力 | 本机发现/入口 | 当前证据 | 当前结论 |
|---|---|---|---|
| 启动 Agent runtime | `zcode.cjs app-server --stdio` | **官方资料 + Bridge E2E** | ZCode 原生子命令；Bridge 已能启动和关闭该进程。stdio 上使用 `{id, method, params}` 一类 NDJSON 消息，当前观察到的封装没有 JSON-RPC 2.0 的 `jsonrpc` 字段。 |
| Runtime 初始化 | `session/requestRuntimePreferences` 反向请求 | **本机实际验证 + Bridge E2E** | 创建 session 前需要响应；本机接受 `nativeSearchEnhancementsEnabled`、`memoryEnabled`、`askUserQuestionAutoResolutionEnabled` 三个布尔值。当前 Bridge 统一回复 `false`。 |
| 创建/恢复 session | `session/create`、`session/resume` | **本机实际验证 + Bridge E2E** | Bridge 创建 session、订阅事件、发送任务，并在续作中恢复原 session；双轮 E2E 的 session ID 相同。workspace 字段为 `{workspacePath, workspaceKey}`；创建还传 `mode: "yolo"`、`persistence: "immediate"`。这里只验证了这些参数组合。 |
| 读取所选模型 | 创建/恢复返回的 session snapshot：`settings.model.current` | **本机实际验证 + Bridge E2E** | E2E 观测到模型元数据并将其写入事件。它表示 session 报告的配置模型，不证明每次内部重试或路由请求的最终 provider。 |
| 设置模型 | `session/setModel` | **Bridge 已实现；模型目录及 snapshot 运行时核验** | Bridge 支持任务级覆盖用户默认；将请求与 runtime model catalog 比较，并核对设置后的 snapshot。是否真实发出模型请求需按任务 E2E 验证。 |
| 设置思考等级 | `session/setThoughtLevel` | **本机分发实现** | 方法名及 dispatcher 分支存在；参数、支持等级、默认继承与实际生效情况未验证。 |
| 设置权限模式 | `session/setMode` / create `mode` | **Bridge 已实现；调用语义只核对到响应/snapshot** | 新建与续作 session 采用用户配置的 `plan`、`build`、`edit` 或 `yolo`；逐工具门控效果、权限反向 RPC 和 ask 回传尚未验证。 |
| Session 生命周期 | `session/list`、`session/read`、`session/messages`、`session/events`、`session/close`、`session/fork` | **本机分发实现** | 本机构建中有对应分发路径；未验证数据范围、恢复语义或对 Desktop 历史的影响。 |
| 发送/停止/取消 | `session/send`、`session/stop`、`session/cancelBackgroundTask` | **本机分发实现；部分 E2E** | Bridge 已验证发送初始任务和续作 prompt；取消目前通过终止 worker 进程树实现。运行中发送是否等同安全 steering、stop 与 cancelBackgroundTask 的精确行为尚未验证。 |
| 实时引导 | bundle 中有 `turn.steer.*` 事件名；V4 统一入口 `v4/command` | **本机分发实现** | 未发现 `session/steer` 方法名。发送/引导的具体 payload、`requestedDelivery: "guide"` 是否适用于本机构建、确认事件和取消语义均未验证。 |
| 模型文本与工具事件 | `session/subscribe`；事件 `session/event`；含 `turn.started`、`model.streaming`、`tool.updated`、`turn.completed`、`turn.failed` | **本机实际验证 + Bridge E2E** | 双轮 E2E 收到了可见文本、模型工具调用、工具状态、turn 开始/结束和 runtime 状态事件。Bridge 不存隐藏推理或原始工具参数。 |
| Usage | `turn.completed` payload；`session/usage`、`v4/usage/stats`、`v4/conversation/usage` | **部分 Bridge E2E；其余本机分发实现** | E2E 两个 turn 均出现 usage 事件；本阶段没有独立验证 token 字段是否完整、session 汇总口径或统计 API 的参数。 |
| Goal / compact | `session/goal`、`session/compact`；另有 `v4/command`、`v4/commands/query` | **官方产品文档 + 本机分发实现；Bridge 未调用** | ZCode 自带自动上下文压缩；社区 ACP 额外提供 turn 后 threshold→`session/compact`，但 Bridge 尚无稳定 context occupancy 信号，暂不重复实现。[官方命令文档](https://zcode.z.ai/en/docs/commands) [模型上下文说明](https://zcode.z.ai/en/docs/configuration) |
| Plans、文件变更与回退预览 | `v4/conversation/plans`、`v4/conversation/fileChanges`、`v4/conversation/fileRewindPreview` | **本机分发实现** | 存在 V4 gateway 调用路径。可能提供比 Agent 自报 `files_changed` 更有用的证据；返回结构、revision 语义及能否对应当前 session 尚未验证。 |
| Subagents | `session/subagents` | **本机分发实现** | 有相应分发路径；本阶段未调用，也未确认主 session 是否能创建、控制或读取其结果。官方 Subagent 文档只能证明产品能力，不证明 app-server 请求契约。 |
| Hooks/权限请求 | `interaction/requestPermission` 字符串；`workspace/hooks/trustGrant`；工具权限相关事件字符串 | **部分本机分发实现，Bridge 未验证** | 存在相关协议痕迹，但没有验证 app-server 创建的 session 是否触发 ZCode Plugin Hooks，也没有验证 Master 决策往返。Bridge 当前只响应 `session/requestRuntimePreferences`；其他携带 `id + method` 的未知反向请求会以 `-32601` 拒绝。 |
| MCP/插件/工作流配置 | `mcp/list`、`plugins/*`、`skills/*`、`workflows/*` 等 dispatcher 路径 | **本机分发实现** | ZCode runtime 包含这些内部管理路径；Bridge 没有把它们作为对外功能，本阶段也未改变本机配置。 |
| Task 注册 / Desktop 历史索引 | `<ZCODE_HOME>/v2/tasks-index.sqlite` 的 `tasks` 表 | **本机 schema/status 只读检查；Bridge best-effort 实现** | 登记由 app-server 创建的 session，并同步 running/completed/error；取消时清空活动状态。直接 SQLite 写入不会向 Desktop 进程推事件，需刷新列表；索引失败不影响 ZCode 执行。 |
| Automation | bundle 方法名表含 `automation/create|list|update|delete` 字符串；在本次检查的 app-server `dispatchRequest` 中未找到对应分支 | **本机分发未确认** | 这些字符串不能作为 app-server 可调用方法的证据；可能属于 Desktop 内部其他通信层。官方 UI 有 Automation，但没有据此推断 Bridge 可调用的协议 API。[官方 Automation 文档](https://zcode.z.ai/en/docs/automations) |

## 本机事件观察

| 事件类别 | 本机/Bridge 已见内容 | 是否通过本次 Bridge E2E |
|---|---|---|
| Session 建立 | `session_ready`，含 session ID、配置模型（有报告时）和工作区路径 | 是 |
| Turn 生命周期 | `turn.started`、`turn.completed`；bundle 还包含 `turn.failed` 等路径 | started/completed 是；failed 未触发 |
| 模型流 | `model.streaming`；文本增量和 tool-call kind 被分别处理，推理 kind 被过滤 | 可见文本和模型工具调用是 |
| 工具生命周期 | `tool.updated`；含工具名、调用 ID（有报告时）和状态 | 是 |
| Runtime 状态 | `state.updated` → `runtime_state` | 是 |
| 用量 | `turn.completed` 中存在 usage | 是；本报告不记录 token 总量 |
| Steering / 权限 | bundle 中存在 steer/permission 相关标记 | 否 |

## 接入边界与后续

1. 继续把 `app-server` 当成本机 ZCode runtime 的版本化适配层，不把目前观察到的字段当作稳定公共 API。
2. Phase 10 在临时工作区中分别探测 `session/setModel`、`session/setThoughtLevel` 和 `session/setMode`：每次只变更一个字段，核对响应、后续 snapshot、事件和一次无害任务的实际效果；探测前先处理 provider/model revision 兼容问题。
3. task-index 直写已实现为 best-effort；不要据此调用 `automation/*`、批准权限请求或发送 steering。这些需要各自的可恢复性和安全策略。
4. Hook/审批路线需要先验证 ZCode Plugin Hook 是否被 app-server session 调用，以及 Hook 子进程能否取得 task/session 策略上下文。`PreToolUse`/`PermissionRequest` 的存在不自动建立 Codex 的审批回调。
5. 每次升级 ZCode 后重新生成方法/事件差异，并至少重跑 session create/resume、事件流和取消路径的回归验证。

## 参考资料

- [ZCode 官方 CLI `run.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/src/run.ts)：确认 `app-server` 是 ZCode CLI 子命令；源码将打包态协议进程描述为 Desktop host 内部进程。
- [ZCode Agent Framework](https://zcode.z.ai/en/docs/agent-framework)：官方产品层 Agent、任务、模型和权限模式说明。
- [ZCode Hooks](https://zcode.z.ai/en/docs/hooks)：Hook 子进程协议、工具前/后事件和决策返回格式。
- [ZCode Commands](https://zcode.z.ai/en/docs/commands)：官方 `/goal`、`/compact` 命令说明。
- [ZCode Automations](https://zcode.z.ai/en/docs/automations)：官方自动化 UI 与本机运行限制。
- [本机 Phase 7 协议记录](phase7-live-progress.md) 和 [双轮 E2E 决策记录](../decisions/roadmap-decisions-2026-09-27.md)。
- 社区协议逆向：[ZCode app-server V4 协议笔记](https://github.com/csuftt/zcode-jetbrains-plugin/blob/master/docs/zcode-appserver-protocol.md)。该资料不是官方兼容承诺。
