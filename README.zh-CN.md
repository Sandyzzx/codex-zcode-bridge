# Codex ZCode Bridge

[English](README.md) · [版本发布](https://github.com/Sandyzzx/codex-zcode-bridge/releases)

Codex ZCode Bridge 将 Codex 与本机官方 ZCode Agent Runtime 连接起来。把开发任务交给 ZCode，任务中断后仍可查询进度，完成后由 Codex 独立审查和验收。

## 为什么用 Bridge？

- **持久化 Agent 任务委派。** 把目标、范围和验收条件一起交给 ZCode。Bridge 保存任务状态和结果，Codex 可以跟进或恢复中断的任务。
- **复用官方 ZCode Runtime。** ZCode 使用自己的 AppServer 执行模型和工具，Codex 负责任务定义与结果审查。
- **同时支持 Coding Plan 和 Start Plan。** 可使用 Z.ai Coding Plan 账户，也可选择 Start Plan。Start Plan 走独立官方认证路径，检查所选模型的权益，并按任务管理凭据。
- **单页 Task Workspace 与显式诊断。** 用可扫描的 Task 收件箱查看状态、失败原因与安全恢复动作，并在同一页面查看 Attempt、Result、Cleanup、Release 与 Token 用量。Bridge 没有 Provider 结算证据时，Provider 实际成本会明确显示为未观测。Runtime 与成本证据检查位于 Diagnostics。

## 预览版套餐支持

Bridge 复用本机安装的 ZCode Runtime，实际可用模型、套餐额度、计费倍率及使用权限均由 ZCode 和相应模型服务商决定。

| 套餐 | 说明 |
| --- | --- |
| **Z.ai Coding Plan** | 支持正常授权的模型调用；已有安装版官方 AppServer 的 Windows 真实端到端执行历史。Bridge 不承诺积分倍率或其他促销权益，实际计费以 Z.ai 官方当前政策为准。 |
| **Z.ai Start Plan** | 保留技术适配实现。当前官方政策限定其在官方 ZCode 客户端内使用，因此 Bridge 不承诺其可用性，也不绕过官方访问限制。 |

已验证的 ZCode Desktop 安装：`3.18.2.10443`（完整历史验证）、`3.19.0.10774`（协议 Smoke + 一次真实 Coding Plan 执行）、`4.0.0.10870`（协议 Smoke + 2026-11-24 随包制品真实任务 E2E）。其他安全安装直接运行、无版本门禁；其兼容性在列入此处前保持未验证。README 列出已经验证的 ZCode 版本，但不以静态版本白名单或折扣验证结果作为任务执行门槛（ADR-054）。

套餐政策可能随时调整——活动、额度、计费规则及使用范围以官方最新政策为准。Bridge 的核心目标是提供可靠的异步 Agent 派发、任务持久化、生命周期管理及 Token 消耗优化，而非获取额外套餐优惠。

## 安装

预览版环境为 **Windows x64** 和 **Node.js `24.16.0`**。任何通过安全检查的官方 ZCode Desktop 安装均可运行（ADR-054）；已完成实际验证的版本如下列出。请先登录 ZCode，确认账户可使用目标套餐和模型，并准备 Git 和支持插件的 Codex。Node.js 和 ZCode 需单独安装。

同一个 Codex 安装中选择一个 Marketplace 渠道即可。安装版 Runtime 集成、SQLite v14-only 运行时、事件分页、可选结果摘要、独立 Executor 与 Thin MCP、Executor 崩溃自动恢复、单页 Task Workspace、带验收驱动返工的 Async Master Handoff、持久化 Owner Binding 与安装即生效的 Auto Wake 位于预览版 `2.0.0-preview.17`，稳定版为 `v1.7.2`。

Auto Wake 不再需要逐任务授权文件：安装并启用插件即接受本机可信 Auto Wake 合同。可信 Codex Thread ID 来自 MCP Host 请求上下文，在 Worker 启动前持久化，并在 Release 后用于一次官方 Codex Queue 投递；该投递会以原会话当前模型恢复 Codex，因此可能产生额外 Codex 用量。可在 Task Workspace 的 Diagnostics 中关闭 Auto Wake，此时只保留 Web 观察、不提交 Queue。Queue ACK 不代表原 Turn 已启动，`web_notify` 只是 fallback observation。真实 Codex Host 的完成 Wake E2E（含非空工程交付）已于 2026-11-24 通过；Desktop 完全退出后的恢复、notLoaded 场景与 Official Runtime provenance 仍未验证。

### 预览版

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref preview
codex plugin add codex-zcode-bridge@codex-zcode-bridge-preview
```

更新预览版 Marketplace：

```sh
codex plugin marketplace upgrade codex-zcode-bridge-preview
```

### 稳定版

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.7.2
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

安装后开启新的 Codex 会话，并审查插件的 `SessionStart` Hook。遇到配置问题时，可以让 Codex 运行 `zcode_doctor`。

## 委派第一个任务

1. 在 Codex 中打开项目，明确要求使用 ZCode Bridge。有偏好时写明套餐和模型。
2. 说明任务目标、允许修改的文件、预期测试和验收条件。
3. 随时询问进度。Codex 可以使用 `zcode_status`、`zcode_feedback` 或 `zcode_events` 跟进任务。
4. 让 Codex 独立检查工作区差异、测试证据和 `zcode_result`，再决定是否验收。

> 使用 ZCode Bridge，选择 Coding Plan 的 GLM-5.3-Flash。修复失败的解析器测试，只修改解析器和相关测试，运行定向测试，并由 Codex 审查结果。不要提交或推送。

请在可信的单用户环境运行 Bridge。Git Worktree 可用于分开管理修改，文件权限仍由当前系统账户决定。

## 查看任务与诊断

任务回执会链接到本地 Task Workspace。在预览版源码目录执行：

```powershell
npm ci
npm run build
npm run bridge:cli -- executor start
npm run bridge:cli -- task console-url <task_id>
```

Task 收件箱使用可扫描行显示 Workspace、状态、Attempt、模型、套餐、消耗、更新时间和行内 Attention 原因。需处理任务优先排序；已完成任务显示 Review ready / Awaiting review / Review blocked。同页 Task 工作台先显示 Overview、Available actions 与 Acceptance/Attention，再显示 Attempt 时间线、Result、Worker/Master 消耗、折叠的 Wake/Cleanup/Release 证据和折叠 Events。Plan、Discount、Model 与 Effort 分开显示。没有 Provider 结算证据时，Provider 实际成本明确为 `not_observed`，原因码为 `bridge_authority_has_no_provider_settlement`，不会推定为 0 或估算值。

原独立的 Runtime 与 Cost Lab 主导航页面已退役。Runtime 静态检查、授权的零模型协议探针、Candidate Report 导出，以及成本证据的环境、历史与验证入口仍在 **Diagnostics** 中提供。打开 Task Workspace 或 Diagnostics 不会发出模型、Runtime 探针或 Billing 请求；每项外部读取或检查都必须显式点击。真实 Coding Plan 验证仍需既有显式确认流程。

## 文档

- [架构](docs/ARCHITECTURE.md)
- [Coding Plan 历史积分实测（不构成承诺）](docs/evidence/coding-plan-official-discount-verification-20261118.md)
- [Start Plan 兼容性](docs/research/start-plan-official-appserver-compatibility-20261118.md)
- [排障、运行环境与升级](docs/ZCODE_RUNTIME.md)
- [插件安全说明](plugins/codex-zcode-bridge/SECURITY.md)

## 许可证

Apache-2.0，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
