# Codex → ZCode Bridge

**Codex 负责规划、派发和验收，ZCode 在本机执行开发任务。**

> **稳定版。** `v1.3.0` 为没有既有 SQLite 数据库的新安装及升级用户自动初始化 SQLite。Windows 单用户本地环境是本版本已验证的部署目标；其他平台尚未完整验证。

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

## 安装 v1.3.0

请使用 GitHub **正式 Release 对应的 Tag**，不要直接跟随 `master`。以下命令固定到 [GitHub Releases](https://github.com/Sandyzzx/codex-zcode-bridge/releases) 显示的实际标签：

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.3.0
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

也可以注册对应版本的 Marketplace 后，在 Codex **Plugins Directory** 安装 **Zcode Bridge**。开启新对话，审查并信任 `SessionStart` Hook。首次启动会发现本机的 ZCode 运行时和配置，不复制 Provider 凭据；安装问题可使用 `zcode_doctor` 诊断。

**SQLite 自动启动：** 首次启动插件时，Bridge 会自动创建并验证 `${LOCALAPPDATA}\CodexZCodeBridge\state\bridge.sqlite`，完成默认 Capacity provision 后才接受 MCP 请求。Marketplace 新装和旧 JSON 版本升级使用同一流程。无需创建 `authority.json`、运行 SQLite 激活或 JSON 迁移命令，也无需配置 `trusted-local-policy.json` 或维护 `workspace_roots` 白名单。

已有有效 SQLite 数据库会原样复用，不会重置。数据库损坏、SQLite 状态不完整、Schema 不受支持或完整性验证失败时，Bridge 会停止启动；不会回退 JSON，也不会覆盖数据库。

## 重要：原 JSON 版本升级说明

**升级前请先完成重要任务，或保存尚未完成的任务说明。** 新 SQLite 数据库从空状态开始，不会迁移旧 JSON 任务生命周期：

- **`queued` 排队任务：** 升级后不会自动开始执行。
- **`running` 运行中任务：** 升级前等待执行结束，或按正常流程安全取消并完成清理。
- **`waiting_for_master` 待验收任务：** 请先完成审查或保存必要的交接信息。
- 旧任务不会自动 **Resume / Continue**；需要继续的工作应在新版本中重新创建任务。

Bridge 不读取、导入、归档、修改或删除旧 JSON 文件。是否留存由用户自行决定；旧任务历史不会出现在 SQLite 中。

## 日常使用

1. 在 Codex 打开实际项目目录。
2. 让 Codex 派发给 ZCode，明确目标、约束及验收条件。
3. 查看任务事件、交互、模型信息、执行结果及实际代码差异。
4. 由 Codex 独立验证后接收结果，或提出下一轮 Continue。

调用超时或回执丢失时，先查询原 Task ID，避免重复创建任务；支持重试的操作使用稳定的 Operation ID。

## 配置

Windows 首次运行配置位于 `%USERPROFILE%\.codex\codex-zcode-bridge\runtime-config.json`。可以按需覆盖 ZCode 路径、Provider 配置、默认模型、执行模式、并发和超时，但不要复制他人电脑的绝对路径。

SQLite 默认使用当前用户的数据根。不要手工改写 SQLite 表、Authority Receipt 或 Bootstrap Marker。

在受支持的 Windows 单用户可信本地部署中，SQLite 使用固定受信任的 `yolo` 执行档案，与 JSON 路径的普通无人值守编码工作流一致。它以当前 Windows 账户权限运行，不是沙箱，也不是提权。工作区内的普通读取、编辑、构建、测试和任务范围内清理可以自动执行；Push、Merge、Tag、Release、生产 Authority 切换、任务范围外删除、凭据修改和真实生产任务数据访问仍需用户明确授权。任务 Prompt、Skill、worktree 和路径清单不能自行授予这些权限。不要在 Prompt 中放入凭据。

## 已知限制与排障

- 本轮真实 Provider 与 SQLite 生产切换仅在 Windows 单用户可信本地环境得到验证；本版本不代表其他平台已获得生产认证。
- ZCode Start Plan 目前不作为本版本已验证的 Bridge 支持路径；具体 Provider 能力取决于本机 ZCode 环境。
- Worker 在未提交 Result 时可能异常退出。Bridge 会保留 Cleanup Hold，而不是假设进程资源已完全关闭。不要直接编辑数据库或按进程名终止未知进程；应保存证据并使用正式恢复方案。
- ZCode Desktop 中的任务列表可能延后刷新。
- Git Worktree 仅隔离工作目录，不是操作系统安全沙箱。

源码、协议及设计约束分别见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/INTERFACES.md`](docs/INTERFACES.md)、ADR-016 和 ADR-017。正常 Marketplace 安装不需要下载源码并执行 `npm install`。

## 许可证

Apache-2.0。第三方来源与版权说明见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
