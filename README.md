# Codex → ZCode Bridge

Codex 插件与本地 MCP 服务，用于把明确授权的开发任务交给本机 ZCode Agent 执行。Codex 可查看进度、选择模型、审查改动并决定是否接收。

## 功能

- 在 Codex 中派发、跟踪、续作和取消 ZCode 任务。
- 支持多个项目任务并行；共享执行目录的任务会排队。
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

安装后开启新对话，并检查、信任插件的 `SessionStart` hook。Windows 上 hook 会自动发现并验证 Node.js、ZCode runtime、provider 配置和数据目录，将设置保存到 `%USERPROFILE%\.codex\codex-zcode-bridge\runtime-config.json`。它不会写入 Windows 用户环境变量或复制 provider 凭据。标准安装不需要克隆仓库或运行 `npm install`；Marketplace 不会代为安装 Node.js 或 ZCode。

如需自定义设置，直接编辑 `%USERPROFILE%\.codex\codex-zcode-bridge\runtime-config.json`。在 macOS/Linux 上对应 `~/.codex/codex-zcode-bridge/runtime-config.json`。Windows 首次启动时 hook 会创建该文件；其他平台如文件不存在，可自行创建。保留自动发现的路径字段，只修改需要覆盖的值：

- `ZCODE_BRIDGE_NODE`：Node.js 可执行文件的绝对路径（仅当 `node` 不在 PATH 中时需要）。
- `ZCODE_BRIDGE_ZCODE_CJS`：ZCode runtime 的绝对路径。
- `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 与 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`：builtin 和个人 provider 配置文件的绝对路径。
- `ZCODE_HOME`：实际 `.zcode` 数据目录的绝对路径。
- `ZCODE_BRIDGE_DATA_DIR`：Bridge 任务数据目录的绝对路径。
- `ZCODE_BRIDGE_DEFAULT_PROVIDER_ID` 与 `ZCODE_BRIDGE_DEFAULT_MODEL_ID`：默认 provider 和 model ID，必须成对填写。
- `ZCODE_BRIDGE_MODE`：初始执行模式，可设为 `plan`、`build`、`edit` 或 `yolo`，默认 `yolo`。`yolo` 会放行普通工具操作并使用当前操作系统账户权限；如需 ZCode 的审批规则，可设为 `build`。
- `ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS`：单进程并行任务上限，范围 1–8，默认 8；重叠执行路径仍会串行。
- `ZCODE_BRIDGE_TIMEOUT_MS`：未在任务中指定 `timeout_ms` 时使用的单次执行时限，单位毫秒，范围 60,000–14,400,000；默认 3,600,000（60 分钟）。

保存为有效 JSON 后，新启动的 Bridge 会读取配置文件；它优先于旧环境变量设置。`ZCODE_HOME` 应指向 `.zcode` 目录，个人 provider 配置文件需位于该目录下的 `v2/provider_config.json`。Provider/model ID 请从 ZCode 配置中复制，不要改写 ZCode 的 provider 文件。

Codex 的 marketplace 安装说明见[OpenAI 官方插件文档](https://developers.openai.com/plugins/build/plugins)。

## 使用

描述要完成的开发任务，并说明验收条件。Codex 会按需要准备 worktree，再将任务交给 ZCode；如指定 worktree，任务在该目录执行，否则直接在项目目录执行。ZCode 不会自动获得 Codex 的完整对话，因此需要的项目决定和约束应由 Codex 随任务提供。

ZCode session 标题根据首条任务 prompt 生成。Bridge 会将 `TASK ID` 放在 prompt 首行，但标题可能还包含后续 prompt 文本。

任务完成后，Codex 应检查实际 diff 并独立运行验收。`completed` 只表示 ZCode 已报告执行结束，不代表改动已通过 Codex 审查。若任务遇到未解决且会影响重要行为的决定，ZCode 会请求 Codex 指示后再继续。

ZCode Desktop 的 Workspace 视图按 Codex 项目目录查找任务。

遇到安装或启动问题时，调用 MCP 工具 `zcode_doctor` 获取只读诊断。它不会启动 ZCode 会话；模型能否被 app-server 选中以及真实权限审批往返仍需由实际任务验证。

## 已知问题

- ZCode Desktop 侧栏可能不会立即刷新并显示新会话。Bridge 会尽力同步本机任务索引，列表刷新时机由 Desktop 决定。
- 目前无法通过 Bridge 使用 ZCode Start Plan。

## 安全与限制

- 默认执行模式为 `yolo`。它会放行普通工具操作，并以当前操作系统账户权限运行；worktree 不是沙箱。如需 ZCode 的审批规则，将配置文件中的 `ZCODE_BRIDGE_MODE` 设为 `build`。Bridge 的权限请求转发已有协议测试，但真实 ZCode 权限审批往返尚未验证。
- Git worktree 只隔离工作目录，不是操作系统沙箱；`allowed_paths` 和 `forbidden_paths` 是任务约束说明，不能阻止进程访问其他文件或执行命令。
- 是否创建 worktree 由 Codex 根据任务决定；Bridge 使用传入的项目目录和可选 worktree 路径，不替用户创建或删除 worktree。
- 并行任务会增加本机资源占用和 provider 并发使用。
- Bridge 将 prompt、状态、日志、可见模型输出、事件和结果保存在本机 `~/.codex/codex-zcode-bridge/`（Windows 为 `%USERPROFILE%\.codex\codex-zcode-bridge\`）；等待审批时还会保存必要的工具输入。请勿在任务或工作区中放入不应发送给所选模型服务或持久化到本机的数据。
- Bridge 使用本机 ZCode app-server；交互请求是否出现及协议字段受已安装的 ZCode 版本影响。Bridge 会通过 `interaction_requested` 事件将权限或用户输入请求交给 Codex，再用 `zcode_interaction_reply` 回答。AskUserQuestion 的 `answers` 以每个问题的完整 `question` 文本为键、答案为值，不能用表头或选项标签作键；真实 ZCode 用户输入往返已验证，真实权限审批往返尚未验证。权限请求只应在用户明确授权后放行。

## 源码构建

仓库保留 TypeScript 源码供审查和自行构建。需要 Node.js 22.18+，运行：

```sh
npm ci
npm run build
```

## 致谢与许可证

进程管理部分参考并改编自 [cc-plugin-codex](https://github.com/hex1n/cc-plugin-codex)；ZCode Desktop 任务索引部分参考并改编自 [zcode-acp](https://github.com/william0wang/zcode-acp)。感谢 [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[Zod](https://github.com/colinhacks/zod) 和 ZCode 项目。来源与版权说明见 [NOTICE](NOTICE)。

本项目采用 [Apache License 2.0](LICENSE)。第三方组件仍受其各自许可证约束。
