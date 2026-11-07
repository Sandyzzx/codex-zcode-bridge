# Zcode Bridge — Preview

> **Preview channel:** this is a moving test branch and may change or regress. Use it for testing and feedback, not as the stable production channel. The stable listing remains **Codex ZCode Bridge** on `master`.

把开发任务从 Codex 交给本机 ZCode Agent，在 Codex 中跟进进度并审查实际改动。

### 本渠道当前版本：1.6.0-preview.3

本预览版包含 **Start Plan 实验性集成**（Windows、原生 ZCode AppServer）：官方 ZCode 本机凭据读取、只读 Billing 权益核验、一次性私有凭据交付、进程 HANDLE 身份门禁、取消和崩溃恢复。Coding Plan 的既有执行路径保持不变。

**验收范围**：Start Plan 合成集成及 Windows/Ubuntu CI 已通过；**真实 Start Plan 账户、验证码和模型端到端调用尚未验收**。无可验证权益或遇到需要 Desktop 交互的验证码时拒绝执行；账户 3012 unusual activity 的根因未确认。本渠道面向开发者测试，不保证 Start Plan 已可在所有账号上使用。

反馈问题请提交至 [GitHub Issues](https://github.com/Sandyzzx/codex-zcode-bridge/issues)，尽量提供脱敏的错误码、ZCode CLI 版本和 Bridge 事件；**不要提交 JWT、Cookie、Device ID 或完整账户日志**。

## 使用前

需要 Node.js >= 24.16.0 且 < 25（SQLite 生产要求；旧的 Node 22.18+ 说明不适用于本版本）、Git、已安装并登录的 ZCode，以及支持插件 marketplace 的 Codex。

添加本项目 Preview GitHub marketplace 并安装 **Zcode Bridge**：在桌面应用中先用 CLI 注册 Preview marketplace，再到 **Plugins Directory** 选择并安装；CLI 用户可直接按下方命令安装。之后开启新对话并检查、信任插件的 `SessionStart` hook。Windows 上 hook 会检查本机环境并报告配置问题。Marketplace 安装无需克隆源码或运行 `npm install`；Node.js 和 ZCode 需另行安装。

CLI 安装示例：

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref preview
codex plugin add codex-zcode-bridge@codex-zcode-bridge-preview
```

Update the moving Preview marketplace with:

```sh
codex plugin marketplace upgrade codex-zcode-bridge-preview
```

**更新模型：** 上述 `--ref preview` 安装会跟随 `preview` 分支自动获取后续预览提交。如需固定到当前已验收快照或回滚，使用预览版 Tag 注册：

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-preview-v1.6.0-preview.3
```

**分支用于持续更新，Tag 用于固定快照；Tag 本身不会自动跟踪后续预览提交。** 如需在已有 Marketplace 上切换分支或固定版本，重新执行 `marketplace add ... --ref <ref>`（必要时先用 `codex plugin marketplace remove` 移除后重新添加）；若实际行为与本文不符，以 `codex plugin marketplace add --help` 为准。本渠道尚未完成 Codex Marketplace 客户端实际安装/升级验收。

## 派发任务

向 Codex 描述开发任务和验收条件。Codex 根据任务决定是否准备 worktree，并把任务交给 ZCode。未提供 worktree 时在项目目录执行；提供时在该 worktree 执行。完成后由 Codex 检查 diff 和验收结果。`completed` 不等于 Codex 已接受改动。

遇到安装或启动问题时，可调用 MCP 工具 `zcode_doctor` 查看只读诊断；它不会启动 ZCode session。

可按任务选择 provider/model，也可配置用户默认模型。Windows 单用户本机 SQLite 部署使用固定受信任档案 `yolo`。`yolo` 会放行普通工具操作并使用当前操作系统账户权限。记录版本上已完成单次 43,014-byte Write 的真实审批往返实测。超过单事件行上限的大审批请求会以显式标记的预览事件交付，并附私有完整记录的 `full_request` 引用（路径、字节数、SHA256，按 `JSON.stringify(params)` 紧凑序列化计量）；预览不是全文，批准前需要全文时读引用记录。审批 params 完整保存上限为 1 MiB，超过时会收到含 actual/limit 与拆分建议的明确拒绝。worktree 不是沙箱。

可选浏览器宿主（ADR-007）：`ZCODE_BRIDGE_BROWSER_USE` 默认 `off`；设为 `headless` 后，任务内 ZCode 原生浏览器工具经 `interaction/browserList`/`interaction/browserExecute` 反向 RPC 使用 worker 托管的 headless Chromium/Edge（独立临时 profile，不下载浏览器、不连接用户窗口）。可选 `ZCODE_BRIDGE_BROWSER_EXECUTABLE` 指定系统浏览器绝对路径。插件包内 `worker/vendor/` 自带所需运行资源，不依赖 Codex 的 node_modules。真实模型链路验收与边界见 仓库中的 `../../docs/reports/2026-10-15-browser-and-transport-fixes.md`。

## 安全边界

ZCode 以当前操作系统用户权限运行。Git worktree 不是 OS 沙箱；`allowed_paths` 和 `forbidden_paths` 是任务指令，不能强制限制文件或命令访问。普通本地读取、编辑、构建、测试和批准范围内的清理可按 `yolo` 策略执行；Push、Merge、Tag、Release、生产 Authority 切换、任务范围外的数据删除、凭据修改和真实生产任务数据操作仍需用户明确授权。任务 prompt、Skill 或 worktree 选择不能自行产生这些授权。任务 prompt、日志、可见模型输出和结果会保存在本机 `.codex/codex-zcode-bridge/` 目录。派发前请检查任务可见的工作区内容。

Marketplace 用户配置自定义 ZCode 路径或默认模型的说明见[中文安装指南](https://github.com/Sandyzzx/codex-zcode-bridge/blob/preview/README.zh-CN.md#安装)。
- **Read-only wait helper:** hosts with background-command completion can run the bundled `dist/wait-task.mjs` against the same SQLite Attention Core. The helper never approves, cancels, or mutates task state; its notification still depends on the host lifecycle.
