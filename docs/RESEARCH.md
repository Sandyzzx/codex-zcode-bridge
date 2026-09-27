# Phase 1 调研：Codex → ZCode Bridge

调研日期：2026-09-26（Asia/Shanghai）

## 范围与证据

检查了以下项目当时的 `main` 分支：

- [hex1n/cc-plugin-codex](https://github.com/hex1n/cc-plugin-codex)
- [alexeygrigorev/codex-zcode](https://github.com/alexeygrigorev/codex-zcode)
- [zai-org/ZCode](https://github.com/zai-org/ZCode)，包括 CLI 参数解析、prompt 结果格式和 provider runtime 初始化。

第一个项目检查了 MCP server、service、进程、任务生命周期、隔离工作区和任务 prompt 源码。第二个项目检查了 `ABOUT.md` 和 `codex-rs/ext/zcode/src/lib.rs`。本机 ZCode 检查及其限制记录在 [ZCode Runtime 验证](ZCODE_RUNTIME.md)。

第一次调研时，工作目录里没有项目文件，也没有 `.git`。之后项目已初始化 Git，并连接到 `https://github.com/Sandyzzx/codex-zcode-bridge.git`。本地分支和当前提交状态以 `git status` 为准。

## 参考 A：可复用的设计模式

`cc-plugin-codex` 使用类型化的 stdio MCP，并通过简洁的协议层校验工具参数、再委托 service 函数处理。协议 handler 不负责任务执行逻辑。此分层适用于本项目：MCP schema/handler 调用 task manager，task manager 再调用 workspace provider 和 coding-agent adapter。

它的任务生命周期状态保存在进程内存之外，记录子进程身份和日志，并在重启后恢复过期的 `starting`/`running` 任务。Windows 超时和取消通过 `taskkill /T /F` 终止进程树。这些做法可用于 Bridge 的重启恢复和取消；V0.1 每个任务使用一个 JSON 记录即可。

它的写入流程使用独立 clone 和显式 apply 步骤。相比本项目 V0.1 直接工作区模式，隔离更强，因此适合作为未来选项，不必现在照搬。主要经验是将工作区创建和清理放在 `WorkspaceProvider` 边界之后。

它的 prompt 会明确任务范围与能力边界，结果工具会返回持久化的结构化任务状态。完成状态只是报告，不证明任务正确。Codex 仍需检查 diff、重跑相关检查、对照验收标准，并决定续作或通过。

## 参考 B：可复用的 adapter 模式

`codex-zcode` 是 Codex CLI fork，不是独立 MCP 任务管理器。不过它的 ZCode 集成是一个职责清晰的子进程 adapter：解析 `zcode.cjs` runtime，通过 Node 调用 `--prompt`、`--json`、`--mode` 和 `--cwd`，必要时传入 `--resume`，捕获 stdout/stderr，设置硬超时，解析 JSON，并要求存在 `sessionId` 才将响应视为有效结果。

Rust adapter 通过简短 Node loader 传递临时 prompt 文件路径，而不是把可能很长的 prompt 直接放进 OS 命令行。它显式设置子进程工作目录、不使用 shell，并在 future 被丢弃时终止子进程。这些是适用于 Windows 的 adapter 实践。Bridge 仍应负责持久化任务状态和规范化结果；ZCode 进程应封装在 `CodingAgentAdapter` 后。

该参考项目的 Linux 说明记录了 provider 配置查找路径不匹配，并建议复制打包配置。ZCode 官方仓库展示了更合适的 Bridge 接入点：`prepareCliProviderRuntimeEnv` 同时接受 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 和 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 后，会跳过基于 entrypoint 的路径查找。官方 README 列出了 builtin 配置环境变量，runtime 路径实现要求 builtin 和 personal 配置成对提供。Bridge 应先验证两个文件，再仅在子进程环境中设置变量；不得复制或修改 Desktop 安装内容。

官方 CLI 源码还确认 Agent CLI 会解析 `--prompt`、`--json`、`--cwd`、`--mode` 和 `--resume`。本机观察到的 `--json` prompt 结果包含 `sessionId`、`traceId`、`turnId`、`response`、`usage`、`eventCount` 和 `projection`。该结构只在本机 CLI 0.16.9 上验证过，不是跨版本稳定契约。当前 CLI 参数解析器没有 `--max-turns`，因此 Bridge 不得向本机版本传此参数。本机运行证据和未确认事项见 [ZCode Runtime 验证](ZCODE_RUNTIME.md)。

## V0.1 架构建议

采用以下边界：

1. **stdio MCP server** — 通过严格输入 schema 暴露任务、状态、结果、续作和取消工具；协议层保持精简。
2. **Task manager 和文件存储** — 校验 task ID 和规范路径，将原始任务包、状态时间戳、进程元数据、stdout/stderr 和规范化结果保存在 `.tasks/<task_id>/`。状态和结果文件需原子写入，避免重启留下半截 JSON。
3. **WorkspaceProvider** — 首先实现 `DirectWorkspaceProvider`，将规范目录传给 adapter。工作区准备过程独立封装，以便未来增加 worktree provider 时不改变 MCP 工具契约。
4. **CodingAgentAdapter / ZCode adapter** — 发现并验证 Node 和 `zcode.cjs`，构造参数数组（禁止拼接 shell 命令字符串），启动和监控子进程，解析输出并规范化结果。启动/配置错误应与模型/任务失败区分。
5. **Prompt builder** — 将结构化任务包和 Master 反馈渲染为下属 Agent prompt。明确任务边界，但 Direct 模式下的 `allowed_paths` 和 `forbidden_paths` 只是 Agent 指令及运行后检查，不是 OS 强制的沙箱。

数据流：Codex 调用 `zcode_task` → 校验并持久化任务包 → 选择工作区 → 构造 prompt → 启动 ZCode → 更新持久状态和日志 → 规范化结果 → Codex 调用 status/result 并独立检查工作区 diff 和测试 → Codex 接受结果，或提供具体反馈调用 `zcode_continue`。`zcode_cancel` 请求终止，只有确认进程已停止后才记录终态。

建议状态转换：`queued → running → completed | failed | cancelled | waiting_for_master`。Server 重启后根据已记录的 PID 恢复仍存活的任务；子进程已退出但没有结果时标记失败。只有实际验证 session 复用后才优先使用 `--resume <sessionId>`；否则启动新调用，并在 prompt 中携带任务、结果和反馈摘要。只有返回的 session ID 确认一致时，才能声称复用了原 session。

故障处理应保留原始 stdout/stderr、退出码、开始/结束时间、超时/取消原因、解析错误和规范化结果。进程成功退出但 JSON 缺失或错误，仍是 Bridge 任务失败，不是 coding task 完成。日志/结果需要有界，并明确清理策略。

## 安全边界与已知风险

Direct 工作区模式会根据 ZCode 自己的权限模式和工具，让 ZCode 在选定工作区中写入。Prompt 无法从技术上阻止它修改允许列表之外的文件，运行后检测也无法撤销写入。V0.1 应规范化工作区、拒绝无效/越界路径、记录路径约束，并向 Codex 报告越界改动；更强隔离需要单独实现 workspace/sandbox。

不得通过 `exec` 或 shell 命令字符串调用 `zcode.cjs`。不要在任务 prompt 或持久化日志中写入密钥。MCP 取消必须覆盖完整 Windows 进程树。ZCode 自己报告的 `completed` 只是下属证据；最终 PASS 只能由 Codex 判定。

## Phase 1 结论

- 可以采用职责分层和任务生命周期设计，无需完整照搬任一参考项目。
- ZCode Desktop 3.14.3 / CLI 0.16.9 的 headless 执行、JSON 输出、`--cwd` 文件放置和 `--resume` session 续作已通过本机真实 smoke test。Resume 返回相同 session ID，并修改同一隔离工作区。
- 在干净子进程环境中，原 provider 路径查找失败可以稳定复现。只在子进程环境中设置成对 provider 配置变量即可修复，不必修改 ZCode 安装。Personal 配置必须解析为有效且已存在的配置；自动生成的小 stub 无法使用。
- 多种环境下都曾出现短暂的 `Bundled 与 Active ZCode Built-in Release 均不可用`，之后停止出现。原因未知。Bridge 应保留诊断；只有区分该暂时性故障与配置/model 错误后，才采用有界重试。
- 后续工作：在架构中明确 Bridge 的 provider 配置发现和预检行为，再实现 adapter。在本机应从有效的 ZCode 数据目录（或 `ZCODE_DATA_BASE_DIR`）发现 personal 配置，不要假定它位于 Windows 用户主目录。

## 资料来源

- [cc-plugin-codex README](https://github.com/hex1n/cc-plugin-codex)
- [cc-plugin-codex MCP server](https://github.com/hex1n/cc-plugin-codex/blob/main/mcp/server.mjs)
- [codex-zcode ABOUT.md](https://github.com/alexeygrigorev/codex-zcode/blob/main/ABOUT.md)
- [codex-zcode ZCode adapter 源码](https://github.com/alexeygrigorev/codex-zcode/blob/main/codex-rs/ext/zcode/src/lib.rs)
- [ZCode CLI 参数解析器](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/src/arguments.ts)
- [ZCode CLI provider runtime 环境](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/src/provider-runtime-env.ts)
- [ZCode provider runtime 路径变量](https://github.com/zai-org/ZCode/blob/main/packages/provider-node/src/runtime-paths.ts)
- [ZCode headless prompt 结果格式](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/src/prompt-command.ts)
