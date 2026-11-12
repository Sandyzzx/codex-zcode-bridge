# Project State

> Status: AUTHORITATIVE
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对了同步最新 `origin/preview` 后的 Preview.4 源码候选、固定官方 Host 制品、自动 SQLite v13→v14 升级、936 项完整隔离回归和 stress gate；真实账户、产品性能与官方制品升级/回滚演练未运行。
> Verified against: `8e8966d5ec7539a2d8575fc748871a9641fe0a2d`（tree `4e9b0a005e4802cb4247582dbf1b7369498cb966`）+ documentation changes

当前有已发布基线和源码候选两种状态：

- Stable `v1.6.0`：Tag `codex-zcode-bridge-v1.6.0`，面向普通用户，不包含 Start Plan 支持。
- Preview `2.0.0-preview.3`：已发布预览基线，Tag `codex-zcode-bridge-preview-v2.0.0-preview.3`。
- Preview `2.0.0-preview.4`：当前源码候选。`package.json`、`package-lock.json`、插件 manifest 和 MCP server version 已更新，但没有发布 Tag。本文件不把候选称为已发布版本。

## 当前候选生产架构

- 一个 SQLite Task Authority（Schema v14）、一个 Lifecycle Manager、一条 Worker → 官方 Host 生产链。
- Windows x64 生产 Worker 默认使用 `OfficialHostAdapter`。固定官方 Host module 调用 `ZCodeAgentProcessManager`，后者启动 Windows helper 与 AppServer；Bridge 不复制 AgentRuntime、Prompt、Tools 或 Provider。Linux/macOS direct Adapter 只保留 CI/合成覆盖，其他平台 fail closed（ADR-035）。
- 旧 JSON TaskStore/Manager/Worker、CLI Adapter 和 GitWorktreeProvider 已从 Preview 生产执行链退役；旧 JSON 文件不由 Bridge 读取、导入或删除。
- Result、进程退出、Cleanup 与 Release 是不同事实。官方 close resolved 不能单独授权 Release；exact Worker identity、recorded-tree scan、resource facts、Cleanup Digest 和现有 CAS 仍然必需。
- Attention/Thin Waiter 读取同一 SQLite Authority；`zcode_doctor` 也绑定该 Authority。
- 生产 Lifecycle Gate 在 bootstrap lock 内自动升级已有 v13 Authority 到 v14。离线副本升级工具继续保留；直接 Store 打开 v13 仍要求显式离线升级。

固定官方输入为 ZCode `3.18.0`、commit `b95ebaffeab641907b38652f45c1502bd762972d`、tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d` 和 AppServer `0.17.1`。当前随包制品只提供 Windows x64、Node `24.16.0` 组合。

## 套餐与认证

- **Z.ai Start Plan：** Preview 支持。Bridge 只读发现官方凭据，执行实时模型权益检查，并通过单任务 Private Lease 向官方 Runtime 交付认证。Start Plan 与普通模型目录条目分离，使用 `<ModelId>-StartPlan` 别名。
- **Z.ai Coding Plan：** 保留官方 Coding Plan 账户/API Key 路径；Start Plan 预检不改变 Coding Plan 的既有注册和执行语义。
- 两条路径最终都由官方 ZCode AppServer 执行；Bridge 不复制 AppServer 的 Provider 请求构造。
- 账户 refresh 使用固定上游 patch 的 profile-scoped lock、lock-time reread、一次远端刷新和 CAS 发布。该协调已由合成竞争矩阵验证，但没有执行真实 OAuth、账户轮换、Start Plan 或 Billing 请求。

Preview.3 的历史真实证据仍只覆盖 Windows、官方 AppServer `0.17.1`、Provider `account:bigmodel-start-plan`、模型 `GLM-5.3-Flash`：3 次主 Turn 模型迭代均 HTTP `200`，Write/Read、有效 AgentReport、Result Commit/Cleanup/Release 和每任务 1 次 Billing GET 均被记录。它属于既有安装版路径，不是 Preview.4 固定官方制品或真实账户 E2E 证据。

## 验证状态

| 能力 | 状态 | 当前证据边界 |
|---|---|---|
| 固定源码/制品构建 | `PASS` | Windows x64、Node 24.16.0；两次构建输出与 BOM 哈希一致 |
| same-source-tree 制品重建 | `PASS` | byte-identical host module；不等于 clean-install 全链路可复现 |
| 16 MiB raw frame | `PASS` | 固定上游 7/7 合成测试，覆盖 exact/+1、partial、UTF-8 与 pending RPC |
| 账户 refresh coordination | `PASS` | 固定上游 12/12 合成测试；真实账户与网络轮换 `NOT_RUN` |
| `OfficialHostAdapter` 定向行为 | `PASS` | 当前 official-host/plugin/platform 套件 32/32；focused contract 复跑 64/64 |
| SQLite 自动 v13→v14 升级与恢复 | `PASS` | 测试范围；含 occupied Attempt/Hold、rename/publication 中断 |
| 完整 Node/native/resource 闭包 | `PARTIAL` | 6 个 keyring 文件已纳入候选，工作树 bytes/hash 与 BOM 一致；提交后的 clean-checkout 验证仍待执行，完整资源闭包仍未认证 |
| 正常 cleanup 的 native/resource 闭包 | `PARTIAL` | exact identity、tree scan 与 CAS 有定向证据；一般外部资源和 crash 矩阵未完成 |
| 再分发/许可审查 | `PARTIAL` | 文件与 NOTICE 已纳入 BOM，逐项发布许可结论未完成 |
| Official Host 制品升级/回滚演练 | `NOT_RUN` | 与 SQLite v13→v14 测试不是同一项 |
| 真实 OAuth/account/model/Start Plan/Billing | `NOT_RUN` | 本候选未执行真实服务请求 |
| 一般 Desktop Main 独立性 | `NOT_RUN` | 合成路径不证明完整资源与身份闭包 |
| 当前候选完整回归 | `PASS` | 最终 `test:affected` 选择 `FULL_SUITE`：936 项，935 pass、0 fail、1 skip；stress 3/3 |
| 当前候选独立 Astra review | `NOT_RUN` | 旧 ASTRA_REVIEW 仅作历史材料 |

## 明确边界

当前运行仍按受信任的单用户 Windows 本地部署设计。任务使用固定 `yolo` profile，以当前账户权限执行；路径声明、任务 Prompt 和 Worktree 不是 OS 安全沙箱。

真实 Start Plan 模型请求、其他 Start Plan 模型、CAPTCHA 自动处理、unusual-activity 处理和跨平台生产认证没有被 Preview.4 候选验证。Linux/macOS 仅有其他 Bridge 路径的合成或 CI 历史覆盖；固定官方 Host 制品在非 Windows x64 上 fail closed。

固定制品构建成功、same-source-tree repeatability 与 loopback Mock 通过不能升级为产品性能或完整运行等价。性能比较只有 3 个顺序样本，路径语义不同，产品总体性能为 `UNKNOWN`。`@napi-rs/keyring` 的 6 个文件已纳入候选提交；在 clean-checkout 验证结果出现前，仍不能把 native/resource/license closure 标为 `PASS`。

## 当前文档入口

产品入口与安装方法见 [README](../README.md) 和 [中文说明](../README.zh-CN.md)。运行配置见 [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md)；生命周期与接口见 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [INTERFACES.md](INTERFACES.md)。官方 Host 的当前证据、覆盖和剩余缺口见 [Implementation Summary](research/zcode-official-host-integration-v1/IMPLEMENTATION_SUMMARY.md) 与 [Final Acceptance Report](research/zcode-official-host-integration-v1/FINAL_ACCEPTANCE_REPORT.md)。
