# Bridge 路线图与决策记录

> Status: DECISION
> Date: 2026-09-27
> 当时的路线图与决策记录。其中仍然成立的结论应提炼进 `ARCHITECTURE.md` / `INTERFACES.md`；本文本身不作为当前事实来源。

日期：2026-09-27
分支：`phase7-live-progress`

本文汇总近期关于 Codex → ZCode 委派的讨论，覆盖安全性、运行可见性、ZCode Desktop 中的会话可见性、未确认事项和建议实施顺序。本文不修改冻结的 V0.1 接口。

## 当前基线

- MCP 使用官方模块化 TypeScript SDK v2.1.0 和 Zod 4。迁移后已通过类型检查和构建；迁移时未运行完整测试套件。
- Phase 7 在原有五个 V0.1 工具之外增加 `zcode_events`。运行时提供相应信息时，事件会保存所选模型、可见的助手文本、工具生命周期摘要、用量和任务生命周期。
- Bridge 当前只有一个全局 worker 槽位，并直接使用指定工作区。ZCode app-server 协议是私有且随版本变化的；本机观察结果针对 ZCode CLI 0.16.9。
- `zcode_continue` 会尝试恢复保存的 ZCode session。CLI `--resume` 已单独验证；Phase 7 文档编写时，app-server 流式路径还未完成端到端验证。
- 第一次真实 Phase 8 验证发现接线缺陷：`run-task.ts` 默认使用 `ZCodeAppServerAdapter`，但 `worker-main.ts` 显式注入了旧 CLI adapter，导致 app-server 进度事件被绕过。现已改为由 `run-task.ts` 创建 adapter 并安装事件持久化回调；完整 E2E 已通过，见文末记录。
- `src/prompts/task-prompt.ts` 已根据类型化 `TaskPackage` 生成有界 worker 提示。插件 Skill 已说明委派、轮询事件、独立检查 diff 和验收结果。
- `allowed_paths` 和 `forbidden_paths` 是提示约束。Direct 模式不会在操作系统层面强制执行这些路径限制。ZCode 任务目前使用 `yolo` 模式。
- 开源审查阶段曾加入 unrestricted-execution opt-in；后续产品决策移除此 Bridge 专用开关，任务默认以 ZCode app-server `yolo` 模式启动。子进程环境白名单、常见凭据路径快照排除和本地任务数据权限加固仍保留，但都不把 `yolo` 模式或 Git worktree 变成 OS 沙箱。

## 设计讨论与决策

### Agent 协作契约

让以下三种职责保持清晰：

1. **Master 指令**由 Codex 插件 Skill 承载：决定哪些已获用户授权的实现工作适合委派；架构和验收决定仍由 Codex 负责；ZCode 工作期间不允许并发修改同一工作区；结果必须独立审查。
2. **任务契约**继续使用现有严格的 `TaskPackage`：目标、要求、允许/禁止路径、验收标准、测试命令和可选上下文。不要为同一契约再造模板或 schema。任何改变冻结 MCP 契约的新字段，都需要单独批准架构更新。
3. **Worker 指令**继续由 prompt builder 生成简洁且稳定的策略：检查相关代码、遵守任务边界、不擅自重设计全局架构、运行适用检查、如实报告，并把超出权限的决定交给 Master。

这些指令可以改善行为，但不构成硬性的权限边界。真正的隔离需要沙箱、worktree 或运行时提供的权限门控。

### ZCode 原生控制能力与 Bridge 支持情况

用户提供的分析方向基本正确：模型、思考等级、执行模式、Hooks 和自动化属于 ZCode Agent/runtime 层；MCP 是 Bridge 的控制协议，本身并不提供这些控制能力。ZCode 当前官方文档确认产品界面提供模型选择、按模型区分的思考等级、四种执行模式、Hooks 和定时自动化。这只能证明产品层能力，**不能**证明本机私有 app-server 接受相同配置，也不能证明 Bridge 已映射这些选项。

| 能力 | 官方产品文档 | Bridge / 本机 runtime 状态 | 建议 |
|---|---|---|---|
| 覆盖模型 | ZCode Agent 和自动化可选模型；自动化模型留空时使用项目默认值。 | 尚未验证本机 app-server 请求。CLI 帮助和现有 runtime 证据不能证明主任务支持模型参数。 | 先探测创建 app-server session 的请求和持久化行为。省略时应使用 ZCode/项目默认模型；不要在 Skill 中写死模型。 |
| 思考等级 | ZCode 文档说明等级和默认值依模型而异；自动化可留空以继承项目默认值。 | Bridge 尚未验证。Subagent 的 `thoughtLevel` 仅有子 Agent 文档依据，不能假定它能配置主 session。 | 在模型选择探测后再验证；依据所选模型校验等级，省略时保留默认值。 |
| 权限/执行模式 | 产品文档列出 Ask before changes、Edit automatically、Plan 和 Full access。 | 本机 CLI 接受过 `--mode yolo`；各工具的具体权限语义及 app-server 配置能力尚未单独验证。Bridge 当前固定使用 `yolo`。 | 只有在确认 app-server 支持并验证文件/命令门控生效后，才加入类型化且保守的模式映射。 |
| Hooks | 官方文档说明 `PreToolUse` 可 allow/ask/deny，`PermissionRequest` 可处理权限请求，另有工具后置和 Stop hooks。 | Bridge 尚无 hook 决策通道或 runtime E2E。官方页面当前指出项目级 Hooks 会被忽略；还需核实本机版本支持的配置来源。 | 只有确认 app-server session 会触发 Hooks，且 Codex 能收到并返回持久、可关联的决定后，才将 Hooks 用于权限执行。否则不要宣称 Master 审批已强制生效。 |
| 工具/MCP 白名单 | ZCode 文档说明自定义 subagent 可配置工具和 MCP server。 | 这不能证明主任务 session 支持穷尽式白名单。 | 确认适用范围后再暴露。它与仅作为提示约束的 `allowed_paths` 是两种不同能力。 |
| 自动化 | 官方文档确认可配置计划、项目、权限、模型、思考等级，以及立即运行、暂停、编辑、删除和绑定当前 session。它受产品配额和本机可用性限制。 | Bridge 尚无自动化工具；私有 API、任务索引以及事件/结果映射均未验证。 | 等单次任务、权限、session 所属关系和 Desktop 可见性验证完成后再做。若存在受支持 API，优先调用 ZCode 原生调度，不另造 Bridge cron。 |
| Session 连续性 | 官方 Agent 文档描述多轮连续交互；本机 CLI `--resume` 已在 `docs/ZCODE_RUNTIME.md` 中独立验证。 | Bridge app-server 续作已通过下文双轮真实 E2E，session ID 相同。 | ZCode/runtime 升级后将此项保留为回归验收。 |

统一的 `execution_config`（模型、思考等级、权限和工具）是合理的未来接口，但冻结的 V0.1 MCP schema 不包含它。在能力探测完成前继续冻结契约。之后再提出版本化的增量 schema，明确每个字段省略时的含义、支持值校验、续作继承规则，以及产品默认值和 Bridge 覆盖值之间的区别。不要根据仅适用于 subagent 的文档为主任务加入 `max_turns`。

### Master 决策与 runtime 权限

现有 `needs_master_decision` 和 `waiting_for_master` 表示报告完成后的升级请求，不会暂停正在运行的 ZCode 工具调用。当前 app-server adapter 会响应已观察到的 `session/requestRuntimePreferences` 请求，并拒绝其他入站 server 请求；它尚未把待处理的工具审批转发给 Codex。

在设计 `zcode_decisions` / `zcode_respond_decision` 前，先探测本机 runtime 的 `interaction/requestPermission` 行为与响应契约。如果实现，待处理决定需要可持久化的身份、超时和取消语义，以及不会冒充现有终态的状态模型。

### Session 连续性与运行中引导

续作路径会保存 session ID、调用 `session/resume`，并在恢复的 session 中发送反馈。此路径已纳入真实 E2E。

当前 ZCode 版本不应继续寻找 `session/steer` RPC：社区协议笔记称该接口在 app-server 0.16+ 已移除。本机 bundle 含有 `v4/command`；社区资料将 `sendText` 配合 `requestedDelivery: "guide"` 描述为在安全 turn 边界注入文本的 V4 路径。Bridge 尚未实现或验证该命令。它的 payload 和回退行为仍属于 runtime 专属假设，需实测。

### 文件变更与测试证据

当前事件流概述工具生命周期，但不提供已验证的逐文件 diff。`TaskResult.files_changed` 和测试报告只是 ZCode 的声明，Codex 必须检查实际工作区 diff 并独立运行验收。后续可根据 Git 或工作区快照生成精简的文件/测试摘要，并明确标记缺失证据。

### 上下文与成本预算

保留有界事件存储。为 Master 轮询提供精简摘要，只有在需要时再读取详情。分别统计返回给 Codex 的字符/字节数和 ZCode 实际提供的 token 用量；没有实际 usage 数据时不得根据字符数估算 token 或费用。

### ZCode Desktop 可见性

将 session 持久化与 Desktop 任务列表索引视作不同问题。社区资料称直接创建的 app-server session 可能已持久化，却没有登记到 `~/.zcode/v2/tasks-index.sqlite`。社区 `zcode-acp-server` 项目记录了同步 task-index 行的做法，让 ACP 创建的 session 出现在 ZCode App 历史中。建议先固定依赖版本做原型，或复用其公开说明中的逻辑，不要从零猜测私有 SQLite schema。该行为不是 ZCode 官方兼容承诺。

索引可见不代表 ZCode Desktop 在技术上只读。Codex 控制任务期间，在单一控制方行为经过设计和验证前，不要同时在 Desktop session 输入命令。共享持久化也不能证明并发控制安全。

### 工作区隔离与并行工作

在开启并行任务前，重要仓库应先支持 worktree/clone 隔离。当前 V0.1 Bridge 只有一个 worker 槽位，直接使用工作区，而且没有跨进程 manager 锁。安全并行需要工作区隔离、任务依赖图、冲突处理和可恢复的所有权记录，应放在单 worker runtime 验证之后。

## 建议实施顺序（本轮讨论稿）

Phase 8A 的双轮真实 E2E 已完成。以下顺序吸收了 Hook 分析与 app-server 控制面分析，作为待讨论方案，不是新的冻结架构或接口承诺。

| 顺序 | 阶段 | 范围 | 完成证据 |
|---|---|---|---|
| 1 | Phase 9 — app-server 能力普查 | 静态检查本机 3.14.3.7762 / CLI 0.16.9 的 command、request、event 和 app-server dispatcher；覆盖 session、配置、steering、task 注册、usage、subagent、compact/goal、Automation。区分官方产品功能、本机协议出现、Bridge 端到端验证三种证据。 | [中文能力矩阵](../archive/appserver-capability-matrix-2026-09-27.md) 已记录入口、主要方法、事件、证据等级和版本边界。静态普查完成；未知参数和行为留待隔离探测。**本阶段完成。**（该矩阵已被 2026-10-05 的能力探针取代，见 `docs/README.md`。） |
| 2 | Phase 10 — 模型与思考等级映射 | 先单独探测模型及思考等级配置；省略时继承 ZCode 默认值。权限模式只做协议探测和隔离环境验证，暂不向日常任务开放高权限选项。 | 每项参数分别验证设置请求、session 快照、实际模型元数据及续作继承；不支持项有明确回退。 |
| 3 | Phase 11 — ZCode companion 插件 / Hook 原型 | 保留 Codex 插件作为 MCP 与 Master Skill 入口；另做最小 ZCode 插件实验，验证 app-server 创建的 session 是否触发 Hooks。先记录事件，再在临时仓库测试确定性 deny；不把 Hook 当作 OS 沙箱。 | Hook 输入字段、工具名、路径/命令信息、触发时序、超时和返回结果均有本机证据；绕过路径（特别是 Bash）被明确列出。 |
| 4 | Phase 12 — 工作区隔离 | 以 Git worktree/clone 承载可写任务，定义创建、回收、检查、应用和丢弃；把 `allowed_paths` 与 `forbidden_paths` 纳入规范化路径判定。 | 未显式 apply 前，主工作区保持不变；清理与崩溃恢复可验证。 |
| 5 | Phase 13 — Master 审批往返与策略执行 | 在 Hook 能同步阻止工具且可关联 task/session/tool call 的前提下，设计持久 decision inbox 和 MCP 查询/响应工具。区分 `PreToolUse` 的 ask/deny 与 `PermissionRequest` 的用户确认流程；为等待状态、超时、取消、Bridge 重启定义语义。 | Codex 能看到具体工具请求并批准/拒绝；决定回到同一 Hook 调用；超时、取消或 Bridge 不可用时 fail-closed，不会静默放行。 |
| 6 | Phase 14 — ZCode Desktop 可见性 | 验证 app-server session 与 task index 的关系，研究官方/社区支持路径；先只读调查，之后才在隔离数据环境做索引原型。 | 临时任务在 Desktop 历史中可见且完成后可打开；不与 Codex 并发控制同一 session。 |
| 7 | Phase 15 — 运行中控制与 Agent 原生能力 | 根据 capability matrix 选择实现 `sendText`/steering、`/goal`、`/compact`、subagents 等。逐项验证请求、事件、状态和续作，不因 Desktop 有该功能就推断 app-server 也暴露。 | 每项能力都有受支持的调用路径、确认事件、取消/恢复语义和失败回退。 |
| 8 | Phase 16 — ZCode 原生 Automation | 先确认是否存在可调用且受支持的 API；若只有 UI/私有存储路径，暂缓 Bridge 自动化工具。优先调用 ZCode 原生 scheduler，不另建 cron 系统。 | 创建、立即运行、暂停、恢复、删除及运行历史均可关联到项目/session/task，并有持久化证据。 |
| 9 | Phase 17 — 并行委派 | 工作区隔离、decision 状态和跨进程协调稳定后，再增加 worker 槽位及任务依赖。 | 并行任务能在重启后恢复，不会双重调度或写冲突。 |

### 并行 worker 原型（2026-09-28）

在 `codex/parallel-multi-project` 分支实现可选的单进程多 worker 调度：`ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS` 接受 1–8；当前代码默认 8，不同或隔离执行路径可并行，同一或嵌套执行路径互斥。该保证仅限单个 Bridge 进程；跨进程锁尚未实现，因此共享数据目录的多个 Bridge 进程不应并行运行。排队仍按创建时间排序，遇到被占用路径时会跳过该项以使用空闲槽位。

2026-09-28 的真实 E2E 使用 Coding Plan `GLM-5.3-Flash` 完成了四次调用：两个独立项目同时运行，以及同一项目的两个真实 Git worktree 同时运行。每对任务均观察到两个 worker PID 同时处于 running、不同 session ID、模型选择正确、各自在指定目录生成唯一文件；四个任务均发出 `desktop_task_registered`，验证了并发 task-index 登记没有报错。临时任务、工作区和测试仓库已清理。该测试没有确认 Desktop UI 是否刷新显示，也没有并发切换不同 provider/model。

当前原型没有实现跨 Bridge 进程的全局调度锁，因此并发保证仅适用于单个 MCP server 进程。多 worker 会启动多个独立 app-server；account provider 配置同步的并发竞争及多 provider/model 并行尚未验证。默认保持 1；在跨进程协调与 provider 切换验证完成前，不要提高默认值或让多个 Bridge 进程共享数据目录。

### 两份分析的关键判断

- **同意控制路径的区分**：ZCode 的 MCP 是把外部工具接入 ZCode Agent；本项目的 Codex MCP 是 Codex 到 Bridge 的 API；Bridge 到 ZCode 使用本机 app-server/runtime。模型 Provider API 只提供模型推理，不能替代 Agent 的文件、终端、权限、MCP 和 session 行为。[ZCode MCP 文档](https://zcode.z.ai/en/docs/mcp-services) 将 MCP 描述为向 Agent 接入外部能力；[Agent Framework 文档](https://zcode.z.ai/en/docs/agent-framework) 描述的是 ZCode 产品中的 Agent 能力，并未因此承诺公开稳定的第三方 app-server SDK。
- **Phase 7 的进度流已实测**：最近的双轮 E2E 已经证实 Bridge 可从本机 app-server 接收模型可见文本、工具生命周期、模型元数据和 turn 事件，并在同一 session 续作。这只证明已测试的接口，不证明 model override、permission mode、task indexing、steering 或 Automation 都对第三方稳定开放。
- **Hook 不是“每个事件都会暂停”**：官方定义 Hook 为本机子进程协议；`PreToolUse` 可对工具调用 allow/ask/deny，`PermissionRequest` 在权限结果需要用户确认时触发，`PostToolUse` 在工具成功后运行，`Stop` 可让模型继续有限轮次。只有特定事件有门控作用。[Hooks 官方说明](https://zcode.z.ai/en/docs/hooks)
- **`ask` 不等于 Codex 已拿到审批**：官方 Hook 的 allow/deny/ask 和 `PermissionRequest` 输出是 ZCode Hook 协议。如何将挂起决定交给 Codex、等待期间是否保持工具调用、Hook 超时行为，必须在本机实测。Bridge 需要独立的 decision identity、MCP 往返、超时、取消、崩溃恢复和非终态状态模型；当前 `waiting_for_master` 是终态报告，不能直接复用为暂停中的审批状态。
- **Hook 增强的是工具门控，不等于 OS 沙箱**：即使 `Edit` / `Write` 的 Hook 能拦截越界路径，Bash/终端仍可能通过命令或脚本修改文件。需要确定命令策略并使用 worktree/clone 限制影响面；不要声称只加 Hook 就“根本改不了”。
- **双插件架构值得验证，但不必先拆仓库**：Codex 侧插件继续负责 MCP 配置和 Master Skill；ZCode 侧 companion 插件可以打包 Hooks、Skills、Commands、Subagents 和 MCP 配置。[ZCode 插件文档](https://zcode.z.ai/en/docs/plugin) 确认了这些组件类型。先做本地原型，验证 app-server session 能否加载、Hook 能否获得 task/session 上下文；验证后再决定是否以同一仓库的两个插件包发布。
- **产品功能不等于控制 API**：官方确认 `/goal` 与 `/compact` 是 ZCode 命令能力，[Goal 文档](https://zcode.z.ai/en/docs/goal) 描述了 goal 循环。但 command palette、Desktop Automation 或 Subagent 配置存在，不代表 app-server 有等价第三方请求。Automation 也应优先复用 ZCode 原生计划能力；[官方自动化文档](https://zcode.z.ai/en/docs/automations) 描述了 UI 功能及其本机运行限制，但没有证明公开调度 API。

因此，Phase 9 的静态能力普查已完成。接下来建议推进 **Phase 10：模型与思考等级映射探测**，并在隔离工作区逐项验证请求、响应和效果。权限模式暂不向日常任务开放；先等 Hook 和工作区隔离策略明确。V0.1 接口继续冻结；任何 `execution_config`、`policy` 或 decision 工具都应在证据齐备后另提版本化方案。

## MVP 实施期间补充的参考结论（2026-09-27）

用户提供的社区项目梳理有助于减少协议摸索，但它描述的是不同项目、不同提交和运行版本的观测，不能直接当成本机 ZCode 3.14.3.7762 / CLI 0.16.9 的兼容承诺。

| 参考项目 | 本项目采用的参考点 | 本项目不据此推断 |
|---|---|---|
| [william0wang/zcode-acp](https://github.com/william0wang/zcode-acp) | 将真实 `zcode app-server --stdio` 作为运行时；关注 backend client、事件转换、交互处理和版本兼容记录的分层。其 README 明确标记 CLI 0.16+ 对 steer/rewind 的变化。 | ACP 是 Codex 的必要入口；其列出的 mode、thought、权限、task-index、quota 或 remote 功能在本机都可用。该项目仍在开发，需针对固定 commit 和本机 runtime 复核。 |
| [csuftt/zcode-jetbrains-plugin](https://github.com/csuftt/zcode-jetbrains-plugin) | 作为 app-server 消息和更完整 UI 活动映射的二级研究资料。 | 逆向协议文档等同官方规范；其 UI、V4 API 或权限流程是 MVP 必需项。 |
| [KyoMio/zcode-executor](https://github.com/KyoMio/zcode-executor) | 关注其隔离 worktree 与 Git diff 验收和权限门控的工程实践。 | 社区测试中出现的 `session/requestRuntimePreferences` 或 `session/create` 参数可直接复制到当前 Bridge。 |
| [jpalmae/zcode-acp](https://github.com/jpalmae/zcode-acp) | 参考 transport / protocol / adapter 分层，避免后续把 stdio、JSON-RPC 和任务语义混成一层。 | 需要引入 ACP 或照搬 Rust 结构。 |
| [ZhouXiaolin/zcode-provider](https://github.com/ZhouXiaolin/zcode-provider) | 将来研究模型发现和 `session/setModel` 工作流时作为补充线索。 | 本 MVP 需要新增模型目录 API；当前 MVP 支持明确 provider/model ID，并在运行时核验实际选择。 |

`zcode-acp` 的公开 README 将自己定位为面向 ACP host 的适配器，并称其启动官方 ZCode app-server、转换事件和交互请求；其 README 还列出当前支持范围及 0.16+ 的 steer/rewind 边界。这足以把它列为首要**研究参考**，但不是本项目依赖或协议规范。本文根据其公开仓库首页作范围筛选；在复用任一具体实现前，还需固定 commit、核对许可证和代码，并在本机版本验证行为。

对当前 MVP 的直接影响只有两项：继续使用真实 app-server 而非直接调用模型 API；在已有功能扩展时逐步分离 protocol client、任务 adapter 和 Codex MCP 层。当前实现的模型选择、事件流、续作和 Git worktree 已分别由本机 runtime 检查、回归测试或真实 E2E 验证；尚未验证的思考等级、权限交互、steering、task-index 和桌面历史可见性仍留在后续研究列表。

## 参考资料与兼容性说明

- [ZCode ACP server](https://github.com/william0wang/zcode-acp)：社区 ACP adapter、task-index 同步、事件转换、权限和 runtime 兼容性记录。Apache-2.0，仍在积极开发。
- [ZCode ACP 协议说明](https://github.com/william0wang/zcode-acp/blob/main/docs/PROTOCOL.md)：记录 `session/steer` 在 0.16+ 移除的社区观察。
- [ZCode app-server V4 协议说明](https://github.com/csuftt/zcode-jetbrains-plugin/blob/master/docs/zcode-appserver-protocol.md)：社区对 V4 conversation 和 command 方法的逆向研究。
- [Agent Client Protocol Codex adapter](https://github.com/agentclientprotocol/codex-acp)：可参考事件、权限和 session 设计，但后端仅适用于 Codex。
- [polyagent-mcp](https://github.com/JaimeJunr/polyagent-mcp) 与 [cc-plugin-codex](https://github.com/hex1n/cc-plugin-codex)：可参考 Master 路由、类型化任务控制、输出预算和状态门控流程。
- [ZCode Agent](https://zcode.z.ai/en/docs/agents) 与 [安全确认](https://zcode.z.ai/en/docs/safety-confirm)：官方产品层的模型、思考等级和执行模式控制。
- [ZCode Hooks](https://zcode.z.ai/en/docs/hooks)：官方 Hook 事件、决策输出及配置范围注意事项。
- [ZCode Automations](https://zcode.z.ai/en/docs/automations)：官方调度控制、session 绑定、可用性限制和运行历史。
- [ZCode Subagents](https://zcode.z.ai/en/docs/subagents)：说明 subagent 的 `thoughtLevel`、工具白名单和 `maxTurns`；没有单独证据时，不要将其视为主 session 控制项。

以上 app-server 和 task-index 细节均为社区观察或本机特定版本证据，不是稳定的官方 API 承诺。升级 ZCode 后需要重新检查。

## 回归初心后的 MVP 优先级

目标收敛为：Codex 能把用户已授权的开发任务交给 ZCode，选择本次任务的模型，在 Codex 查看执行过程，审查改动并决定是否应用。

### MVP 必须具备

| 能力 | 当前状态 | 验收边界 |
|---|---|---|
| Codex 插件作为 Master 指令与 MCP 入口 | 插件 0.3.0 已安装并启用；MCP stdio 工具清单和插件缓存配置已验证 | Codex 能按 Skill 调用 Bridge，而不依赖 ZCode 插件。新线程加载新 Skill/MCP 工具。 |
| 单任务派发、排队、取消、续作、持久化 | 已实现 | Bridge 重启后能恢复状态；续作恢复原 session 和 worktree。 |
| Codex 中的状态、模型可见输出、工具活动和结果 | Phase 7 已有，真实双轮 E2E 通过 | 任务期间可用 zcode_events 增量读取，终态由 zcode_result 提供。 |
| 按任务选择模型 | 已接入任务级 provider_id/model_id、用户默认 provider/model 与优先级；runtime snapshot 校验实际模型 | 任务级覆盖用户默认；两者都未配置时继承 ZCode 默认。默认值及跨模型切换仍需本机实际模型请求验证。 |
| 执行模式可配置 | 已实现新建 session 的 `plan`/`build`/`edit`/`yolo` 配置，续作时调用 `session/setMode`；默认仍为 `yolo` | Bridge 报告 runtime 配置值；逐项权限交互、模式权限语义和 ask 回传尚未 E2E 验证。 |
| ZCode Desktop 会话可发现 | 已实现 best-effort tasks-index 登记和运行/完成/失败状态同步；本机 schema/status 已只读检查 | Bridge 数据库写入不会向 Desktop 进程发实时事件；需刷新列表。已取消状态清除任务索引活动状态，因为 schema 没有 `cancelled` 值。 |
| 隔离可审查的工作区 | 已实现 Git worktree 和 dirty snapshot | 源工作区保持不变；改动留在任务 worktree，Codex 审查后才应用。不是 OS 沙箱。 |
| Codex 独立审查与验收 | 插件 Skill 已说明；真实 MVP E2E 独立检查唯一改动文件、源目录、禁改文件和测试 | Agent 自报不能替代实际 diff、文件和测试检查。 |

### MVP 暂不需要

ZCode Companion 插件/Hook、Master 审批往返、运行中 steering、goal/subagents、Automation、并行 worker、自动合并、模型目录 UI 和 OS 级沙箱。模式配置已提供，但权限审批往返不是它的等价替代。

### 推荐顺序

1. **已完成**：app-server 指定模型检查、dirty Git 工作区快照和隔离执行的真实 E2E。
2. **已完成**：个人 marketplace 中 Codex 插件 0.3.0 安装并启用；配置包含本机 MCP 入口和有效 provider 配置路径。
3. **已完成**：独立 diff/文件/测试验收和中文文档状态更新。
4. 真实使用验证用户默认模型、任务级覆盖、非默认 `ZCODE_HOME` 和每种执行模式；不默认提交真实任务或更改本机 Desktop 数据库。
5. 根据真实使用反馈再决定 Hooks 审批往返、运行中 steering、goal 与并行。

V0.1 冻结文件保留为历史契约。模型选择和 worktree 是版本化的增量，记录于 docs/MVP_V0.3.md；不要把它们误标成 V0.1 的原始能力。

## 真实 E2E 记录

**状态：通过。** 2026-09-27 使用本机 ZCode app-server，并通过插件 MCP 配置运行。前两次诊断发现 `worker-main.ts` 绕过了进度事件持久化回调；改为由 `run-task.ts` 创建 adapter 后，完整两轮 E2E 通过。

- 首轮和续作均为 `completed`；续作 attempt 为 2，返回了与首轮相同的 session ID（具体值已从公开文档移除）。
- ZCode 报告所选模型为 `deepseek-flash`。事件中观察到可见的 `model_output`、`model_tool_call`、`tool_status`、`session_ready`、`turn_started`、`turn_completed` 和 `runtime_state`。两轮合计 74 个事件、16 个可见文本事件、35 个工具生命周期事件和 2 个 turn usage 事件。运行时提供了 usage；本文不据此估算 token 或费用。
- 独立运行的 Python `unittest` 首轮通过 6 项，续作后通过 18 项。工作区仅包含 `README.txt`、`calculator.py`、`test_calculator.py`；README 内容未变。
- 任务到达终态后，临时工作区和 Bridge 数据目录均已删除。一次性 E2E 驱动也已从仓库移除。本次没有验证 ZCode Desktop 历史索引、Hook 权限往返或模型/思考等级/权限覆盖。

这完成了最重要的 Phase 8 运行证明：实际进度经 MCP 事件工具可见，续作恢复了同一 session。上文讨论的官方产品控制能力仍需单独探测，没有因本次 E2E 而宣称已由 Bridge 实现。

### MVP 0.3 模型与 worktree E2E（2026-09-27）

**状态：通过。** 使用安装的 ZCode app-server，通过 stdio MCP Bridge 启动一个临时 Git 项目。显式提交模型 `deepseek-flash`（provider/model ID 见任务输入）；session 快照报告目标模型，任务在 Bridge 生成的 worktree 中完成。

- ZCode 创建唯一目标文件 `calculator.py`；源工作区未改变，预置的 `test_calculator.py` 字节内容未改变，worktree 实际变化只有 `calculator.py`。
- ZCode 报告的三项测试由 Codex 在隔离 worktree 中独立重跑，3/3 通过。终态为 `completed`，任务报告与实际 Git 文件状态一致。
- 临时任务仓库、task worktree 和 Bridge data root 均由 E2E 驱动清理；没有提交或修改真实项目文件。
- 本次指定模型恰好是新 session 已选中的当前模型，所以 runtime 核验并保留其 reasoning 选项；`session/setModel` 对不同 provider/model 的分支由 fake app-server 测试覆盖，跨模型真实切换及各模型可用 reasoning_level 尚未完成验证。
- 首次运行要求 Bridge 配置通过 MCP 环境显式传入 provider JSON 路径；缺失时 resolver 正确拒绝了本机的已知无效 stub。E2E 临时仓库另固定 `core.autocrlf=false`，确保隔离保护按字节比较。最终 E2E 通过。

### 社区桥接参考补充（2026-09-27）

用户提供的 [tizerluo/zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge) 分析经仓库 README、ACP bridge 源码、0.16.1 升级记录和 MIT LICENSE 复核。它与本项目同样驱动 app-server，但不是协议规范，也没有复制其代码。

- **采用能力探测思路，不以版本号推断能力。**本 Bridge 使用 app-server 实际返回的 session model catalog，并校验 `session/setModel` 后的 snapshot；未覆盖的协议方法仍应按实际请求结果报告不支持。当前无需在启动时额外发送会改变 session 的“探测”请求。
- **不把只读审查工具黑名单用于开发任务。**参考项目将 `--disallowed-tools` 用于 review：禁用写入和命令执行以保障只读；本项目委派目标就是开发，照搬会移除必要能力。以后若新增审查任务，可单独设计只读 profile，并验证 Node REPL 等替代执行通道。
- **provider 环境自愈无需复制。**Bridge 以白名单构造 ZCode 子进程环境，不继承父进程的 `ZCODE_BASE_URL`、模型或凭证覆盖；账号 provider 从已选择的 ZCode 配置与 app-server 注册流程解析。应继续保留 hosted account provider 路径，不改成把 API key 注入进程环境。
- **0.16.x 协议事实作为兼容性线索。**反向 RPC 必须应答、事件订阅和方法删除等变化需要固定到本机 runtime 验证；`session/send` 是否等同可靠 steering 不因社区报告而视为本机已支持。
- **Auto compact 暂不实现。**ZCode 官方文档称 Agent 默认会在上下文窗口耗尽前自动压缩，且没有用户可配置开关；社区 ACP 的额外 threshold 是在成功 turn 后按 `contextUsed` 调用 `session/compact`。本 Bridge 当前没有经过验证的稳定上下文占用阈值事件，也没有证明手动 compact 相比 ZCode 内建机制的收益。避免重复压缩、丢失任务约束或增加未经验证的协议调用；若以后多轮续作出现上下文问题，再先确认 usage 投影字段及触发语义。

参考：[zcode-open-bridge README](https://github.com/tizerluo/zcode-open-bridge)、[0.16.1 升级记录](https://github.com/tizerluo/zcode-open-bridge/blob/main/docs/upgrade-0.16.1-spec.md)、[ZCode auto compaction 说明](https://zcode.z.ai/en/docs/configuration)、[社区 ACP threshold 配置](https://github.com/william0wang/zcode-acp)。这些资料有利于选研究方向，不是本机 0.16.9 的 API 承诺。
