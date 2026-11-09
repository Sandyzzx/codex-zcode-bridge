# Zcode Bridge

把开发任务从 Codex 交给本机 ZCode Agent，在 Codex 中跟进进度并审查实际改动。

## 使用前

当前 Preview 版本为 `2.0.0-preview.1`，需要 Node.js `>=24.16.0 <25`、Git、已安装并登录的 ZCode，以及支持插件 marketplace 的 Codex。

添加 Preview marketplace 并安装 **Zcode Bridge (Preview)**：在桌面应用中先用 CLI 注册 marketplace，再到 **Plugins Directory** 选择并安装；CLI 用户可直接按下方命令安装。之后开启新对话并检查、信任插件的 `SessionStart` hook。Windows 上 hook 会检查本机环境并报告配置问题。Marketplace 安装无需克隆源码或运行 `npm install`；Node.js 和 ZCode 需另行安装。

Preview 安装：

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref preview
codex plugin add codex-zcode-bridge@codex-zcode-bridge-preview
```

已安装 Preview marketplace 的更新命令：

```sh
codex plugin marketplace upgrade codex-zcode-bridge-preview
```

固定到已验收的 Preview 快照：

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-preview-v2.0.0-preview.1
```

`preview` 分支用于持续更新；Tag 是固定快照，不会跟随后续 Preview 提交。

## 派发任务

向 Codex 描述开发任务和验收条件。Codex 根据任务决定是否准备 worktree，并把任务交给 ZCode。未提供 worktree 时在项目目录执行；提供时在该 worktree 执行。完成后由 Codex 检查 diff 和验收结果。`completed` 不等于 Codex 已接受改动。

遇到安装或启动问题时，可调用 MCP 工具 `zcode_doctor` 查看只读诊断；它不会启动 ZCode session。

可按任务选择 provider/model，也可配置用户默认模型。单用户本机 SQLite 使用固定受信任档案 `yolo`。`yolo` 会放行普通工具操作并使用当前操作系统账户权限。历史审批实测不代表当前所有 runtime 版本认证。交互持久化使用 SQLite request/reply/ACK 合同；worktree 不是沙箱。

可选浏览器宿主（ADR-007）：`ZCODE_BRIDGE_BROWSER_USE` 默认 `off`；设为 `headless` 后，任务内 ZCode 原生浏览器工具经 `interaction/browserList`/`interaction/browserExecute` 反向 RPC 使用 worker 托管的 headless Chromium/Edge（独立临时 profile，不下载浏览器、不连接用户窗口）。可选 `ZCODE_BRIDGE_BROWSER_EXECUTABLE` 指定系统浏览器绝对路径。插件包内 `worker/vendor/` 自带所需运行资源，不依赖 Codex 的 node_modules。真实模型链路验收与边界见 仓库中的 `../../docs/reports/2026-10-15-browser-and-transport-fixes.md`。

## 安全边界

ZCode 以当前操作系统用户权限运行。Git worktree 不是 OS 沙箱；`allowed_paths` 和 `forbidden_paths` 是任务指令，不能强制限制文件或命令访问。普通本地读取、编辑、构建、测试和批准范围内的清理可按 `yolo` 策略执行；Push、Merge、Tag、Release、生产 Authority 切换、任务范围外的数据删除、凭据修改和真实生产任务数据操作仍需用户明确授权。任务 prompt、Skill 或 worktree 选择不能自行产生这些授权。任务 prompt、日志、可见模型输出和结果会保存在本机 `.codex/codex-zcode-bridge/` 目录。派发前请检查任务可见的工作区内容。

Marketplace 用户配置自定义 ZCode 路径或默认模型的说明见 [Preview 中文安装指南](https://github.com/Sandyzzx/codex-zcode-bridge/blob/preview/README.zh-CN.md#安装)。

Start Plan 支持仍属实验性能力，真实账户 Billing 和模型 E2E 尚未验收。3012 unusual activity 的根因未确认；需要 Desktop CAPTCHA 的场景不支持无交互处理。Billing 响应的成功结构仍缺少真实样本核验。不要把凭据发现、Provider 注册或合成测试结果当作真实模型请求成功。
- **Read-only wait helper:** hosts with background-command completion can run the bundled `dist/wait-task.mjs` against the same SQLite Attention Core. The helper never approves, cancels, or mutates task state; its notification still depends on the host lifecycle.
