# G5：Upstream Binding 与现有 Worker 接线

> Status: RESEARCH — IMPLEMENTED IN PREVIEW.4 CANDIDATE / RELEASE NOT APPROVED
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对 `OfficialHostAdapter`、Worker factory、fixed host module exports、当前测试和完整回归
> Verified against: Bridge candidate `ba25f837` + documentation changes；upstream `b95ebaff` / 3.18.0

## 结论

Binding 没有成为单独发布的 package 或服务，而是 `OfficialHostAdapter` 与固定 `official-host-runtime.mjs` 之间的窄内部实现。现有 `CodingAgentAdapter`/`ZCodeAppServerAdapter` 外部语义不变，Worker 的 SQLite/Capacity/Claim/Result 生命周期也不变。

## 内部组件

| 组件 | 职责 |
|---|---|
| `OfficialHostAdapter` | 扩展已有 AppServer Adapter；固定资产、Host factory 与可选 test seam |
| fixed host module | 导出官方 ProcessManager、ProtocolClient、StdioTransport 和 OAuth runtime auth factory |
| official ProcessManager | 正常 Runtime/helper/AppServer 启动、请求、重开与关闭 |
| Adapter bridge | 映射通知、reverse request、close、runtime identity 到现有 Adapter handle |
| Worker | 保留 bootstrap、Claim、private auth、interaction 与 Result pipe |

没有新增公开 Adapter Mode、MCP 参数、持久配置或 Companion。生产 `zcode_app_server` 固定使用 `OfficialHostAdapter`。

## Adapter 映射

| 现有行为 | 官方映射 |
|---|---|
| start / continue | session create 或 strict exact-session resume；subscribe before send |
| getStatus / turn wait | official notifications/terminal result；unknown 或 foreign result fail closed |
| getResult | terminal outcome + usage/model/reasoning/structured report |
| cancel | official cancel/close，不重发 session/send |
| interaction | session-scoped permission、user input、preferences 和 browser reverse RPC |
| private auth | 只把凭据注入匹配的 runtime header request/turn |
| cleanup | official close + Bridge exact identity/recorded-tree/resource proof |

## 固定传输与资产

Adapter 从 Worker bundle 自身位置解析 Windows x64 固定目录，并验证 BOM/shipped files。AppServer entrypoint 必须与固定制品一致。启动参数仍由现有 `buildZCodeAppServerLaunch()` 产生；官方 Host 不接受外部 env 重定向 Host module 或 AppServer。

`ZCodeAgentProcessManager` 收到 `maxFrameBytes = 16 * 1024 * 1024`。Fixed upstream transport 对 raw UTF-8 bytes、chunk、CR/LF、partial EOF 和 pending RPC overflow fail closed。

## Close 与 Release

Adapter 返回 official close diagnostic、runtime root identity、recorded-tree evidence 和 optional close error。它不直接写 Release。Worker/lifecycle 把这些事实与 exact Worker identity、resource facts 和 Cleanup Digest 组合，再走 SQLite CAS。`close()` resolved 绝不是 Release 授权。

## 并发

现有 SQLite Admission/Capacity 继续控制任务与重叠 Workspace。每个 Worker 的执行 AppServer 不与无关 Task 共享。账户 refresh 只在 profile-scoped refresh transaction 上串行，不把整个 Worker 或 Task 串行化。真实账户并发仍为 `NOT_RUN`。

## test-only rollback seam

post-HEAD WIP 允许既有测试直接构造 AppServer Adapter，用于回退 smoke。该 seam 不进入公共 MCP schema、持久 Adapter Mode 或默认选择。生产默认仍是官方 Host。

## 验证与缺口

current official-host/plugin/platform suite 32/32、focused contract 64/64、direct rollback smoke 1/1、frame 7/7、account 12/12 通过；最终完整隔离回归为 936 项、935 pass、0 fail、1 skip，stress 3/3，提交后 clean checkout 的 build/Host/native 加载和当前候选独立审查也通过。真实账户/模型、不同机器与空缓存的完整 native/resource 闭包、官方制品升级/回滚仍为 `NOT_RUN`/`PARTIAL`。

## 不接受的方案

不新增 Companion、平行 RuntimeAdapter、第二套 Task 数据库/Recovery、共享 AppServer Pool，也不靠截断或伪造 Cleanup 降级旧合同。
