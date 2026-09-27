# Codex → ZCode Bridge

本地运行的 Codex 插件与 MCP 服务。它让 Codex 将开发任务交给本机 ZCode Agent 执行，并在 Codex 中跟踪状态、查看进度事件和最终报告，再由 Codex 独立审查隔离 worktree 中的实际改动。

> **执行权限说明：**当前 Bridge 通过 ZCode 原生 app-server 创建 `yolo` session。它不是操作系统沙箱，ZCode 进程仍以当前用户身份运行。默认情况下 Bridge 会在启动模型前拒绝任务；只有用户自行设置 `ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION=1` 才会放行。这个开关扩大了 Agent 可使用的当前用户权限，安装插件不需要、也不会替你设置它。若你不接受这一权限范围，请保持默认状态，当前 Bridge 不会执行任务。`allowed_paths` / `forbidden_paths` 是 Agent 指令，不是强制访问控制；Bridge 尚未实现向 Codex 转发逐项权限审批的安全执行模式。

## 功能

- 通过本地 stdio MCP 提交、查询、续作和取消任务。
- 按任务指定 ZCode provider/model ID；可传入 runtime 支持的思考等级。省略模型时保留 ZCode 当前默认值。
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
2. 克隆发布仓库并运行 PowerShell 安装脚本：

   ```powershell
   git clone --depth 1 --branch phase7-live-progress https://github.com/Sandyzzx/codex-zcode-bridge.git
   cd codex-zcode-bridge
   .\install.ps1
   ```

   脚本会添加 GitHub marketplace 并安装插件。也可以直接在 Codex Plugins Directory 中完成这两步。

3. 重启 Codex，并按提示审查、信任 **Codex ZCode Bridge** 的 `SessionStart` hook。信任后，每个新对话会自动运行只读配置检查；hook 不会安装插件、修改环境变量或改 ACL。Codex CLI 可用 `/hooks` 查看 hook 状态。MCP 工具随插件加载，不需要在每个新对话重新安装。

PowerShell 引导脚本只支持 Windows。macOS/Linux 可使用 Codex CLI 手动完成首次添加和安装：

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref phase7-live-progress
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

首次安装必须先通过 PowerShell 脚本或 CLI 安装插件；未安装的插件无法先运行自己的新对话 hook。安装完成并信任 hook 后，后续新对话才会自动运行检查。

如果项目目录写入检查失败，可显式传入仓库路径：

```powershell
.\install.ps1 -WorkspacePath "D:\path\to\your\repo"
```

脚本会启用该仓库的 Git 长路径支持并检查当前账号能否写入。只有在确实需要修改 ACL 时，才加 `-GrantWorkspaceModify`；脚本会要求再次输入确认短语，并只对所选仓库授权当前 Windows 账号。它不会创建 ZCode 沙箱。

安装后任务默认仍会被执行权限保护拦截。若你理解并接受 ZCode 以当前用户权限运行，可显式运行 `.\install.ps1 -EnableUnrestrictedExecution`，并在脚本要求时输入确认短语；脚本会把开关写入当前 Windows 用户环境变量。之后必须完全退出并重启 Codex。不要因为安装步骤而打开它。当前 app-server 接入尚未验证逐项审批回传，因此这里没有声称存在更窄的可用权限模式。

默认情况下 Bridge 会发现常见 ZCode 安装路径和 provider 配置。若你的 ZCode 使用非标准目录，在操作系统用户环境变量中设置 `ZCODE_BRIDGE_ZCODE_CJS`、`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 和 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`，然后重启 Codex。变量仅包含路径；不要把配置内容或 API 凭据写入 marketplace 文件。

插件已包含 Bridge MCP 服务和 worker 的打包产物；安装者不需要克隆仓库、运行 `npm install` 或手工生成 `.mcp.json`。marketplace 负责分发和安装插件，但不会替用户安装 Node.js、ZCode 或替用户授权执行权限。Codex 的 Git marketplace 命令和本地插件流程见[官方文档](https://developers.openai.com/plugins/build/plugins)。

## 任务流程

1. Codex 调用 `zcode_task`，提交目标、要求、工作区和验收标准；需要时指定模型。
2. Bridge 校验并保存任务，在 Git worktree 中启动 ZCode Agent。
3. Codex 通过状态和事件工具查看进展；任务完成后读取结果并检查 worktree diff。
4. Codex 独立运行验收；需要修改时可在原 session/worktree 上续作。
5. 只有经 Codex 审查通过的改动才应应用到用户工作区。

## 安全与隐私

- Bridge 不会把 provider 配置内容复制到仓库；ZCode 子进程只接收运行所需的 OS 环境变量、provider 配置路径和显式 Bridge 配置，不继承任意父进程环境变量。
- 常见 `.env`、密钥/证书、`.npmrc`、云凭据目录会从 Git task snapshot 中排除。该规则是启发式过滤，不能检测所有秘密；请在派发前检查仓库。Git 自定义 clean filter 仍可能在 `git add` 时运行。
- `~/.codex/codex-zcode-bridge/` 保存任务 prompt、状态、日志、可见模型输出、事件及结果，均为本地持久化数据。POSIX 系统限制目录权限为 `0700`、文件权限为 `0600`；Windows 依赖父目录 ACL。请为该目录配置适当的本机访问控制和保留策略。
- Git worktree 提供版本隔离，不是安全沙箱。ZCode 运行时仍拥有当前用户可访问的文件和程序权限；不要派发不可信指令或把凭据放入工作区。
## 致谢

本项目的进程树处理代码部分改编自 [cc-plugin-codex](https://github.com/hex1n/cc-plugin-codex)，改动和版权信息见 [NOTICE](NOTICE)。感谢 [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[Zod](https://github.com/colinhacks/zod) 及 ZCode 项目提供的开源工具和运行时。Codex、ZCode 和相关商标归其各自所有者所有；本项目与 OpenAI、Z.ai 或其关联方无隶属或背书关系。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。第三方代码和依赖仍受各自许可证约束，详见 [NOTICE](NOTICE)。
