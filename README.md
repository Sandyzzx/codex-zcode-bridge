# Codex → ZCode Bridge

本地运行的 Codex 插件与 MCP 服务。它让 Codex 将开发任务交给本机 ZCode Agent 执行，并在 Codex 中跟踪状态、查看进度事件和最终报告，再由 Codex 独立审查隔离 worktree 中的实际改动。

> **执行权限说明：**当前 Bridge 通过 ZCode 原生 app-server 创建 `yolo` session。该模式不构成操作系统沙箱；ZCode 进程仍以当前用户身份运行。插件配置要求显式启用 `ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION=1`。启用前请审查工作区内容、任务目标和本机权限。`allowed_paths` / `forbidden_paths` 是 Agent 指令，不是强制访问控制。

## 功能

- 通过本地 stdio MCP 提交、查询、续作和取消任务。
- 按任务指定 ZCode provider/model ID；可传入 runtime 支持的思考等级。省略模型时保留 ZCode 当前默认值。
- 使用本机 ZCode app-server，向 Codex 暴露可见文本、模型选择、工具生命周期、usage 和任务状态事件（以本机 runtime 实际提供为准）。
- 在独立 Git worktree 中执行，并把运行状态、日志、事件和结果保存在本地 `.tasks/`。
- `completed` 仅表示 ZCode 报告执行结束，不代表 Codex 已接受改动。Codex 应检查实际 diff 并独立执行验收。

## 系统要求

- Windows、macOS 或 Linux；目前主要验证环境为 Windows。其他平台尚未完成真实 ZCode E2E，兼容性不确定。
- Node.js 22.18 或更高版本、Git。
- 本机已安装并登录 ZCode；Bridge 必须能访问其 runtime 和有效的 provider 配置。
- Codex 桌面应用或支持本地插件 marketplace 的 Codex CLI。

## 从 GitHub Marketplace 安装

1. 确认本机已安装 Node.js 22.18+、Git 和 ZCode，并已登录 ZCode。
2. 在 PowerShell 中显式启用任务执行权限，然后重启 Codex：

   ```powershell
   [Environment]::SetEnvironmentVariable("ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION", "1", "User")
   ```

   这允许 ZCode 以当前用户权限运行 `yolo` session。插件安装本身不会设置该授权。

3. 将 GitHub marketplace 添加到 Codex。当前发布分支为 `phase7-live-progress`：

   ```sh
   codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref phase7-live-progress
   ```

4. 重启 Codex，打开插件目录，找到 **Codex ZCode Bridge** 并点“安装”。开始新对话后即可使用 MCP 工具。

默认情况下 Bridge 会发现常见 ZCode 安装路径和 provider 配置。若你的 ZCode 使用非标准目录，在操作系统用户环境变量中设置 `ZCODE_BRIDGE_ZCODE_CJS`、`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 和 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`，然后重启 Codex。变量仅包含路径；不要把配置内容或 API 凭据写入 marketplace 文件。

插件已包含 Bridge MCP 服务和 worker 的打包产物；安装者不需要克隆仓库、运行 `npm install` 或手工生成 `.mcp.json`。marketplace 负责分发和安装插件，但不会替用户安装 Node.js、ZCode 或替用户授权执行权限。Codex 的 Git marketplace 命令和本地插件流程见[官方文档](https://developers.openai.com/plugins/build/plugins)。

## 任务流程

1. Codex 调用 `zcode_task`，提交目标、要求、工作区和验收标准；需要时指定模型。
2. Bridge 校验并保存任务，在 Git worktree 中启动 ZCode Agent。
3. Codex 通过状态和事件工具查看进展；任务完成后读取结果并检查 worktree diff。
4. Codex 独立运行验收；需要修改时可在原 session/worktree 上续作。
5. 只有经 Codex 审查通过的改动才应应用到用户工作区。

## 开发与验证

```sh
npm run typecheck
npm run build
npm test
npm run smoke
```

`npm run build` 同时更新 marketplace 插件目录下的独立 MCP server 与 worker bundle；发布 marketplace 更新时应一并提交生成文件。

`npm run integration:live` 会启动本机 ZCode 并调用模型，可能消耗额度。运行前设置 `ZCODE_BRIDGE_E2E_MODEL_PROVIDER_ID` 和 `ZCODE_BRIDGE_E2E_MODEL_ID`，使用临时工作区并检查生成的结果。

## 安全与隐私

- Bridge 不会把 provider 配置内容复制到仓库；ZCode 子进程只接收运行所需的 OS 环境变量、provider 配置路径和显式 Bridge 配置，不继承任意父进程环境变量。
- 常见 `.env`、密钥/证书、`.npmrc`、云凭据目录会从 Git task snapshot 中排除。该规则是启发式过滤，不能检测所有秘密；请在派发前检查仓库。Git 自定义 clean filter 仍可能在 `git add` 时运行。
- `.tasks/` 保存任务 prompt、状态、日志、可见模型输出、事件及结果，均为本地持久化数据。POSIX 系统限制目录权限为 `0700`、文件权限为 `0600`；Windows 依赖 `.tasks` 父目录 ACL。请为该目录配置适当的本机访问控制和保留策略。
- Git worktree 提供版本隔离，不是安全沙箱。ZCode 运行时仍拥有当前用户可访问的文件和程序权限；不要派发不可信指令或把凭据放入工作区。
- 安全问题请参阅 [SECURITY.md](SECURITY.md)。

## 文档

- [路线图与决策记录](docs/ROADMAP_DECISIONS.md)
- [MVP 0.3 能力与契约](docs/MVP_V0.3.md)
- [ZCode app-server 能力普查](docs/APPSERVER_CAPABILITY_MATRIX.md)
- [架构](docs/ARCHITECTURE.md) · [接口](docs/INTERFACES.md)
- [Phase 7 实时进度](docs/PHASE7_LIVE_PROGRESS.md) · [ZCode Runtime 验证](docs/ZCODE_RUNTIME.md)
- [Phase 1 调研](docs/RESEARCH.md) · [MCP SDK v2 迁移记录](docs/MCP_SDK_V2_MIGRATION.md)

## 致谢

本项目的进程树处理代码部分改编自 [cc-plugin-codex](https://github.com/hex1n/cc-plugin-codex)，改动和版权信息见 [NOTICE](NOTICE)。感谢 [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[Zod](https://github.com/colinhacks/zod) 及 ZCode 项目提供的开源工具和运行时。Codex、ZCode 和相关商标归其各自所有者所有；本项目与 OpenAI、Z.ai 或其关联方无隶属或背书关系。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。第三方代码和依赖仍受各自许可证约束，详见 [NOTICE](NOTICE)。
