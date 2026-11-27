# Project State

> Status: AUTHORITATIVE
> Last updated: 2026-11-27（Stable 2.0.0 结项清理）
> Last verified: 2026-11-27，核对 Stable Release、Release Gate、master push CI、发布资产和已登记的运行时验收；未执行新的真实模型任务。
> Verified against: `dfee062e7c30261763f642106d9ae18b48ce1ae0`（`codex-zcode-bridge-v2.0.0`）

## 发布身份

- Stable：`2.0.0`
- Tag：`codex-zcode-bridge-v2.0.0`
- Release：[Codex ZCode Bridge 2.0.0](https://github.com/Sandyzzx/codex-zcode-bridge/releases/tag/codex-zcode-bridge-v2.0.0)
- Stable 发布提交：`dfee062e7c30261763f642106d9ae18b48ce1ae0`
- 发布资产：`codex-zcode-bridge-v2.0.0.zip`，`4,673,651` bytes，SHA-256 `af250400048d7ef141cd794c0b8cc1483d89530b40b74539080b648d475a6906`
- 支持构建基线：Windows x64、Node.js `24.16.0`；ZCode Desktop 已安装版本的验证范围见下方限制。

## 当前产品合同

Stable 2.0.0 是独立 Executor + Thin MCP + SQLite v14 Authority 的正式发布。任务受理、SQLite 生命周期、Worker spawn、官方 Runtime 与恢复由同一个 Executor 持有；MCP、CLI 和 Web Console 只通过 Executor Control 读写同一 Authority。Host 断开、Turn 结束或 CLI/Web 关闭不得被写成 Task 取消、Cleanup 完成或 Master Accepted。

运行时执行使用安装版官方 ZCode AppServer 和官方运行期 Registry；固定 Official Host 模块提供认证与进程管理。Coding Plan 与 Start Plan 的技术适配、动态模型发现、任务 Continue / Session Resume 分离、Owner Binding、安装即生效的 Auto Wake、单页 Task Workspace、结构化 Diagnostics、有界脱敏 RPC 错误和 Master 验收驱动返工均属于当前合同。

SQLite v14 是唯一生产 Schema。旧 JSON Authority、SQLite v13 和旧升级 Marker 只做非破坏性拒绝；不提供自动升级、离线复制或回滚。TaskPackage 的路径列表、Worktree 和 `yolo` 都是执行指令，不是 OS 沙箱。

## 已验证范围

| 项目 | 结果 | 范围 |
|---|---|---|
| Stable Release Gate | `PASS` | [run 45958023915](https://github.com/Sandyzzx/codex-zcode-bridge/actions/runs/45958023915)，Ubuntu/Windows Verify、SQLite 资源矩阵、Cost Lab、生成物、插件校验与 diff check |
| master push CI | `PASS` | [run 45959124456](https://github.com/Sandyzzx/codex-zcode-bridge/actions/runs/45959124456)，最终 attempt 2；首次 Ubuntu attempt 有一次已知测试辅助进程抖动，未修改测试或断言 |
| 本地完整门禁 | `PASS` | `1,199` tests / `1,197` pass / `2` existing platform skips / `0` fail；typecheck、build、plugin validation、generated freshness、`git diff --check` 通过 |
| Stable 发布资产 | `PASS` | ZIP/SHA 回下载一致；56 个文件 entry 与 Tag blob 字节一致；隔离 stdio smoke 返回 `2.0.0` 和 13 个 MCP tools |
| Marketplace 安装 | `PASS` | 隔离 `CODEX_HOME` 下完成真实安装、启用与 stdio smoke；默认 Windows Git 长路径限制见下 |
| 2.0 运行时基线真实模型任务 | `PASS` | Stable 打包前在 Windows 上完成 Coding Plan / `GLM-5.4` / `low`，一次 Task/Attempt，真实 Turn、Result、Cleanup/Release 与 Auto Wake；Stable 继承同一运行时代码，未在 Stable Tag 后重新执行；Billing 未由 Runtime 提供 |
| 模型设置回读 | `PASS` | `GLM-5.4` / `max` 设置与 `session/read` 回读通过，未发送模型请求 |

## 已知限制与未验证范围

- 真实 Start Plan 权益、真实 Continue E2E、Desktop 完全退出后的恢复、`notLoaded` Host Wake、Windows 重启恢复、真实 RPC 失败注入、真实后续 Registry 更新事件和真实 Host SessionStart Hook 均为 `NOT_RUN`。
- Desktop visible state 为 `UNKNOWN`；不能把进程可见、Queue ACK、Turn Started 或 Worker 自报写成 Master Accepted。
- 真实 CAD2BIM RM12-P1 工程验收未完成：相关 Attempt 在模型执行前失败，后续 Attempt 未派发，因此该验收为 `NOT_RUN`；不能宣称 Stable 已通过该真实工程。
- 其他安全安装可按当前安装安全合同尝试，但兼容性不保证；ZCode Desktop `3.18.0` / `3.18.1` 实机组合为 `NOT_VERIFIED`，不是已证明不兼容。
- Marketplace 在默认 Windows Git `core.longpaths=false` 下可能失败；需要启用进程级长路径或使用较短的 `CODEX_HOME`。这不改变 ZIP、Tag 字节和 stdio 结果。
- Provider 总体性能、真实 OAuth refresh/账户轮换、跨机器制品复现和完整动态资源许可审查仍为 `UNKNOWN` / `NOT_RUN`。依赖中的既有安全 advisory 不由本次文档清理修复。
- Start Plan 技术适配不等于当前账户权益已通过；不得把优惠、折扣或 Plan 可用性推断为已验证。
- 代码审阅发现但未纳入 2.0.0 发布门禁的三个故障边界仍为 `UNVERIFIED`：Executor Lease 在创建文件与完整写入之间崩溃可能留下无法由现有 CLI 清除的 malformed lease；Worker stderr 诊断缓冲在无换行超大输出上可能超过 64 KiB；`recordLateWakeCompensation` 目前只有 Store 与测试调用方。上述问题未在本次结项中修复，也未重新执行故障注入。

## 数据与边界

生产 Authority 位于 `%LOCALAPPDATA%\CodexZCodeBridge\state\bridge.sqlite`（或显式配置的本地 state 目录）。本仓库的 `.tasks`、`.run` 和构建目录不是生产 Authority；生产数据库、活动 Lease、认证/配置、ZCode/Codex 自身数据和安装版插件不得由仓库清理脚本触碰。

Bridge 以当前 OS 账户权限运行。路径声明、Worktree、Task prompt、审批输入和浏览器 profile 都不是 OS 安全沙箱；未知或存活资源必须 fail closed。

## 文档入口

运行配置见 [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md)；生命周期与安全边界见 [ARCHITECTURE.md](ARCHITECTURE.md)；公开字段和错误语义见 [INTERFACES.md](INTERFACES.md)；Console 见 [WEB_CONSOLE.md](WEB_CONSOLE.md)；测试门禁见 [testing/README.md](testing/README.md)。
