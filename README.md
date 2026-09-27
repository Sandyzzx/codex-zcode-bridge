# Codex → ZCode Bridge

本地运行的 Codex 插件与 MCP 服务。它让 Codex 将开发任务交给本机 ZCode Agent 执行，并在 Codex 中跟踪状态、查看进度事件和最终报告，再由 Codex 独立审查项目工作区中的实际改动。

> **执行权限说明：**Bridge 默认通过 ZCode 原生 app-server 创建 `yolo` session，ZCode 以当前用户权限运行。`workspace` 始终是 Codex 项目目录和 ZCode Desktop 的项目归属；是否创建 worktree 由 Codex agent 根据任务指示决定，并通过可选 `worktree_path` 传给 Bridge。未提供时在项目目录执行，提供时在该 worktree 执行。Bridge 不创建、选择或删除 worktree。worktree 不是操作系统沙箱，`allowed_paths` / `forbidden_paths` 也不能强制限制进程访问。当前 app-server 接入尚未验证向 Codex 转发逐项权限审批的安全执行模式。每个任务开始时，Bridge 会报告项目路径、执行路径、ZCode session、runtime 报告的模型和执行模式。

## 功能

- 通过本地 stdio MCP 提交、查询、续作和取消任务。
- 按任务指定 ZCode provider/model ID；可传入 runtime 支持的思考等级。未指定任务模型时，依次使用 Bridge 用户默认模型、ZCode 当前默认模型。
- 将由 app-server 创建的 session best-effort 登记到 ZCode Desktop 任务索引；状态映射为运行中、已完成或错误，取消时清除活动状态。任务按请求的项目目录归类；索引写入成功不代表当前 Desktop 侧栏已经刷新，索引不可用也不会中断任务。
- 使用本机 ZCode app-server，向 Codex 暴露可见文本、模型选择、工具生命周期、usage 和任务状态事件（以本机 runtime 实际提供为准）。
- 任务 prompt 以 `TASK ID` 开头；Codex 可在 `context` 中提供精简的项目决定、约束、相关文件和显式未决决定。ZCode 对重大冲突或会改变外部行为的缺失决定应请求 Master 决定。
- 在 Codex 指定的项目目录或 worktree 中执行，并把运行状态、日志、事件和结果保存在用户目录 `~/.codex/codex-zcode-bridge/`（Windows 为 `%USERPROFILE%\.codex\codex-zcode-bridge\`）。
- `completed` 仅表示 ZCode 报告执行结束，不代表 Codex 已接受改动。Codex 应检查实际 diff 并独立执行验收。

## 系统要求

- Windows、macOS 或 Linux；目前主要验证环境为 Windows。其他平台尚未完成真实 ZCode E2E，兼容性不确定。
- Node.js 22.18 或更高版本、Git。
- 本机已安装并登录 ZCode；Bridge 必须能访问其 runtime 和有效的 provider 配置。
- Codex 桌面应用或支持本地插件 marketplace 的 Codex CLI。

## 安装

1. 确认本机已安装 Node.js 22.18+、Git 和 ZCode，并已登录 ZCode。
2. 在 Codex 中手动添加 GitHub marketplace 并安装 **Codex ZCode Bridge**。也可用 Codex CLI：

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref master
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

3. 首次新对话时审查并信任 **Codex ZCode Bridge** 的 `SessionStart` hook。之后 hook 会读取并验证 Node.js、Git、ZCode runtime 和 provider 配置，报告发现的路径及配置问题；默认路径不会写入用户环境变量。Codex CLI 可用 `/hooks` 查看 hook 状态。插件和 MCP 只需安装一次。

如果 ZCode 在非默认路径，使用自定义数据目录，或需要设置用户默认模型/模式，可在仓库副本中运行 Windows 配置脚本：

```powershell
.\install.ps1 `
  -ZCodeRuntimePath "C:\path\to\zcode\runtime.cjs" `
  -BuiltinProviderConfigPath "C:\path\to\builtin-provider.json" `
  -ZCodeHome "D:\ZCodeData\.zcode" `
  -DefaultProviderId "account:bigmodel-individual-coding-plan" `
  -DefaultModelId "GLM-5.3-Flash" `
  -Mode "yolo"
```

参数可单独使用。`ZCODE_HOME` 必须是实际 `.zcode` 数据目录，且包含 `v2\provider_config.json`；脚本会发现并校验该文件及 runtime/provider JSON（个人配置必须包含非空 provider rules）。默认模型由 provider/model 成对指定；任务级模型覆盖用户默认值。模式可设为 `plan`、`build`、`edit` 或 `yolo`，默认 `yolo`。确认有效后脚本只写入显式传入参数对应的 Windows 用户环境变量；未传参数只读取当前配置，不写入默认值。设置自定义路径或默认值后需重新启动 Codex。脚本不会添加 marketplace、安装插件、修改 ZCode 配置内容或 ACL。

开始执行时，Codex 会先显示项目目录、session、模型和执行模式信息。如果 runtime 未报告当前模型，Bridge 会在发送任务 prompt 前失败。app-server 的逐项权限审批回传尚未验证；`build`/`edit`/`plan` 模式下的权限交互行为也需结合本机 ZCode 版本确认。

默认情况下 Bridge 会发现常见 ZCode 安装路径和 provider 配置（包括 Windows 的 `Program Files`、`LOCALAPPDATA` 和 ZCode 数据目录）。变量仅保存路径；不要把配置内容或 API 凭据写入 marketplace 文件。

插件已包含 Bridge MCP 服务和 worker 的打包产物；安装者不需要克隆仓库、运行 `npm install` 或手工生成 `.mcp.json`。marketplace 负责分发和安装插件，但不会替用户安装 Node.js 或 ZCode。Codex 的 Git marketplace 命令和本地插件流程见[官方文档](https://developers.openai.com/plugins/build/plugins)。

仓库同时提供 TypeScript 源码和构建配置，便于审计与自行构建；内部测试和开发文档不作为发布内容。自行构建可运行 `npm ci`，然后运行 `npm run build`。

## 任务流程

1. Codex 调用 `zcode_task`，提交目标、要求、工作区和验收标准；需要时指定模型。
2. Bridge 将 `workspace` 作为项目归属；Codex agent 可按任务要求选择并创建 worktree，再通过 `worktree_path` 指定实际执行目录。Bridge 只校验路径并启动 ZCode。
3. Codex 通过状态和事件工具查看项目路径、执行路径和进展；任务完成后读取结果并检查实际执行目录中的 Git diff。
4. Codex 独立运行验收；需要修改时可在原 ZCode session 和原执行目录上续作。
5. Codex 审查并验收后，再决定如何接收改动。Bridge 不自动合并、应用、删除 worktree 或提交。

## 委派 Prompt 约定

- 首行是 `TASK ID: <task_id>`，作为 ZCode 根据首条 prompt 自动生成 session 标题的提示；Bridge 不调用单独的重命名命令，标题不保证与 ID 完全一致。
- 固定 prompt 定义单任务执行角色、目标、路径范围、验收条件和 JSON 报告格式。Codex 的对话不会自动共享给 ZCode。
- 仅在确有需要时提供精简 `context`，可按 `PROJECT DECISIONS`、`CONSTRAINTS`、`RELEVANT FILES`、`OPEN DECISIONS — DO NOT CHOOSE` 组织；不要粘贴整段对话。
- ZCode 不得替 Master 决定尚未解决的 `OPEN DECISIONS`；续作时 Master Feedback 明确给出决定后，按该决定继续。对未列出的需求冲突或会实质改变外部行为的缺失决定，也应提出具体问题并设置 `needs_master_decision=true`；独立工作可以继续。低影响实现选择采用最简单一致的做法，并在报告中说明假设。

## 在 ZCode Desktop 查找任务

Bridge 把 ZCode session 的 `workspaceKey` 设为 `workspace` 对应的 Codex 项目根目录；`workspacePath` 则是实际执行路径：未提供 `worktree_path` 时等于项目根目录，提供时等于 Codex 选择的 worktree。Bridge 进度事件统一使用 `project_path` 表示项目根目录、`execution_path` 表示实际执行目录。Desktop 索引行同样以项目根目录归类，并保留 worktree 执行路径。任务索引写入失败或 Desktop 尚未刷新时，列表仍可能暂时看不到任务。

在 ZCode 左侧任务侧栏，将视图切换到 **Workspace**，查看对应项目的任务；也可切换到 **Timeline** 并按更新时间排序。ZCode 官方文档说明了这些任务视图和排序方式，但没有记载 Desktop 侧栏的专用刷新按钮。官方文档中明确提到的 **Refresh** 是手机 Remote Control 的 Task home 操作，不是 Desktop 按钮。参阅 [ZCode 任务管理文档](https://zcode.z.ai/en/docs/task-management) 和 [Remote Control 文档](https://zcode.z.ai/en/docs/remote-control)。

`desktop_task_registered` 事件表示 Bridge 已把 session 写入 ZCode Desktop 的任务索引；它不保证当前界面已经显示该记录。若仍看不到，请确认当前 ZCode 窗口打开了请求的项目目录，并切换到 Workspace 或 Timeline 视图。

### 当前已知问题

- **ZCode session 标题由首条 prompt 自动生成。** Bridge 将 `TASK ID` 放在首行，标题不通过专用 API 设置。2026-09-28 的真实 E2E 中，app-server 报告 `titleSource: first_input`；生成标题以 `TASK ID` 开头，但后面还拼接了截断的 prompt 内容，因此不能保证标题恰好等于 task_id。
- **GLM-5.3-Flash 已在本机配置完成真实 E2E。** 2026-09-28，runtime 的可用模型列表包含 `account:bigmodel-individual-coding-plan/GLM-5.3-Flash`，Bridge 成功选择该模型并完成两轮真实执行。此前的模型发现失败原因仍不确定；其他机器或 provider 配置仍应以启动事件报告的模型为准。
- **Desktop 的项目归属与 worktree 执行路径已实测。** 真实 E2E 中，session/索引以 Codex 项目根目录作为 `workspaceKey`，以 Codex 准备的 worktree 作为 `workspacePath`；该 session 在索引中归于项目根目录。Desktop 当前窗口是否立即显示新索引行仍受刷新机制影响。

## 安全与隐私

- Bridge 不会把 provider 配置内容复制到仓库；ZCode 子进程只接收运行所需的 OS 环境变量、provider 配置路径和显式 Bridge 配置，不继承任意父进程环境变量。
- Bridge 不创建 Git snapshot，也不复制或筛除项目文件。Codex 选择的 worktree 按 Codex 自身流程准备；请在派发前检查项目和执行目录中任务可见的文件。
- `~/.codex/codex-zcode-bridge/` 保存任务 prompt、状态、日志、可见模型输出、事件及结果，均为本地持久化数据。POSIX 系统限制目录权限为 `0700`、文件权限为 `0600`；Windows 依赖父目录 ACL。请为该目录配置适当的本机访问控制和保留策略。
- 是否使用 Git worktree 由 Codex agent 根据任务指示决定。worktree 仅隔离文件工作目录，不是 OS 沙箱；ZCode 运行时仍拥有当前用户可访问的文件和程序权限。直接在项目目录执行时，任务改动会直接落在该项目中。派发前确认项目状态并保留重要改动，任务期间不要并发编辑同一执行目录；不要派发不可信指令或把凭据放入工作区。
## 致谢

本项目的进程树处理代码部分改编自 [cc-plugin-codex](https://github.com/hex1n/cc-plugin-codex)；ZCode Desktop 任务索引读写代码部分改编自 [zcode-acp 的 `src/tasks-index.ts`](https://github.com/william0wang/zcode-acp/blob/main/src/tasks-index.ts)，并按 Bridge 的任务关联、`ZCODE_HOME` 路径解析、schema 校验和状态同步需求作了修改。两个项目均采用 Apache-2.0；具体来源、改动和版权信息见 [NOTICE](NOTICE)。感谢 [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[Zod](https://github.com/colinhacks/zod) 及 ZCode 项目提供的开源工具和运行时。Codex、ZCode 和相关商标归其各自所有者所有；本项目与 OpenAI、Z.ai 或其关联方无隶属或背书关系。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。第三方代码和依赖仍受各自许可证约束，详见 [NOTICE](NOTICE)。
