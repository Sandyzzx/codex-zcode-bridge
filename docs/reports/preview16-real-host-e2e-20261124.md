# Preview.16 真实 Host Auto Wake E2E（2026-11-24）

> Status: RESEARCH（验证证据记录）
> Date: 2026-11-24
> Candidate: `codex/preview16-async-handoff-20261124@fc9fb6758`
> 环境: Windows 11 x64、Node `24.16.0`、Codex Desktop（`codex-cli 0.171.0-alpha.13.2`）、
> 安装版插件 `codex-zcode-bridge@2.0.0-preview.16`、真实 ZCode Runtime 与真实登录账户

## 一、验收范围

使用实际安装的候选插件制品、真实 Codex Host 与真实 ZCode Runtime，完成一次最小、非空、
低成本的工程交付，验证：Host 自动传递 `_meta.threadId`、SQLite 自动持久化 Owner
Binding、receipt 返回 `console_link`、Master 结束 Turn 后由官方 Queue 恢复原 Thread，
以及 Master 在新 Turn 内用原生 MCP 回读同一 Attempt 并独立验收。

任务 Workspace：`D:\codex-zcode-bridge\.run\preview16-e2e-workspace`（派发前为空）。

## 二、身份与受理

| 事实 | 值 |
|---|---|
| Codex Thread | `01a20dfc-c2c0-77f0-9b38-5bf4caed941d` |
| Task / Attempt | `PREVIEW16-REAL-HOST-E2E-20261124` / `1` |
| Owner Binding | `bound`，`owner_thread_id=01a20dfc-c2c0-77f0-9b38-5bf4caed941d`，`binding_source=mcp_meta` |
| Binding 时间 | `2026-11-24T14:39:41.588Z`，与 Task、首个 Attempt 的 `created_at` 相同 |
| TaskPackage 身份输入 | 无（Thread ID 只来自 Host MCP 上下文） |

## 三、生命周期与 Wake

| 事件 | 时间（UTC） | 备注 |
|---|---|---|
| `reserved` | 14:39:41.639 | |
| `launch_intent` | 14:39:41.670 | |
| `claim_committed` | 14:39:43.826 | Worker 启动 |
| `result_committed` | 14:41:31.252 | `completed` |
| `cleanup_verified` | 14:41:33.996 | |
| `released` | 14:41:34.009 | |
| Wake `intent` | 14:41:34.039 | `plugin_installed_auto_wake`，release 后 30ms |
| Wake `queued` | 14:41:36.625 | `queue_command_accepted` |
| Wake `web_notify` | 14:41:36.649 | `turn_start_unverified`（控制探测未确认，未伪报 `turn_started`） |

Operation：`sqlite-6af8851a66b17ad847069a1949ad4989`，generation `1`，revision `11`。
Result digest：`903559768e80002571d72dc451d28c1b10d8625d7a14a68156e0d2ee5f98894c`。
Queue message ID：`01a20e01-492d-7381-8027-09e5e076922d`。
同一 `delivery_id` 只有一次 Intent 与一次 Queue，没有重复 Worker。

## 四、原 Thread 的新 Turn

| 事实 | 值 |
|---|---|
| 派发 Turn | `01a20dfc-c4d3-7bd1-916c-9213413341db`（14:36:39–14:39:57Z），以 WebUI 链接结束 |
| Wake 触发 Turn | `01a20e01-495a-7d43-98cc-e9febbc75966`（14:41:35–14:42:42Z） |
| turn 起始内容 | `[CODEX-ZCODE BRIDGE WAKE - VERIFIED RELEASE FACTS]`（Task/Attempt/Operation/digest 与持久事实一致） |
| Master 原生 MCP 调用 | `zcode_status`、`zcode_result(view="summary", expected_attempt=1)`、`zcode_events` |
| 最终回复位置 | 原 Codex Thread（该 Turn 的 `final_answer`） |

未出现人工 Composer Turn：Wake Turn 的第一项即 Queue 投递的 Wake 消息。

## 五、独立工程验收

- `hello.txt`：16 字节，hex `5052455649455731365F4532455F4F4B` = `PREVIEW16_E2E_OK`，无末尾换行。
- `verify.mjs`：实际读取并完整校验内容；复跑 `node verify.mjs` 退出码 `0`。
- 交付目录仅包含这两个文件。

## 六、人工干预与限制

- 一次 `executor start`：本次使用自定义 `authority.json` `data_root`，其 `state` 子目录未预建，
  Executor 自动启动失败后由 Master 用 Task CLI 启动。这不属于 Wake 补足或人工 Composer。
- 未验证：Desktop fully exited、notLoaded、严格 Wake C/D、Official Runtime provenance。
- `turn_start_unverified` 是如实的控制通道观察结果；Turn 已启动的证据来自 Codex Thread 记录本身。
