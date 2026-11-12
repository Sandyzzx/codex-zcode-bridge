# Codex ZCode Bridge

**将 Codex 接入官方 ZCode Agent Runtime；由 Codex 定义任务并完成最终验收，ZCode 在本机执行开发工作。**

[English](README.md) · [项目仓库](https://github.com/Sandyzzx/codex-zcode-bridge) · [版本发布](https://github.com/Sandyzzx/codex-zcode-bridge/releases)

> **发布状态。** 本分支将 Preview `2.0.0-preview.4` 提升为 Stable `v1.7.0` 版本线。`preview` 分支继续作为后续工作的集成分支。

## 这是什么

Codex ZCode Bridge 是一个任务编排插件，把 Codex 与本机官方 ZCode Agent Runtime 连接起来。它不是模型 API 转发器，也不是 CLI 命令包装器。

| 组件 | 职责 |
| --- | --- |
| **Codex** | 定义任务、处理 Host 交互、跟进进度并完成最终审查与验收。 |
| **Bridge** | 提供 MCP 工具，编排 Task 与 Attempt，使用 SQLite 持久化状态，并管理 Worker 生命周期与恢复。 |
| **ZCode AppServer** | 执行模型 Turn，负责上下文、工具、流式响应与 Provider 传输。 |
| **SQLite Authority** | 保存当前生产架构中的 Task、Result、Cleanup 与 Release 权威生命周期。 |

Codex 不会自动接管所有开发请求。只有用户明确要求使用 ZCode Bridge，或既有会话/持续目标授权覆盖当前任务时，才应发起委派。

## 模型套餐支持

| 套餐 | 可用渠道 | 认证与运行路径 |
| --- | --- | --- |
| **Z.ai Start Plan** | Stable `v1.7.0` 与 Preview | 只读发现官方已登录账户凭据，对所选模型执行实时权益检查，并通过单任务私有凭据 Lease 向官方 Runtime 交付认证。 |
| **Z.ai Coding Plan** | Stable `v1.7.0` 与 Preview | 使用既有的官方 Coding Plan 账户/API Key 路径，通过 ZCode Runtime 执行。 |

Start Plan 与 Coding Plan 是两条不同的账户和认证路径。Bridge 根据任务中的 Provider、模型和套餐选择对应路径；两者最终都通过官方 ZCode AppServer 执行。

### 已验证的 Start Plan 路径

`v1.7.0` 版本线包含一次 Windows 真实验收，实际事实如下：

- 官方 ZCode AppServer `0.17.1`。
- Provider `account:bigmodel-start-plan`。
- 模型 `GLM-5.3-Flash`。
- 主 Turn 的 3 次模型迭代均为 HTTP `200`。
- `Write` 与 `Read` 工具调用成功。
- AgentReport Schema 有效。
- Result 已提交，Worker 已退出，进程树已清理，私有 Lease 已释放。
- 每个任务观察到 1 次 Billing GET。
- 未观察到 HTTP `405`、Provider code `3012` 或 unusual activity。

该证据**只覆盖 Windows 上的 `GLM-5.3-Flash`**，不能证明所有 Start Plan 模型、所有 ZCode Runtime 版本或所有平台均可用。其他模型仍取决于官方 Provider Registry 和当前登录账户的实际权益。

## 核心能力

- **任务派发：** 通过 `zcode_task` 提交一个有明确边界、可独立验收的开发任务；Codex Master Skill 可选择整任务或分阶段交付。
- **持久化编排：** SQLite 记录 Operation、Attempt、Claim、Result、Cleanup、Release 和重启恢复状态。
- **Worker 生命周期：** Bridge 启动并观察独立 Worker，验证 ZCode 进程树；无法验证清理时保留显式 Hold。
- **进度与交互：** 使用 `zcode_status`、`zcode_feedback`、`zcode_events`、`zcode_result` 和 `zcode_interaction_reply` 跟踪任务并回复权限或用户输入请求。
- **模型选择：** 查询 Provider/Model 组合，按任务选择模型，或保存 Bridge 默认模型。
- **Provider 集成：** 将 Start Plan 或 Coding Plan 路由到官方 Runtime，不把 Bridge 变成第二套模型请求构造器。
- **独立验收：** `completed` 只表示执行结束和报告规范化完成，不表示 Codex 已接受代码。

## MCP 工具

| 范围 | 工具 |
| --- | --- |
| 安装和模型发现 | `zcode_doctor`、`zcode_model_catalog`、`zcode_default_model`、`zcode_set_default_model`、`zcode_clear_default_model` |
| 任务生命周期 | `zcode_task`、`zcode_status`、`zcode_feedback`、`zcode_events`、`zcode_result`、`zcode_continue`、`zcode_cancel` |
| 交互 | `zcode_interaction_reply` |

`zcode_continue` 只用于基于证据的返工、必要决定、受控恢复或报告修复，不作为推进正常实现下一步的常规调度工具。

## 环境要求

- **Windows** 是当前生产 SQLite 路径与真实 Start Plan 验收的已验证本地环境；Linux/macOS 目前只有合成/CI 覆盖。
- **Stable 1.7.0：** Node.js `>=24.16.0` 且 `<25`。
- Git、支持插件/Marketplace 的 Codex，以及可正常工作的本机 ZCode 安装。
- 官方 ZCode 账户已登录，并具备所选任务需要的套餐和模型权益。
- 仅面向**单用户、可信本地**环境；不提供多用户隔离或远程沙箱。

Marketplace 插件不会代替你安装 Node.js 或 ZCode。

## 安装

同一 Codex 安装只使用一个渠道。分支引用会持续更新；Tag 是固定快照。

### 稳定版

Stable `v1.7.0` 包含 SQLite-only 编排以及 Start Plan 与 Coding Plan 集成：

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.7.0
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

### 预览版

预览版继续用于 `1.7.0` 之后的集成工作。Marketplace ID：`codex-zcode-bridge-preview`。

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref preview
codex plugin add codex-zcode-bridge@codex-zcode-bridge-preview
```

更新持续跟随 `preview` 分支的 Marketplace：

```sh
codex plugin marketplace upgrade codex-zcode-bridge-preview
```

如需固定到已验收的 Preview 快照：

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-preview-v2.0.0-preview.4
```

在已有 Marketplace 上切换分支或 Tag 时，使用目标 `--ref` 重新执行 `marketplace add`，或先移除再添加。不同 Codex 版本的实际参数以 `codex plugin marketplace add --help` 为准。

安装后请开启新的 Codex 对话，使插件和 MCP 工具完成加载；检查并信任插件的 `SessionStart` Hook。安装或运行配置异常时先调用 `zcode_doctor`。

## 使用方式

1. 在 Codex 中打开项目目录。
2. 明确要求 Codex 使用 ZCode Bridge 执行当前任务。
3. 提供目标、相关文件、约束、允许范围和验收条件。
4. 由 Codex 的 Master Skill 选择整任务或分阶段策略并发起任务。
5. 使用 `zcode_status`、`zcode_feedback` 和 `zcode_events` 跟进；只有请求动作确实获得授权时才回复权限请求。
6. 独立检查实际 Diff、测试证据和 `zcode_result`，再决定是否接受。

示例：

```text
使用 ZCode Bridge 和 Start Plan GLM-5.3-Flash 执行当前任务。
修复这个仓库中失败的 parser 测试；只修改 parser 及其测试，
运行对应的定向测试，并返回有效的 AgentReport。不要提交或推送。
```

如果只是规划、代码审查或独立分析，请明确要求 Codex 不委派，并继续在当前 Host 中完成。

### Workspace 与 Worktree 边界

调用方 Host 选择项目 Workspace，并在需要时创建和准备 Git Worktree。Bridge 验证并使用传入路径，但不会创建、选择或删除 Worktree。Worktree 只是一种工作目录布局，不是操作系统安全沙箱。

## SQLite 启动与升级

新的 Preview 安装会创建并验证：

```text
${LOCALAPPDATA}\CodexZCodeBridge\state\bridge.sqlite
```

数据库必须通过完整性和生命周期检查后，MCP 才会接受请求。Bridge 不会回退到 JSON 存储。

启动时发现有效的 Schema v13 Authority 后，Bridge 会在既有跨进程 bootstrap 锁内执行受控副本升级到 v14。原数据库保留为同目录 v13 备份；只有已发布 v14 Authority 验证通过后才清除持久升级 marker，现有 Operation、Hold 与 Recovery 证据保持不变：

```powershell
node ./dist/upgrade-sqlite-v14.mjs --help
```

离线升级工具继续保留给显式运维流程。损坏或非 v13 数据库仍走既有 fail-closed 校验路径。不要手工修改生命周期表，或为了绕过升级而清除 Hold。完整合同见 [ZCODE_RUNTIME.md](docs/ZCODE_RUNTIME.md)。

## 安全边界

`v1.7.0` 版本线使用固定的单用户可信本地 `yolo` 执行档案，以当前 Windows 账户权限运行。工作区内的普通读取、编辑、构建、测试和任务范围内清理可以自动执行；Push、Merge、Tag、Release、生产 Authority 切换、任务范围外删除、凭据修改和真实生产任务数据访问仍需用户明确授权。

任务 Prompt、Skill、路径列表和 Worktree 选择不会自行产生这些权限。不要在任务 Prompt 中放入凭据、JWT、私钥或敏感账户数据。`allowed_paths` 和 `forbidden_paths` 是任务指令，不是 OS 强制沙箱。

## 当前限制

- **Start Plan 真实 E2E：** 仅 Windows；目前只有一个模型 `GLM-5.3-Flash` 的公开证据。
- **其他 Start Plan 模型：** 取决于官方 Registry 和实时账户权益，本版本未逐模型认证。
- **Linux/macOS：** 目前只有合成/CI 覆盖，没有真实 Start Plan 认证。
- **CAPTCHA 与 unusual activity：** Bridge 不解决 CAPTCHA，也不绕过账户控制；权益失败会 fail-closed，可能需要用户在官方 ZCode 客户端中处理。
- **Host Portability 与 Companion Service：** 仍属于架构研究，不是 `v1.7.0` 已交付功能。
- **JSON 存储与旧 CLI 执行链：** 不是当前生产路径；旧 JSON 任务历史不会导入 SQLite。
- **Worker 可能未提交 Result 就退出。** Bridge 会保留清理证据和 Hold，而不是假定资源已释放。

## 文档

- [当前架构](docs/ARCHITECTURE.md)
- [接口与生命周期合同](docs/INTERFACES.md)
- [Runtime 与 SQLite 升级细节](docs/ZCODE_RUNTIME.md)
- [插件安全说明](plugins/codex-zcode-bridge/SECURITY.md)
- [Master Skill](plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md)
- [`v1.7.0` Release](https://github.com/Sandyzzx/codex-zcode-bridge/releases/tag/codex-zcode-bridge-v1.7.0)

## 许可证

Apache-2.0。第三方来源与版权说明见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
