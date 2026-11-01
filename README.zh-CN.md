# Codex → ZCode Bridge

**Codex 负责规划、派发和验收，ZCode 在本机执行开发任务。**

> **Preview 预览版。** 本版本引入 SQLite 持久化任务状态和恢复机制。已经在 Windows 本地生产环境验证，但尚不代表其他用户环境或跨平台兼容性已全面通过。原 JSON 用户升级前请务必阅读迁移说明。

[English](README.md) · [项目仓库](https://github.com/Sandyzzx/codex-zcode-bridge) · [版本发布](https://github.com/Sandyzzx/codex-zcode-bridge/releases)

## 这是什么？

在 Codex 中，通过 MCP Bridge 把明确的开发任务交给本机 ZCode Agent。Codex 可以查看任务进度、处理交互、审查代码和测试结果，并决定接收、取消或继续执行。

ZCode 不会自动获得 Codex 的完整对话上下文；Master 应随任务提供必要的需求、项目约束和验收条件。ZCode 报告 `completed` **不等于** Codex 已批准代码。

## 核心能力

- **任务派发：** 创建、查看、取消、续作 ZCode 任务；Master Skill 支持单次派发与整任务派发的工作指导。
- **事件与反馈：** 通过 `zcode_status`、`zcode_events`、`zcode_feedback`、`zcode_result` 跟踪任务，并通过 MCP 交互工具处理权限或用户提问。
- **模型选择：** 查询 ZCode 的 provider / model，按任务指定模型或设置默认模型。
- **Codex 主会话 Token：** Master Skill 可在显式提供 `CODEX_THREAD_ID` 时只读本机 Codex Rollout；委派前保存起点后，报告有边界的任务窗口增量。不会读取 Provider 凭据，也不会用账户额度、会话总量或文本长度估算。
- **并行调度：** 不同执行目录可并行工作，重叠执行范围受调度协调。
- **SQLite 持久化：** 新任务的 Operation、Attempt、Claim、Event、Cleanup 和重启恢复记录使用 SQLite。
- **异常恢复：** 不确定的 Cleanup 不会被伪装成已完成；只有满足证据条件的异常执行才可走受控的管理员放弃路径。
- **可选 Git Worktree：** 保留源项目身份，同时在独立 worktree 执行；Worktree 并不是安全沙箱。

## 环境要求

- **Windows：** 本轮真实生产切换及 Provider E2E 验证平台。macOS、Linux 尚未完整验证。
- **SQLite 模式要求 Node.js >= 24.16.0 且 < 25。** 旧 JSON 模式的 Node >= 22.18 要求不能直接套用于 SQLite。
- Git、已安装并登录 ZCode 的本地环境、支持 Marketplace 插件的 Codex。
- **单用户、可信本地**部署环境，不提供多用户/远程隔离，也不对同一账户下的恶意进程作强隔离承诺。

Marketplace 不会替你安装 Node.js 或 ZCode。

## 安装 Preview

请使用 GitHub **Prerelease 对应的 Tag**，不要在测试预览版时直接跟随 `master`。将 `<preview-tag>` 替换为 [GitHub Releases](https://github.com/Sandyzzx/codex-zcode-bridge/releases) 显示的实际标签：

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.3.0-rc.1
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

也可以注册对应版本的 Marketplace 后，在 Codex **Plugins Directory** 安装 **Zcode Bridge**。开启新对话，审查并信任 `SessionStart` Hook。首次启动会发现本机的 ZCode 运行时和配置，不复制 Provider 凭据；安装问题可使用 `zcode_doctor` 诊断。

**全新安装：** SQLite 从空任务库开始。普通本地项目目录、可选 Git Worktree 沿用以前的工作方式，不要求新用户创建 `trusted-local-policy.json`，也不要求维护 `workspace_roots` 白名单。

## 重要：原 JSON 版本升级说明

**升级前请先完成重要任务，或保存尚未完成的任务说明。** 新版本不会把旧 JSON 任务的生命周期状态导入 SQLite：

- **`queued` 排队任务：** 切换后不会自动开始执行。
- **`running` 运行中任务：** 升级前等待执行结束，或按正常流程安全取消并完成清理。
- **`waiting_for_master` 待验收任务：** 请先完成审查或保存必要的交接信息。
- **旧任务不支持自动 Resume / Continue：** 如需继续工作，请在 SQLite 模式下新建任务。

正式迁移采用 **停机切换**：停止旧 JSON Writer/Worker，核验退出状态，将原 `.tasks` 目录完整保留为只读归档，然后发布**空 SQLite Authority**，仅管理切换后的新任务。**不会把旧历史转换成 SQLite，也不会自动静默升级。**

请长期保留旧 JSON 归档，切勿重复对已经发布的 SQLite Authority 执行迁移。SQLite 已产生新写入后，不得简单恢复切换前 JSON 快照，否则可能丢失新任务数据。

**已有 JSON 用户不要只手工修改 `authority.json`。** 应使用与所安装版本匹配、经过验证的停机迁移流程，确认数据根、归档、发布回执与旧 Worker 退出状态。若尚无适用于自己环境的正式迁移步骤，应先保留旧版本，暂缓升级。

## 日常使用

1. 在 Codex 打开实际项目目录。
2. 让 Codex 派发给 ZCode，明确目标、约束及验收条件。
3. 查看任务事件、交互、模型信息、执行结果及实际代码差异。
4. 由 Codex 独立验证后接收结果，或提出下一轮 Continue。

调用超时或回执丢失时，先查询原 Task ID，避免重复创建任务；支持重试的操作使用稳定的 Operation ID。

## 配置

Windows 首次运行配置位于 `%USERPROFILE%\.codex\codex-zcode-bridge\runtime-config.json`。可以按需覆盖 ZCode 路径、Provider 配置、默认模型、执行模式、并发和超时，但不要复制他人电脑的绝对路径。

SQLite 生产数据库、旧 JSON 源目录与归档目录必须分开；实际位置由安装与迁移配置决定。不要手工改写 SQLite 表、Authority Receipt 或迁移 Marker。某些执行模式可能赋予 ZCode 较宽的本机工具权限，涉及权限审批时应选择适合的执行模式，不要在 Prompt 中放入凭据。

## 已知限制与排障

- 本轮真实 Provider 与 SQLite 生产切换仅在 Windows 单用户可信本地环境得到验证；Preview 不代表其他平台已获得生产认证。
- ZCode Start Plan 目前不作为本版本已验证的 Bridge 支持路径；具体 Provider 能力取决于本机 ZCode 环境。
- Worker 在未提交 Result 时可能异常退出。Bridge 会保留 Cleanup Hold，而不是假设进程资源已完全关闭。不要直接编辑数据库或按进程名终止未知进程；应保存证据并使用正式恢复方案。
- ZCode Desktop 中的任务列表可能延后刷新。
- Git Worktree 仅隔离工作目录，不是操作系统安全沙箱。

源码、协议及设计约束分别见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/INTERFACES.md`](docs/INTERFACES.md)、ADR-016 和 ADR-017。正常 Marketplace 安装不需要下载源码并执行 `npm install`。

## 许可证

Apache-2.0。第三方来源与版权说明见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
