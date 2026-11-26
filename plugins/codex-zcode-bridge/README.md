# Zcode Bridge (Preview)

把有明确边界的开发任务从 Codex 交给本机官方 ZCode Agent Runtime，在 Codex 中跟进进度，并独立审查实际改动后再决定是否接受。

本插件属于 `2.0.0-preview.18`。Stable 通过独立的 Marketplace 渠道发布。

## 支持范围

| 套餐 | 当前支持 |
| --- | --- |
| Z.ai Start Plan | Preview 支持。通过固定 Official Host 的官方认证投影读取当前账户材料，执行实时模型权益检查，并通过单任务私有凭据 Lease 向官方 Runtime 交付认证。 |
| Z.ai Coding Plan | 使用既有的官方 Coding Plan 账户/API Key 路径。 |

两条路径都通过官方 ZCode AppServer 执行。Start Plan 的真实证据目前仅覆盖 Windows、官方 AppServer `0.17.1` 和 `GLM-5.3-Flash`；其他模型与平台仍取决于官方 Registry、账户权益和实际环境，不能从单一模型的成功推广为全部 Start Plan 模型已验证。Windows runtime host 是随 Bridge 固定分发的官方签名产物，Bridge 不在用户机器上发现、下载或安装 helper。

## 官方 Coding Plan 计费支持

本集成候选分支在 Windows x64 上优先复用已安装的官方 ZCode AppServer 执行
个人 Coding Plan。Bridge 精确校验 Desktop 版本、Bundle、同根 builtin
Provider 配置、runtime host 与 Node 范围；不匹配时以
`OFFICIAL_RUNTIME_UNVERIFIED` fail closed，不会静默宣称积分优惠。

V5 证据覆盖 `GLM-5.3-Flash`、个人 Coding Plan 与
ZCode `3.18.2.10443`：一次原生对照和三次 Bridge 实验均得到约 `0.67` 的
官方额外积分倍率，相当于该已测场景约 `1.5x` 模型使用量。非高峰 `0.5` 是
独立的时段倍率，不能与额外 `0.67` 混为一项，也不能把结果推广到所有模型、
账户、时段或 Start Plan。

本轮生产路径另通过构建后的 MCP/Worker/SQLite 链真实复现：`22,735` Token
对应官方 `1.7666` 积分，正常预期 `2.636755`，有效额外倍率
`0.6699901963`。官方账单延迟结算后使用同一小时快照补充对账，未重派模型任务。

源码仓库提供 Cost Lab 本地网页，用于运行环境校验、零模型协议 Smoke、官方
账单读取、明确授权的真实 Coding Plan 对账和脱敏历史导出：

```powershell
npm run build
npm run cost-lab:web
```

Cost Lab 不进入插件生产包，也不是绕过 Bridge 权限边界的通用命令入口。

## 使用前

Preview 需要 Node.js `>=24.16.0 <25`、Git、已安装并登录的 ZCode，以及支持插件 Marketplace 的 Codex。

添加 Preview Marketplace 并安装 **Zcode Bridge (Preview)**。桌面应用中可先在 CLI 注册 Marketplace，再到 **Plugins Directory** 安装；之后开启新对话并检查、信任插件的 `SessionStart` Hook。

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref preview
codex plugin add codex-zcode-bridge@codex-zcode-bridge-preview
```

更新持续跟随 `preview` 分支的 Marketplace：

```sh
codex plugin marketplace upgrade codex-zcode-bridge-preview
```

固定到已验收的 Preview 快照：

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-preview-v2.0.0-preview.6
```

Marketplace 安装不需要克隆源码或运行 `npm install`；Node.js 和 ZCode 需另行安装。

## 派发和验收

只有当用户明确要求使用 ZCode/Bridge，或既有明确授权覆盖当前目标时，Codex 才应派发任务。普通开发请求不会自动转交 ZCode。

Codex 作为 Master 定义目标、约束、允许范围和验收条件，并选择整任务或分阶段交付。ZCode 在给定 Workspace 中执行工作；如果调用方创建了 Git Worktree，Bridge 使用该现有目录，但不会自行创建、选择或删除 Worktree。

可用 MCP 工具：

- `zcode_task`、`zcode_status`、`zcode_feedback`、`zcode_events`、`zcode_result`
- `zcode_continue`、`zcode_cancel`、`zcode_interaction_reply`
- `zcode_doctor`、`zcode_model_catalog`、`zcode_default_model`、`zcode_set_default_model`、`zcode_clear_default_model`

`completed` 只表示 Worker 执行结束并规范化了报告，不表示 Codex 已接受代码。必须检查实际 Diff、测试和 Result。`zcode_continue` 仅用于验收返工、必要决定、受控恢复或报告修复，不用于普通的分步调度。

遇到安装或启动问题时，可调用只读诊断工具 `zcode_doctor`；它不会启动 ZCode Session。模型目录可通过 `zcode_model_catalog` 查询；Start Plan 条目使用 `<ModelId>-StartPlan` 别名，并在任务执行时进行实时权益检查。

## 安全边界

Bridge 以当前 Windows 用户权限运行。固定 `yolo` 执行档案允许普通读取、编辑、构建、测试和任务范围内清理，但这不是提权或恶意进程隔离机制。

Push、Merge、Tag、Release、生产 Authority 切换、任务范围外删除、凭据修改和真实生产任务数据访问仍需用户明确授权。任务 Prompt、Skill、路径列表和 Worktree 选择不会自行产生这些授权。

Git Worktree 只是工作目录布局，不是 OS 沙箱。`allowed_paths` 和 `forbidden_paths` 是任务指令，不是强制访问控制。派发前应检查 ZCode 可见的工作区内容，不要在 Prompt 中放入凭据、JWT、私钥或敏感账户数据。

Start Plan 不支持绕过 CAPTCHA 或 unusual activity；需要用户交互的官方账户流程应由用户在官方 ZCode 客户端中处理，Bridge 在无法确认权益时 fail-closed。

本候选分支的 Start Plan 只完成了离线兼容性研究：它使用独立的 unsigned
Provider、凭据、Runtime Auth、Runtime Headers 与 `zcode-plan/anthropic`
Gateway；真实 Start Plan E2E、额度、CAPTCHA 与优惠均未在本次集成中验证。

## SQLite Authority

Bridge 的任务权威存储是 SQLite。首次启动会创建并验证：

```text
${LOCALAPPDATA}\CodexZCodeBridge\state\bridge.sqlite
```

当前插件只支持 `SQLite v14 ONLY`。已有 v13 数据库或 v13→v14 未完成升级 Marker 会被非破坏性拒绝并返回 `unsupported_sqlite_schema`；插件不包含 v13 Schema、自动升级、离线升级或恢复 CLI。未知 Schema、损坏数据库、Writer 冲突和无法解释的现场继续 fail closed；不要通过清除 Hold 强制启动。完整说明见仓库的 [Runtime 指南](../../docs/ZCODE_RUNTIME.md) 和 [中文主 README](../../README.zh-CN.md)。

ADR-018 的管理性放弃命令随插件交付为 `dist/admin-abandon-held-operation.mjs`，并与同一包的 v14 schema/Store 构建绑定。它只用于经单独授权且满足全部停机、重启、身份和 claimant 条件的一个 `cleanup_incomplete` Hold；不要改用手工构造的旧开发 `dist`。执行前按 Master Skill 的恢复参考完成只读核对。

## 可选后台等待器

支持后台命令完成通知的 Host 可运行插件包内的只读 `dist/wait-task.mjs`。它观察同一 SQLite Attention Core，不批准、取消或修改任务状态；通知仍取决于 Host 的生命周期。

## Executor 与 Task CLI

候选版本的插件包同时包含 `dist/executor.mjs` 和 `dist/task-cli.mjs`。Executor 是
SQLite Authority、Worker、Official Runtime 和 Recovery 的唯一持有者；Task CLI
只通过同用户 Named Pipe 调用 Executor，不直接打开 SQLite。

在插件安装目录运行：

```powershell
node dist/task-cli.mjs executor start
node dist/task-cli.mjs executor status
node dist/task-cli.mjs task list --limit 20
node dist/task-cli.mjs task status <task_id>
node dist/task-cli.mjs executor stop
```

`executor start` 检测到已有活动 Executor 时不会再次 Spawn。无 Lease history 的
既有 SQLite Root 必须由用户先停止并核对旧 MCP Host，再显式附加
`--accept-unleased-transition`；该参数不绕过已记录的精确活动 owner。`executor stop`
只执行 Idle-only Shutdown，活动任务或未知关闭状态会以非零退出，不会自动取消任务。

## Task Web Console

插件同时包含只读优先的 `dist/web-console.mjs`。它只绑定 `127.0.0.1`，通过同一
Executor Control Pipe 读取 Task/Status/Event/Result，并允许显式 Continue、关联
返工、Cleanup Recovery、Cancel 和 Interaction Reply。页面是单页 Task
Workspace：左侧 inbox 先显示状态、失败原因和下一步动作，右侧按 Overview、
Available actions、Acceptance/Attention、Attempt timeline、Result、
Execution usage、折叠的 Wake/Cleanup/Release 证据和折叠 Events 排列。它不创建
Task、不打开 SQLite、不控制 Executor 生命周期，也不在页面加载时调用模型。

```powershell
node dist/web-console.mjs --data-root <absolute-state-dir>
```

所有状态变更请求要求同源 Host、Origin 和会话 CSRF 头。页面刷新或浏览器关闭只会
关闭本地 HTTP 请求，不会取消已受理 Task。

Console 使用运行时分配的实际端口，并在 Authority Root 内以
`task-console.json` 发布非秘密发现记录；同一 Root 的第二个 Console 会复用安全
存活的 Owner。可用 `node dist/task-cli.mjs task console-url <task_id>` 取得经过
`/api/session` 校验的 `http://127.0.0.1:<actual-port>/?task_id=<task_id>` 链接；
不可用时命令失败，不拼接虚假地址。Deep Link 只携带 Task ID，不包含 CSRF 或凭据。
