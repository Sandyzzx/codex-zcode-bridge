# Codex → ZCode Bridge

Codex 插件与本地 MCP 服务，用于把明确授权的开发任务交给本机 ZCode Agent 执行。Codex 可查看进度、选择模型、审查改动并决定是否接收。

## 功能

- 在 Codex 中派发、跟踪、续作和取消 ZCode 任务。
- 可选启用多个 ZCode worker：不同项目可并行；同一执行目录仍串行，Codex 提供不同 worktree 时可启动多个 session。
- 按任务指定 ZCode provider/model；也可配置用户默认模型。
- 运行开始时报告项目目录、实际执行目录、ZCode session、runtime 报告的模型和执行模式。
- ZCode Desktop 任务按 Codex 项目目录归类；索引同步失败不会中断任务。

## 安装

需要 Node.js 22.18+、Git、已安装并登录的 ZCode，以及支持插件 marketplace 的 Codex 桌面应用或 CLI。目前只在 Windows 完成真实 ZCode E2E；macOS 和 Linux 尚未验证。

### Codex CLI 安装

添加 GitHub marketplace 并安装插件：

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref master
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

### Codex 桌面应用安装

先运行上面的第一条 CLI 命令注册 GitHub marketplace；然后在 Codex 的 **Plugins Directory** 中选择该 marketplace，安装 **Codex ZCode Bridge**。

### 首次启动

开启新对话，并检查、信任插件的 `SessionStart` hook。Windows 上 hook 会自动发现并验证 Node.js、ZCode 安装目录和 runtime、builtin/personal provider 配置、ZCode 数据根目录及 Bridge 数据目录，并把解析结果与当前运行选项写入用户环境变量和本地 `runtime-config.json`，不复制 provider 凭据。标准安装不需要克隆仓库或运行 `npm install`。Marketplace 不会代为安装 Node.js 或 ZCode。

插件首次启动会自动发现并保存常见的 ZCode runtime 和 provider 配置位置。需要调整自定义路径、默认模型或并行 worker 数时，也可运行仓库中的 `install.ps1`；不带参数运行会扫描、验证并保存当前已发现的设置。这一步需要下载仓库副本；正常安装插件不需要克隆仓库：

将示例路径以及 `your-provider-id` / `your-model-id` 替换为本机实际值；默认 provider 和 model 必须成对指定。

```powershell
git clone --branch master --single-branch https://github.com/Sandyzzx/codex-zcode-bridge.git
Set-Location codex-zcode-bridge
.\install.ps1 `
  -ZCodeRuntimePath "C:\path\to\zcode.cjs" `
  -BuiltinProviderConfigPath "C:\path\to\zcode-builtin.json" `
  -PersonalProviderConfigPath "D:\ZCodeData\.zcode\v2\provider_config.json" `
  -ZCodeHome "D:\ZCodeData\.zcode" `
  -DefaultProviderId "your-provider-id" `
  -DefaultModelId "your-model-id" `
  -Mode "yolo"
```

按需省略不需要覆盖的参数。`ZCodeHome` 必须指向实际 `.zcode` 目录，个人 provider 文件必须位于该目录的 `v2\provider_config.json`。脚本先扫描并验证这些目录和已有设置，再自动记录运行时、安装根目录、provider 文件、ZCode 数据根目录、Bridge 数据目录，以及模式、并发数和已配置的默认模型；写入 Windows 用户环境变量和 `runtime-config.json`。默认模型只有在用户已配置或显式传入时才保存，脚本不会猜选模型。可加 `-WhatIf` 预览将写入的项目而不修改环境。完整参数和源码构建说明见[英文 README](README.en.md#install)。

Codex 的 marketplace 安装说明见[OpenAI 官方插件文档](https://developers.openai.com/plugins/build/plugins)。

### 可选：并行 worker

Bridge 默认一次运行一个 ZCode 任务。确认本机资源和 ZCode provider 配置适合并行后，可将最大 worker 数设置为 2–8；例如在仓库副本的 PowerShell 中运行 `./install.ps1 -MaxConcurrentWorkers 2`，再重启 Codex。也可通过用户环境变量 `ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS` 配置。不同项目目录可并行；同一或互相嵌套的执行目录会自动排队。要让同一项目的任务并行，Codex 必须为它们分别准备真正独立的 Git worktree 并传入不同路径。Bridge 只按路径互斥，不会验证传入目录是否为独立 Git worktree，也不创建或判断 worktree。

并行数是单个 Bridge MCP 进程的上限，默认值 1。多个 Bridge 进程共用同一数据目录的跨进程调度尚未实现；不要通过启动多个 Bridge 进程来扩展并发。

## 使用

描述要完成的开发任务，并说明验收条件。Codex 会按需要准备 worktree，再将任务交给 ZCode；如指定 worktree，任务在该目录执行，否则直接在项目目录执行。ZCode 不会自动获得 Codex 的完整对话，因此需要的项目决定和约束应由 Codex 随任务提供。

ZCode session 标题根据首条任务 prompt 生成。Bridge 会将 `TASK ID` 放在 prompt 首行，但标题可能还包含后续 prompt 文本。

任务完成后，Codex 应检查实际 diff 并独立运行验收。`completed` 只表示 ZCode 已报告执行结束，不代表改动已通过 Codex 审查。若任务遇到未解决且会影响重要行为的决定，ZCode 会请求 Codex 指示后再继续。

ZCode Desktop 的 Workspace 视图按 Codex 项目目录查找任务。任务索引同步是尽力而为，Desktop 侧栏可能不会立即刷新。

## 安全与限制

- 默认执行模式为 `yolo`，可通过 `ZCODE_BRIDGE_MODE` 设为 `plan`、`build` 或 `edit`。ZCode 以当前操作系统用户权限运行。
- Git worktree 只隔离工作目录，不是操作系统沙箱；`allowed_paths` 和 `forbidden_paths` 是任务约束说明，不能阻止进程访问其他文件或执行命令。
- 是否创建 worktree 由 Codex 根据任务决定；Bridge 使用传入的项目目录和可选 worktree 路径，不替用户创建或删除 worktree。
- 并行执行会启动多个 ZCode app-server worker，增加本机资源与 provider 并发使用。真实 E2E 已验证同一 Coding Plan 模型下的并行 session 和 Desktop 任务索引登记；并发切换不同 provider/model 与 Desktop 界面刷新尚未验证。需要稳定运行时请先使用默认单 worker。
- Bridge 将 prompt、状态、日志、可见模型输出、事件和结果保存在本机 `~/.codex/codex-zcode-bridge/`（Windows 为 `%USERPROFILE%\.codex\codex-zcode-bridge\`）。请勿在任务或工作区中放入不应发送给所选模型服务的凭据或数据。
- Bridge 使用本机 ZCode app-server；权限交互及可用事件受已安装的 ZCode 版本影响。当前尚未验证将逐项权限审批转发回 Codex。

## 源码构建

仓库保留 TypeScript 源码供审查和自行构建。需要 Node.js 22.18+，运行：

```sh
npm ci
npm run build
```

## 致谢与许可证

进程管理部分参考并改编自 [cc-plugin-codex](https://github.com/hex1n/cc-plugin-codex)；ZCode Desktop 任务索引部分参考并改编自 [zcode-acp](https://github.com/william0wang/zcode-acp)。感谢 [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[Zod](https://github.com/colinhacks/zod) 和 ZCode 项目。来源与版权说明见 [NOTICE](NOTICE)。

本项目采用 [Apache License 2.0](LICENSE)。第三方组件仍受其各自许可证约束。
