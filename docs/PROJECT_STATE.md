# Project State

> Status: AUTHORITATIVE
> Last updated: 2026-11-11
> Last verified: 2026-11-11，Preview.3 产品事实沿用 bfd3406f 的核对范围；本轮核对 ADR-032 后的隔离 POC 证据、生产未切换边界和新增阻断项，未重跑产品验收。
> Verified against: 9710303397fe2d544c75698f783a8174404b2d51（目标架构与研究报告；产品实现事实沿用既有核对）

当前有两条发布渠道：

- Stable `v1.6.0`：Tag `codex-zcode-bridge-v1.6.0`，面向普通用户，不包含 Start Plan 支持。
- Preview `2.0.0-preview.3`：`preview` 分支与 Tag `codex-zcode-bridge-preview-v2.0.0-preview.3`，用于 SQLite-only 编排、Start Plan 与 Coding Plan 集成验证。

## 当前生产架构

- 一个 SQLite Task Authority（Schema v14）、一个 Lifecycle Manager、一条 Worker→ZCode AppServer 生产链。
- 旧 JSON TaskStore/Manager/Worker、CLI Adapter 和 GitWorktreeProvider 已从 Preview 生产执行链退役；旧 JSON 文件不由 Bridge 读取、导入或删除。
- Result、Cleanup 与 Release 是独立生命周期事实。无法验证 Worker 进程树清理时必须保留显式 Hold，不能伪造 Release。
- Attention/Thin Waiter 读取同一 SQLite Authority；`zcode_doctor` 也绑定该 Authority。
- SQLite v13 必须通过离线副本升级到 v14，不在启动时原地迁移。

## 套餐与认证

- **Z.ai Start Plan：** Preview 支持。Bridge 只读发现官方凭据，执行实时模型权益检查，并通过单任务 Private Lease 向官方 Runtime 交付认证。Start Plan 与普通模型目录条目分离，使用 `<ModelId>-StartPlan` 别名。
- **Z.ai Coding Plan：** 保留既有官方 Coding Plan 账户/API Key 路径；Start Plan 预检不改变 Coding Plan 的既有注册和执行语义。
- 两条路径最终都由官方 ZCode AppServer 执行；Bridge 不复制 AppServer 的 Provider 请求构造。

Start Plan 的真实证据目前为：Windows、官方 AppServer `0.17.1`、Provider `account:bigmodel-start-plan`、模型 `GLM-5.3-Flash`、3 次主 Turn 模型迭代均 HTTP `200`、Write/Read、有效 AgentReport、Result Commit/Cleanup/Release、每任务 1 次 Billing GET，无 HTTP 405、3012 或 unusual activity。该证据不能推广到所有模型或平台。

## 明确边界

当前运行只认证受信任的单用户 Windows 本地部署。任务使用固定 `yolo` profile，以当前账户权限执行；路径声明、任务 Prompt 和 Worktree 不是 OS 安全沙箱。

Linux/macOS 的 Preview 路径目前只有合成/CI 覆盖。真实 Start Plan 模型请求、其他 Start Plan 模型、CAPTCHA 自动处理和跨平台生产认证均未由该单一模型证据证明。

[ADR-032](decisions/ADR-032-existing-worker-official-host-integration.md) 已接受下一阶段目标：现有 Worker 内装配必要官方 Host，经内部 Binding 和官方 ProcessManager 运行 AppServer。独立 Companion 服务、新 IPC/业务库、平行 RuntimeAdapter 和共享 AppServer Pool 已移出当前目标。隔离 [POC 已完成到组件门禁](research/zcode-official-host-integration-v1/IMPLEMENTATION_SUMMARY.md)：固定 3.18.0 源码构建、自包含 Host module、Windows helper、官方 ProcessManager 与 loopback Mock Read/resume/cancel/目标进程清理均有运行证据；生产 Worker 接入尚未实施。

官方制品的完整 Node/native/资源闭包、一般 Desktop Main 独立性、持久 Job/Cleanup Proof、BOM/许可/数据回滚及真实 Start Plan 独立账户能力仍未验证。固定上游的 same-profile 双 Worker 合成试验已复现 double-refresh，第二个请求返回 `409 rotation_reuse_rejected`；官方 transport 也缺少与现有 Bridge 16 MiB raw stdout frame cap 等价的上游边界。因此账户协调和 framing 兼容须先经最小设计/ADR 裁决，生产执行与清理合同不能切换。[账户与 Cleanup 两项草案](research/zcode-companion-owner-architecture-convergence-2026-11-11/ADR_PROPOSALS.md) 保持 Proposed，不替代 ADR-030 或当前生产合同。Host Portability、公共 Core fork/外部 Host 升级也未因目标冻结获得运行认证。

## 当前文档入口

产品入口与安装方法见 [README](../README.md) 和 [中文说明](../README.zh-CN.md)。运行配置和 v13→v14 升级见 [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md)；生命周期与接口见 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [INTERFACES.md](INTERFACES.md)。
