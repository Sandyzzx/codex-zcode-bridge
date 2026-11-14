# Project State

> Status: AUTHORITATIVE
> Last updated: 2026-11-14
> Last verified: 2026-11-14，核对 `origin/preview` 的 Preview.5 源码、ADR-037 当前本地候选实现、ZCode 3.18.2 只读认证、Official Host 版本上下文修复、有序 patch replay、BOM 与合成回归；3.18.x 安装矩阵、Desktop/Bridge A/B 和真实 Start Plan E2E 未验收。
> Verified against: `9bec5a27d` + `2d83aeef` ADR-037 acceptance documentation + `843066ec` Host context repair candidate

当前发布状态：

- Stable `v1.7.1`：Tag `codex-zcode-bridge-v1.7.1`。
- Preview `2.0.0-preview.5`：Tag `codex-zcode-bridge-preview-v2.0.0-preview.5`；追加 Official Host、R7 Runtime Events/Usage、v14 兼容迁移与 Administrative Recovery 修复。

## 当前生产架构

- 一个 SQLite Task Authority（Schema v14）、一个 Lifecycle Manager、一条 Worker → 官方 Host 生产链。
- Windows x64 生产 Worker 默认使用 `OfficialHostAdapter`。已发布 Preview.5 固定 ZCode 3.18.0；当前本地 ADR-037 候选固定 ZCode 3.18.2，并增加只读 Start Plan 认证投影。固定官方 Host module 调用 `ZCodeAgentProcessManager`，后者启动 Windows helper 与 AppServer；Bridge 不复制 AgentRuntime、Prompt、Tools 或 Provider。Linux/macOS direct Adapter 只保留 CI/合成覆盖，其他平台 fail closed（ADR-035）。
- 旧 JSON TaskStore/Manager/Worker、CLI Adapter 和 GitWorktreeProvider 已从 Preview 生产执行链退役；旧 JSON 文件不由 Bridge 读取、导入或删除。
- Result、进程退出、Cleanup 与 Release 是不同事实。官方 close resolved 不能单独授权 Release；exact Worker identity、recorded-tree scan、resource facts、Cleanup Digest 和现有 CAS 仍然必需。
- Attention/Thin Waiter 读取同一 SQLite Authority；`zcode_doctor` 也绑定该 Authority。
- 生产 Lifecycle Gate 在 bootstrap lock 内自动升级已有 v13 Authority 到 v14。离线副本升级工具继续保留；直接 Store 打开 v13 仍要求显式离线升级。
- R7 在同一 v14 Authority 内增加 `runtime_task_events`。Worker 只通过一次性 fd14 提交 Runtime observation；Manager 从持久 Task/Attempt/Generation/Claim 派生绑定，SQLite 负责 sequence 幂等、stale-Attempt 拒绝和统一 public cursor。`zcode_events`、`zcode_feedback` 与 Result 共用这些事实，但 Lifecycle Event 与 Runtime Event 仍分开。

已发布 Preview.5 固定官方输入为 ZCode `3.18.0`、commit `b95ebaffeab641907b38652f45c1502bd762972d`、tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`。当前本地候选固定 ZCode `3.18.2`、commit `fec975905a2abd4c07e35c40d51fa097a2258ec9`、tree `5e90fec80706b8381f94e4eef48cf821b9868916` 和 AppServer `0.17.1`。候选制品只在 Windows x64、Node `24.16.0` 上完成构建与加载验证；其他 Node 24 patch level 仍是 `NOT_VERIFIED`。

## 套餐与认证

- **Z.ai Start Plan：** 已发布 Preview.5 使用 Bridge 的旧只读凭据发现；当前本地候选改为消费固定 Official Host 的窄认证投影，再执行实时模型权益检查，并通过单任务 Private Lease 向官方 Runtime 交付认证。Start Plan 与普通模型目录条目分离，使用 `<ModelId>-StartPlan` 别名。
- **Z.ai Coding Plan：** 保留官方 Coding Plan 账户/API Key 路径；Start Plan 预检不改变 Coding Plan 的既有注册和执行语义。
- 两条路径最终都由官方 ZCode AppServer 执行；Bridge 不复制 AppServer 的 Provider 请求构造。
- 账户 refresh 使用固定上游 patch 的 profile-scoped lock、lock-time reread、一次远端刷新和 CAS 发布。该协调已由合成竞争矩阵验证，但没有执行真实 OAuth、账户轮换、Start Plan 或 Billing 请求。
- [ADR-037](decisions/ADR-037-official-zcode-authentication-reuse.md) 已接受且当前本地候选已实现：官方 Host 统一拥有凭据解密、keyring、OAuth、账户身份和请求认证，Bridge 只消费当前任务所需的认证投影。生产源码不再包含旧的 v1/v2 AES、Keyring、账户资料、JWT payload 或 telemetry device 解析。该实现尚未发布，3.18.x Desktop 安装矩阵和真实 Start Plan/Billing E2E 仍未完成。

Preview.3 的 Start Plan 历史证据覆盖 Windows、官方 AppServer `0.17.1`、Provider `account:bigmodel-start-plan`、模型 `GLM-5.3-Flash`：3 次主 Turn 模型迭代均 HTTP `200`，Write/Read、有效 AgentReport、Result Commit/Cleanup/Release 和每任务 1 次 Billing GET 均被记录。一个此前 R7 候选另通过了真实 Coding Plan Task，证明 Official Host、Runtime Events/Usage、工具调用、Result、Cleanup 与 Release。两者不能替代安装 Preview.5 后的 Start Plan E2E。

## 验证状态

| 能力 | 状态 | 当前证据边界 |
|---|---|---|
| 固定源码/制品构建 | `PASS — CANDIDATE` | ZCode 3.18.2、Windows x64、Node 24.16.0；有序 patch 可重放到实际源码树，构建输出与 BOM 哈希一致 |
| same-source-tree 制品重建 | `PASS` | byte-identical host module；不等于 clean-install 全链路可复现 |
| 16 MiB raw frame | `PASS` | 固定上游 7/7 合成测试，覆盖 exact/+1、partial、UTF-8 与 pending RPC |
| 账户 OAuth/Start auth 合成测试 | `PASS — CANDIDATE` | 固定上游认证套件 19/19；真实账户与网络轮换 `NOT_RUN` |
| `OfficialHostAdapter` 定向行为 | `PASS — CANDIDATE` | 固定 Host、Adapter、R7、Cleanup/Release 定向套件通过；完整结果见本次候选实现报告 |
| R7 Runtime Events/Usage | `PASS` | fd14 单向通道、v14 additive schema、sequence/cursor、stale Attempt、Feedback/Result 合成与旧 v14 兼容测试通过 |
| SQLite 自动 v13→v14 升级与恢复 | `PASS` | 测试范围；含 occupied Attempt/Hold、rename/publication 中断 |
| 完整 Node/native/resource 闭包 | `PARTIAL` | 6 个 keyring 文件已在 clean checkout 解析、native load 并与 BOM bytes/hash 一致；完整动态资源闭包仍未认证 |
| 正常 cleanup 的 native/resource 闭包 | `PARTIAL` | exact identity、tree scan 与 CAS 有定向证据；一般外部资源和 crash 矩阵未完成 |
| 再分发/许可审查 | `PARTIAL` | 文件与 NOTICE 已纳入 BOM，逐项发布许可结论未完成 |
| Official Host 制品升级/回滚演练 | `NOT_RUN` | 与 SQLite v13→v14 测试不是同一项 |
| 真实 Coding Plan + Official Host | `PASS` | 此前 R7 候选完成一次真实 Task：模型、工具、Events、Usage、Result、Cleanup、Release 均通过；不替代 Preview.5 安装后验收 |
| 真实 Start Plan + Billing（Preview.5） | `NOT_RUN` | Preview.5 发布后单独授权、安装后执行；不得用 Preview.3 或 Coding Plan 替代 |
| 官方 Start Plan 认证复用 | `IMPLEMENTED — CANDIDATE` | v1、v2:env、v2:os 只读字节不变，BigModel/linked Z.AI/`zai_cn`、冷进程、Billing 单 verdict 与 Lease 合成测试通过；未发布、无真实 E2E |
| Desktop 3.18.0 / 3.18.1 / 3.18.2 兼容矩阵 | `NOT_VERIFIED` | 本机仅观察到 Desktop `3.18.2.10443`；3.18.0/3.18.1 未安装，源码观察不能替代隔离运行与真实账户组合 |
| 一般 Desktop Main 独立性 | `NOT_RUN` | 合成路径不证明完整资源与身份闭包 |
| 当前认证候选回归 | `PASS — CANDIDATE` | `test:affected` 选择 `FULL_SUITE`：972 项，970 pass、0 fail、2 skip；只覆盖 Windows x64、Node 24.16.0 |
| Official Host 启动版本上下文 | `PASS — CANDIDATE` | 有效 Desktop metadata 优先；独立 Host 使用校验后的 `3.18.2` 产品版本且不伪造 Build ID；模型请求仍使用 `--surface desktop`；Desktop/Bridge A/B 未运行 |
| 当前认证候选 CI | `NOT_RUN` | 本地候选未 Push；不得沿用 Preview.5 的 CI 结果 |

## 明确边界

当前运行仍按受信任的单用户 Windows 本地部署设计。任务使用固定 `yolo` profile，以当前账户权限执行；路径声明、任务 Prompt 和 Worktree 不是 OS 安全沙箱。

安装 Preview.5 后的真实 Start Plan 模型请求仍在发布后独立验收；其他 Start Plan 模型、CAPTCHA 自动处理、unusual-activity 处理和跨平台生产认证没有被该单一证据证明。Linux/macOS 仅有其他 Bridge 路径的合成或 CI 历史覆盖；固定官方 Host 制品在非 Windows x64 上 fail closed。

固定制品构建成功、same-source-tree repeatability 与 loopback Mock 通过不能升级为产品性能或完整运行等价。性能比较只有 3 个顺序样本，路径语义不同，产品总体性能为 `UNKNOWN`。`@napi-rs/keyring` 的 6 个文件已通过 clean-checkout 打包闭包验证；完整动态资源与逐项再分发许可审查仍不能据此标为 `PASS`。

`npm audit --omit=dev` 仍报告 `@modelcontextprotocol/server@2.1.0` 与 `zod@4.6.5` 的既有 high advisories。依赖树与 `origin/preview` 相同，本候选没有引入或修复这些 advisory；它们必须由独立的安全发布流程处理。

## 当前文档入口

产品入口与安装方法见 [README](../README.md) 和 [中文说明](../README.zh-CN.md)。运行配置见 [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md)；生命周期、认证所有权与接口见 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [INTERFACES.md](INTERFACES.md)。`research/zcode-official-host-integration-v1/` 的 Implementation Summary 与 Final Acceptance 只记录 Preview.4 的 3.18.0 历史证据；该固定输入后来继承到 Preview.5，但两份报告不能作为当前 3.18.2 认证候选的验收入口。
