# ADR-035：Worker 平台适配器选择与 Official Host 生产启用

> Status: DECISION
> Decision: Accepted — Owner 的 Official Host Integration v1 恢复授权批准在本候选启用现有 Worker 生产接线，并冻结平台支持边界。
> Last updated: 2026-11-12
> Applicability: 适用于 Preview.5 的 `zcode_app_server` Worker 装配。不得改写 ADR-030、ADR-032、ADR-033 或 ADR-034 的既有决定。
> Verified against: `ba25f83722094ef3428a04202749377cc9b6e643`（tree `b4573bb6f1143ce6a3081a56ce2fbf968a243e35`）；后续仅有文档证据刷新

## 背景

ADR-032 已接受以下拓扑：

```text
Bridge Host/Core
  -> Existing Worker
  -> CodingAgentAdapter
  -> Upstream Binding
  -> Official Agent Service / ProcessManager
  -> Official AppServer
  -> AgentRuntime
```

ADR-032 记录的是目标架构，不自动授权切换生产入口。固定制品又只包含
Windows x64、Node `24.16.x`、ZCode `3.18.0` 与 AppServer `0.17.1`
的配套文件。因此必须把生产启用和平台边界另记为本 ADR，而不能让平台分支成为
未记录的实现细节。

## 决定

1. 在 `win32/x64` 上，现有 Worker 的 `zcode_app_server` 生产路径启用
   `OfficialHostAdapter` 和包内固定官方 ProcessManager。该启用不改变 ADR-030
   的每任务权威 entitlement verdict、Private Lease/HANDLE/ACK，也不改变现有
   Claim、Result、Cleanup、Hold、Recovery 与 Release CAS。
2. 在 `linux/x64`、`linux/arm64`、`darwin/x64` 和 `darwin/arm64` 上，保留
   `ZCodeAppServerAdapter` 作为 CI 与合成测试覆盖路径。它不是 Preview.5
   已认证的 ZCode、OAuth、Start Plan 或模型生产支持面。
3. `win32/arm64`、`win32/ia32`、其他 OS/架构组合在 Adapter 构造前以稳定错误
   fail closed。不得自动回退到 direct Adapter。
4. 选择只读取编译运行时的 `process.platform` 与 `process.arch`。环境变量、
   TaskPackage、持久配置、MCP 参数和测试参数都不能改变正式 Worker 的选择。
5. 测试专用的 direct Adapter 与 loopback Official Host 模块只可由测试自有的
   Worker 入口在进程内注入。生产 Worker bundle 不包含 loopback fixture，
   也不解析隐藏 Adapter-mode 参数。
6. 一个 Worker 仍只管理自己的执行 AppServer，不共享无关 Task。现有 Worker
   Admission/Capacity 和并发合同保持不变。

## 平台矩阵

| Platform | Architecture | Adapter | 证据边界 |
|---|---|---|---|
| Windows | x64 | `OfficialHostAdapter` | Preview.5 生产路径；仅 Windows x64 固定制品 |
| Linux | x64, arm64 | `ZCodeAppServerAdapter` | CI/合成覆盖，未认证真实 ZCode 服务 |
| macOS | x64, arm64 | `ZCodeAppServerAdapter` | CI/合成覆盖，未认证真实 ZCode 服务 |
| Windows | arm64, ia32 | fail closed | 无匹配 fixed helper/native closure |
| 其他 | 任意 | fail closed | 未建立支持范围 |

## 正式排除

- 不新增 Companion 进程、Companion IPC 或第二个业务数据库。
- 不新增平行 RuntimeAdapter、Shared AppServer Pool 或第二套任务状态机。
- 不把 legacy direct Adapter 当作 Windows Official Host 失败后的自动回退。
- 不根据环境、TaskPackage 或持久配置改变 Adapter 类型。
- 不从本决定推导真实账户、真实模型、Start Plan 或 Billing 已验证。

## 后果

Windows x64 是唯一的 Official Host 固定制品生产面。非 Windows 保留已有
direct Adapter 的合成与 CI 回归价值，但产品文档必须明确这一边界。发行制品、
BOM、Node ABI 和许可审查若扩展到其他平台，必须另立 ADR，不能仅改 selector。

测试注入从生产 argv seam 移到测试自有 Worker wrapper，消除了 MCP、持久配置和
生产 bundle 中的可触发测试模式。Official Host loopback 仍走真实 Worker 私有
管道、Manager Claim、SQLite Result、独立 Cleanup 扫描和 Release CAS；它不证明
真实 Windows helper、native keyring、OAuth 或模型服务。

## 验证要求

- selector 的完整平台矩阵和“不读取环境变量”测试必须通过。
- Worker 默认路径必须有 `win32/x64` 的 Official Host loopback E2E，覆盖 Claim、
  Result、Cleanup 与 Release。
- direct Adapter 回归必须通过测试自有 Worker wrapper，生产 Worker 不得再次暴露
  持久或序列化的 Adapter-mode 选择。
- 完整回归、干净检出 BOM 加载与当前候选独立审查已经通过；本 ADR 已满足源码
  PR-ready 候选的验证要求，仍不能表示为已发布或真实服务 E2E 事实。
