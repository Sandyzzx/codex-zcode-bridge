# Codex → ZCode Bridge

本地运行的 Codex 插件与 MCP 服务。它让 Codex 将开发任务交给本机 ZCode Agent 执行，并在 Codex 中跟踪状态、查看进度事件和最终报告，再由 Codex 独立审查隔离 worktree 中的实际改动。

> **执行权限说明：**Bridge 默认通过 ZCode 原生 app-server 创建 `yolo` session，ZCode 以当前用户权限运行。它不是操作系统沙箱；Git worktree 和 `allowed_paths` / `forbidden_paths` 都不能强制限制进程访问。当前 app-server 接入尚未验证向 Codex 转发逐项权限审批的安全执行模式。每个任务开始时，Bridge 会报告源项目、隔离 worktree、ZCode session、runtime 报告的模型和执行模式。

## 功能

- 通过本地 stdio MCP 提交、查询、续作和取消任务。
- 按任务指定 ZCode provider/model ID；可传入 runtime 支持的思考等级。未指定任务模型时，依次使用 Bridge 用户默认模型、ZCode 当前默认模型。
- 将由 app-server 创建的 session best-effort 登记到 ZCode Desktop 任务索引；状态映射为运行中、已完成或错误，取消时清除活动状态。任务按隔离 worktree workspace 归类；索引写入成功不代表当前 Desktop 侧栏已经刷新，索引不可用也不会中断任务。
- 使用本机 ZCode app-server，向 Codex 暴露可见文本、模型选择、工具生命周期、usage 和任务状态事件（以本机 runtime 实际提供为准）。
- 在独立 Git worktree 中执行，并把运行状态、日志、事件和结果保存在用户目录 `~/.codex/codex-zcode-bridge/`（Windows 为 `%USERPROFILE%\.codex\codex-zcode-bridge\`）。
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
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref phase7-live-progress
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

开始执行时，Codex 会先显示 ZCode 项目、worktree、session、模型和执行模式信息。如果 runtime 未报告当前模型，Bridge 会在发送任务 prompt 前失败。app-server 的逐项权限审批回传尚未验证；`build`/`edit`/`plan` 模式下的权限交互行为也需结合本机 ZCode 版本确认。

默认情况下 Bridge 会发现常见 ZCode 安装路径和 provider 配置（包括 Windows 的 `Program Files`、`LOCALAPPDATA` 和 ZCode 数据目录）。变量仅保存路径；不要把配置内容或 API 凭据写入 marketplace 文件。

插件已包含 Bridge MCP 服务和 worker 的打包产物；安装者不需要克隆仓库、运行 `npm install` 或手工生成 `.mcp.json`。marketplace 负责分发和安装插件，但不会替用户安装 Node.js 或 ZCode。Codex 的 Git marketplace 命令和本地插件流程见[官方文档](https://developers.openai.com/plugins/build/plugins)。

仓库同时提供 TypeScript 源码和构建配置，便于审计与自行构建；内部测试和开发文档不作为发布内容。自行构建可运行 `npm ci`，然后运行 `npm run build`。

## 任务流程

1. Codex 调用 `zcode_task`，提交目标、要求、工作区和验收标准；需要时指定模型。
2. Bridge 校验并保存任务，在 Git worktree 中启动 ZCode Agent。
3. Codex 通过状态和事件工具查看进展；任务完成后读取结果并检查 worktree diff。
4. Codex 独立运行验收；需要修改时可在原 session/worktree 上续作。
5. 只有经 Codex 审查通过的改动才应应用到用户工作区。

## 在 ZCode Desktop 查找任务

Bridge 为每个任务创建独立 Git worktree，并把 ZCode session 关联到该 worktree 路径，而不是源项目目录。默认路径位于 `<Bridge 数据目录>/.tasks/workspaces/<task_id>`；若只查看原项目 workspace，可能找不到委派任务。

在 ZCode 左侧任务侧栏，将视图切换到 **Workspace**，查看对应隔离 worktree 的任务；也可切换到 **Timeline** 并按更新时间排序。ZCode 官方文档说明了这些任务视图和排序方式，但没有记载 Desktop 侧栏的专用刷新按钮。官方文档中明确提到的 **Refresh** 是手机 Remote Control 的 Task home 操作，不是 Desktop 按钮。参阅 [ZCode 任务管理文档](https://zcode.z.ai/en/docs/task-management) 和 [Remote Control 文档](https://zcode.z.ai/en/docs/remote-control)。

`desktop_task_registered` 事件表示 Bridge 已把 session 写入 ZCode Desktop 的任务索引；它不保证当前界面已经显示该记录。若仍看不到，先核对任务对应的隔离 worktree workspace，而不是只看源项目 workspace。

## 安全与隐私

- Bridge 不会把 provider 配置内容复制到仓库；ZCode 子进程只接收运行所需的 OS 环境变量、provider 配置路径和显式 Bridge 配置，不继承任意父进程环境变量。
- 常见 `.env`、密钥/证书、`.npmrc`、云凭据目录会从 Git task snapshot 中排除。该规则是启发式过滤，不能检测所有秘密；请在派发前检查仓库。Git 自定义 clean filter 仍可能在 `git add` 时运行。
- `~/.codex/codex-zcode-bridge/` 保存任务 prompt、状态、日志、可见模型输出、事件及结果，均为本地持久化数据。POSIX 系统限制目录权限为 `0700`、文件权限为 `0600`；Windows 依赖父目录 ACL。请为该目录配置适当的本机访问控制和保留策略。
- Git worktree 提供版本隔离，不是安全沙箱。ZCode 运行时仍拥有当前用户可访问的文件和程序权限；不要派发不可信指令或把凭据放入工作区。
## 致谢

本项目的进程树处理代码部分改编自 [cc-plugin-codex](https://github.com/hex1n/cc-plugin-codex)；ZCode Desktop 任务索引读写代码部分改编自 [zcode-acp 的 `src/tasks-index.ts`](https://github.com/william0wang/zcode-acp/blob/main/src/tasks-index.ts)，并按 Bridge 的任务关联、`ZCODE_HOME` 路径解析、schema 校验和状态同步需求作了修改。两个项目均采用 Apache-2.0；具体来源、改动和版权信息见 [NOTICE](NOTICE)。感谢 [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[Zod](https://github.com/colinhacks/zod) 及 ZCode 项目提供的开源工具和运行时。Codex、ZCode 和相关商标归其各自所有者所有；本项目与 OpenAI、Z.ai 或其关联方无隶属或背书关系。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。第三方代码和依赖仍受各自许可证约束，详见 [NOTICE](NOTICE)。
