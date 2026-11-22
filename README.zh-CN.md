# Codex ZCode Bridge

[English](README.md) · [版本发布](https://github.com/Sandyzzx/codex-zcode-bridge/releases)

Codex ZCode Bridge 将 Codex 与本机官方 ZCode Agent Runtime 连接起来。把开发任务交给 ZCode，任务中断后仍可查询进度，完成后由 Codex 独立审查和验收。

## 为什么用 Bridge？

- **持久化 Agent 任务委派。** 把目标、范围和验收条件一起交给 ZCode。Bridge 保存任务状态和结果，Codex 可以跟进或恢复中断的任务。
- **复用官方 ZCode Runtime。** ZCode 使用自己的 AppServer 执行模型和工具，Codex 负责任务定义与结果审查。
- **同时支持 Coding Plan 和 Start Plan。** 可使用 Z.ai Coding Plan 账户，也可选择 Start Plan。Start Plan 走独立官方认证路径，检查所选模型的权益，并按任务管理凭据。
- **已验证的 Coding Plan 积分优惠。** 在已测试配置下，同样模型用量约消耗正常计价的 `0.67` 倍积分，每积分可获得约 `1.5` 倍的模型用量。
- **Cost Lab 本地积分验证。** 在本地网页检查官方运行时，查看 Token 用量，并与官方积分账单对账。

## 预览版套餐支持

| 套餐 | 验证情况 |
| --- | --- |
| **Z.ai Coding Plan** | 已通过安装版官方 AppServer 在 Windows 上完成真实端到端执行。`GLM-5.3-Flash` 官方账单确认额外 `0.67` 倍扣分。 |
| **Z.ai Start Plan** | 有历史 Windows 真实端到端证据。已检查 Desktop `3.18.2.10443` AppServer 的离线兼容性，该 AppServer 的实时端到端验证尚未执行。 |

Coding Plan 的结果适用于已验证的账户、模型和运行时。`1.5` 倍指积分使用效率，套餐授予额度另计。Start Plan 的积分优惠尚未验证。

## 安装

预览版环境为 **Windows x64**、**Node.js `24.16.0`** 和已安装的官方 **ZCode Desktop `3.18.2.10443`**。请先登录 ZCode，确认账户可使用目标套餐和模型，并准备 Git 和支持插件的 Codex。Node.js 和 ZCode 需单独安装。

同一个 Codex 安装中选择一个 Marketplace 渠道即可。本文的安装版 Runtime 集成、Cost Lab、SQLite v14-only 运行时、事件分页、可选结果摘要、完整已捕获响应 AgentReport 解析、统一 `zcode_cancel` 终态释放和无固定次数的 Recovery 观察去重位于预览版 `2.0.0-preview.13`，稳定版为 `v1.7.2`。

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

## 用 Cost Lab 核对积分

配置与使用见 [Cost Lab — 本地积分验证工具](tools/cost-lab/README.md)。在预览版源码目录执行：

```powershell
npm ci
npm run build
npm run cost-lab:web
```

打开命令打印的本机地址，查看运行时检查、模型 Token、官方积分和验证历史。加载网页不消耗模型额度，真实 Coding Plan 验证需要主动确认。Cost Lab 对 Start Plan 提供离线检查。

## 文档

- [架构](docs/ARCHITECTURE.md)
- [Coding Plan 官方积分证据](docs/evidence/coding-plan-official-discount-verification-20261118.md)
- [Start Plan 兼容性](docs/research/start-plan-official-appserver-compatibility-20261118.md)
- [排障、运行环境与升级](docs/ZCODE_RUNTIME.md)
- [插件安全说明](plugins/codex-zcode-bridge/SECURITY.md)

## 许可证

Apache-2.0，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
