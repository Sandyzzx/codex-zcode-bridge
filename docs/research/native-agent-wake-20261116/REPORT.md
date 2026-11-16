# Native Agent Wake
真实 Windows Host E2E

> Status: RESEARCH
> Last updated: 2026-11-16
> Last verified: 2026-11-16, 真实验 Windows Codex CLI/Desktop、原生 `spawn_agent`、原生 Agent Message 和独立实验 Thread
> Verified against: `295727320cab86b071c23ddddd6e29306fa29e7f`

## 结论摘要

本轮确实执行了真实 Windows Host E2E。没有用 mock、外部 `codex queue`、人工补发消息或 Child 完成事件本身冒充 Parent 唤醒。

| 判定 | 结果 | 证据等级与边界 |
|---|---|---|
| `FEATURE_AVAILABLE` | **TRUE** | `OBSERVED`：本机 CLI 识别 `wake_on_agent_messages`，默认关闭，`--enable` 后进程内为 `true`。 |
| `NATIVE_WAKE_CLI` | **TRUE / PASS** | `OBSERVED`：Feature OFF 对照无唤醒；Feature ON 时 Parent Final 后由 Child 原生 Agent Message 自动启动新 Parent Turn 并消费 ACK。 |
| `NATIVE_WAKE_DESKTOP` | **FALSE（默认配置）/ NOT_CONFIRMED（启用态）** | `OBSERVED`：默认 Desktop 未唤醒；启用验证若改全局配置则触发 `DESKTOP_CONFIG_BLOCKED`。 |
| `NATIVE_WAKE_GOAL` | **FALSE（默认配置）/ NOT_CONFIRMED（启用态）** | `OBSERVED`：已完成的真实 Desktop Goal 默认配置下未唤醒；启用态同样受全局配置隔离限制，未强行测试。 |
| `CHILD_SURVIVES_PARENT_FINAL` | **TRUE** | `OBSERVED`：原生 Child 在 Parent Turn 结束后的 30 秒和 120 秒等待中继续运行并最终返回。 |
| `LONG_IDLE_WAKE` | **TRUE at ~123 seconds** | `OBSERVED`：Parent 空闲约 `122.8 s` 后由 Child 原生消息自动唤醒；未测试 1 小时或 4 小时。 |
| `EXTERNAL_BRIDGE_COMPATIBLE` | **FALSE / NO PUBLIC INGRESS** | `DOCUMENTED + INFERRED`：公开 AppServer API 没有 Agent Mailbox 注入入口；原生 message board 绑定 Codex 原生 thread tree。 |

`Thin Waiter --notify-codex` 的建议仍是 **NO-GO**。它无法生成原生 Agent Message；若改用普通 CLI queue，则会把通知作为 `role=user` 注入，不能等同于本报告的 Native Agent Wake。

本轮推荐 **C. Native Subagent + `wake_on_agent_messages`** 作为 Whole Task 的长期候选，但前提是 ZCode Worker 被包装为 Codex Native Subagent。该方案不是当前可直接采用的零成本适配器：它会增加 Native Child 模型调用、Token 使用和 Agent 并发槽占用。本轮不实施改造。

## 范围与隔离

- 项目根目录：`D:\codex-zcode-bridge`
- 探针 worktree：`D:\codex-zcode-bridge\.run\native-agent-wake-20261116`
- 分支：`codex/native-agent-wake-20261116`
- 基线 commit：`295727320cab86b071c23ddddd6e29306fa29e7f` 对应的本地 `master`
- Master 原有状态保持：`M AGENTS.md`、`?? $null`
- 未修改 Bridge 生产代码、SQLite Authority、现有 Worker、MCP schema、权限合同或生产会话。
- 未执行 push、merge、tag、release。
- 未读取或记录明文凭据、OAuth 状态、隐藏 reasoning；报告不复制 raw rollout。

本报告只验证 Codex 官方 `wake_on_agent_messages`。普通 `codex queue`、MCP Attention 长等待和 Thin Waiter 的独立 Host Event Wake Probe 是另一组实验，不能用本报告的 Native Agent Message 结果替代。

## 环境与 Feature Availability

| 组件 | 观测值 |
|---|---|
| OS / Host | Windows local desktop，Asia/Shanghai |
| Codex CLI | `0.169.0-alpha.11.1` |
| Codex Desktop | `26.1111.2228.0` |
| Node / npm | `v24.16.0` / `11.13.0` |
| Bridge Preview | `2.0.0-preview.8` |
| 官方源码基线 | `openai/codex@662a634e88fcc809d77da393d75572c3d814cb27` |
| 探针模型 | `opencode-go/deepseek-v4.1-flash`，reasoning `high` |

只读 Feature 检查结果：

```text
multi_agent          deprecated         true
multi_agent_v2       stable             false
wake_on_agent_messages under development false
```

执行：

```powershell
codex --enable wake_on_agent_messages features list
```

同一进程显示：

```text
wake_on_agent_messages under development true
```

因此：

1. 当前 CLI 识别该 Feature，但默认关闭，状态是 `under development`。
2. `--enable` 可以在当前 CLI 进程内临时启用，不需要永久修改配置。
3. 原生 `spawn_agent` 在 `multi_agent=true`、`multi_agent_v2=false` 时实际可用；`multi_agent_v2` 不是本机完成实验的前置条件。
4. Desktop rollout 记录同一 `cli_version=0.169.0-alpha.11.1`，但是否启用 Feature 由 Desktop 自己的配置决定，不能把 CLI 的进程级 `--enable` 外推到 Desktop。
5. 如果为了启用 Desktop Feature 必须修改用户全局 `config.toml`，本轮不执行；因此启用态 Desktop 记为 `DESKTOP_CONFIG_BLOCKED`。

## A/B：CLI Parent Final 后的原生唤醒

### A：Feature OFF 对照

| 字段 | 观测值 |
|---|---|
| Parent Thread | `01a1e4bd-0694-7c32-b9e1-9ee5cc884de0` |
| Child Thread | `01a1e4bd-7f09-7152-8648-6b0155f42dad` |
| Parent Turn | `01a1e4bd-090e-7ae1-b38e-f7276dc622ab` |
| Child Turn | `01a1e4bd-7f8b-76a0-93c3-629910be9f5f` |
| Parent Final | `PARENT_FINAL_NATIVE_WAKE_A_OFF3`，完成于 `2026-11-16T14:23:10.490Z` |
| Child sleep 开始 | `2026-11-16T14:23:12.391Z` |
| Child Final | `NATIVE_WAKE_ACK_20261116_A_OFF3`，完成于 `2026-11-16T14:23:45.247Z` |
| 新 Parent Turn | 无 |

Parent 先输出 Final 并结束 Turn，Child 随后独立运行约 30 秒，再用原生 FINAL_ANSWER 向 Parent 发送消息。默认 Feature OFF 时，Parent 没有自动产生新 Turn；至少观察 2 分钟仍为空闲，最终 rollout 中也没有后续 Parent Turn。

分类：`OBSERVED / PASS_AS_CONTROL / NO_WAKE`。

### B：Feature ON

| 字段 | 观测值 |
|---|---|
| Parent Thread | `01a1e4c1-0dac-7c20-8d0d-00d556d93c39` |
| Child Thread | `01a1e4c1-352a-7250-b30f-43eb48bcf8c7` |
| Parent 首个 Turn | `01a1e4c1-0fa0-75d2-b93e-5c230ec0cbb7` |
| Child Turn | `01a1e4c1-35a4-7af1-aaa1-ff0e7d52bf49` |
| Parent Final | `PARENT_FINAL_NATIVE_WAKE_B`，完成于 `2026-11-16T14:27:16.492Z` |
| Child sleep 开始 | `2026-11-16T14:27:24.416Z` |
| Child Final | `NATIVE_WAKE_ACK_20261116_B`，完成于 `2026-11-16T14:28:01.116Z` |
| 原生 Agent Message | `author=/root/native_wake_child_b`，`recipient=/root`，`trigger_turn=false` |
| 自动新 Parent Turn | `01a1e4c1-fdfc-79d0-8ccd-b210ef03aefa`，开始于 `2026-11-16T14:28:01.162Z` |
| Parent ACK | `NATIVE_WAKE_ON_ACK_CONSUMED_20261116_B`，完成于 `2026-11-16T14:28:07.045Z` |
| 人工补发/外部 queue | 无 |

这次运行在独立 CLI 会话中通过 `--enable wake_on_agent_messages` 启动。Parent 在 Child 完成前已经输出 Final；Child 完成后写入原生消息；Parent 在 Child `task_complete` 后约 `46 ms` 自动启动新的 Turn，并正确处理消息。

分类：`OBSERVED / PASS / NATIVE_WAKE_CONFIRMED`。

## 长等待与边界

| 检查 | 结果 | 证据 |
|---|---|---|
| Child 在 Parent Final 后继续运行 | **PASS** | 30 秒和 120 秒实验均由真实 Child sleep 完成。 |
| 约 2 分钟空闲唤醒 | **PASS** | Parent 完成于 `14:46:38.892Z`，Child 完成于 `14:48:41.621Z`，新 Parent Turn 开始于 `14:48:41.671Z`，Parent 空闲约 `122.8 s`。 |
| 1 小时/4 小时压力 | `NOT_TESTED` | 按任务边界未执行。 |
| Interrupt 影响 | `DOCUMENTED / RUNTIME_NOT_TESTED` | 源码规定 `is_interrupted()` 为真时禁止 Native Agent Wake；中断状态还会从 rollout 恢复。 |
| Plan Mode 影响 | `DOCUMENTED / RUNTIME_NOT_TESTED` | `TurnStartKind::Automatic` 不允许当前或提议状态为 Plan Mode。 |

长等待关键 ID：

- Parent：`01a1e4d2-4574-7202-8ecc-9818db713f37`
- Child：`01a1e4d2-e3a7-7c32-be62-25eb30a67bfc`
- Parent 初始 Turn：`01a1e4d2-a77a-7982-aa03-a7c75f06c959`
- Child Turn：`01a1e4d2-e457-7f02-a77c-14a028db99d7`
- 自动 Parent Turn：`01a1e4d4-ebb1-7d52-b24e-e570d6ced3ff`
- Parent ACK：`NATIVE_WAKE_LONG_CONSUMED_20261116`

分类：`OBSERVED / PASS / LONG_IDLE_WAKE_CONFIRMED`。

## Desktop Host 验证

### Desktop 普通 Thread

| 字段 | 观测值 |
|---|---|
| Parent Thread | `01a1e4c7-7b2c-73c2-a8cc-ea2010f0f752` |
| Child Thread | `01a1e4c7-acb0-7002-a830-4e74a282e54c` |
| Parent Turn | `01a1e4c7-7e42-7d82-bd2a-0af9c7e7d299` |
| Parent Final | `PARENT_FINAL_DESKTOP_WAKE_20261116`，完成于 `2026-11-16T14:34:21.346Z` |
| Child 定时器 | `node_repl` 的真实 `js` 调用，开始于 `2026-11-16T14:35:09.233Z` |
| Child Final | `NATIVE_WAKE_DESKTOP_CHILD_ACK_20261116`，完成于 `2026-11-16T14:35:50.639Z` |
| 新 Parent Turn | 无 |

Desktop 子代理没有发现可用的原生 `clock.sleep`，因此用了 `node_repl` 的真实 30 秒 JavaScript timer；这不是 mock，但它与 CLI 的 `clock.sleep` 路径不同，不能把两者混写成同一种 Child 工具。

默认 Desktop 配置下没有新 Parent Turn。最后一次只读检查为 `2026-11-16T15:07:00Z`，rollout 仍没有任何后续 Parent Turn。分类：`OBSERVED / FAIL / NOT_CONFIRMED`。

不创建 `--enable` 的 Desktop 变体，也没有修改用户全局配置；该变体分类为 `DESKTOP_CONFIG_BLOCKED`。

### Desktop `/goal`

| 字段 | 观测值 |
|---|---|
| Parent Thread | `01a1e4d4-9b8c-7941-9d01-a8aa6d3ac4ad` |
| Child Thread | `01a1e4d4-d7a2-7161-a2b1-a59abed22544` |
| Parent Turn | `01a1e4d4-9f5b-75a0-ac9c-11c00778fd3e` |
| Goal create | 真实 `create_goal`，返回同一 `threadId`，初始 `status=active` |
| Goal complete | 真实 `update_goal(status=complete)`，`tokensUsed=978`，`timeUsedSeconds=11` |
| Parent Final | `GOAL_PARENT_FINAL_DESKTOP_WAKE_20261116`，完成于 `2026-11-16T14:48:47.693Z` |
| Child 定时器 | 真实 `node_repl` `js` 调用，开始于 `2026-11-16T14:49:00.330Z` |
| Child Final | `NATIVE_WAKE_DESKTOP_GOAL_CHILD_ACK_20261116`，完成于 `2026-11-16T14:49:37.096Z` |
| 新 Parent Turn | 无 |

Goal 工具调用和 Goal 状态完成是实际观测，不是文本模拟。默认 Desktop 配置下，Goal 已完成后仍没有自动 Parent Turn。最后一次只读检查同为 `2026-11-16T15:07:00Z`。分类：`OBSERVED / FAIL / NOT_CONFIRMED`。

启用 Feature 的 Desktop Goal 变体需要改全局配置，分类为 `DESKTOP_CONFIG_BLOCKED`；不能把 CLI 成功直接外推为 Desktop Goal 成功。

## 静态代码核对

源码 checkout：`D:\codex-zcode-bridge\.run\native-agent-wake-20261116\.native-wake-workspace\source\openai-codex-662a634e`

### 唤醒条件

- `codex-rs/core/src/session/turn_input.rs:911`：`should_wake_on_agent_messages()` 要求 Feature 打开、Session 未被 interrupted、不是 non-root agent，并且 `TurnStartKind::Automatic` 允许当前模式。
- `codex-rs/core/src/session/turn_input.rs:81`：Automatic Turn 不允许 Plan Mode。
- `codex-rs/core/src/session/mod.rs:1605`：中断会设置 `AgentStatus::Interrupted`。
- `codex-rs/core/src/session/mod.rs:1805`：resume 时从 rollout 恢复中断状态。
- `codex-rs/core/tests/suite/agent_control_tests.rs:1049`：官方测试 `agent_mail_wakes_completed_root_when_enabled` 覆盖 completed root、`trigger_turn=false` 的 Native Agent Message 和新的 Turn。

这些是 `DOCUMENTED` 源码事实；除了 OFF/ON/长等待实验外，Interrupt 和 Plan Mode 的运行时行为没有再次消耗模型额度验证。

### 公开 Host 接口

`codex-rs/app-server-protocol/src/protocol/common.rs` 的公开方法包括 `thread/start`、`thread/resume`、`thread/inject_items`、`turn/start` 和 `turn/steer`，但没有 Agent Mailbox 注入 RPC。

`thread/inject_items` 只把 raw Responses history 写入线程历史，不启动 Turn；实现见 `codex-rs/app-server/src/request_processors/turn_processor.rs:1074`。

`codex-rs/agent-message-board-host/src/lib.rs:244` 构造 `InterAgentCommunication` 并调用 native board notification，但该 board 只绑定已经注册的 Codex Native Thread tree。它不是外部 Bridge 可任意连接的通用 mailbox ingress。

因此，外部 ZCode/Bridge Worker 不能直接发 Native Agent Mail；要得到这条路径，必须让 ZCode Worker 由 Codex Native Subagent 包装，并由 Native Subagent 通过 `collaboration` 工具面回传结果。

## Bridge 适用性

| 问题 | 结论 | 依据 |
|---|---|---|
| `wake_on_agent_messages` 是否只接受内部 Agent Message？ | **是，测试只确认内部 `InterAgentCommunication` 路径。** | 官方测试使用 `Op::InterAgentCommunication`；原生 message board 也走同一路径。 |
| MCP Worker 能否直接用公开接口进入原生 Mailbox？ | **不能确认，当前公开接口显示不能。** | AppServer 没有 mailbox inject RPC；`thread/inject_items` 不启动 Turn。 |
| 是否必须用 Native Subagent 包装 ZCode Worker？ | **是，若目标是用这条 Feature 唤醒 Parent。** | 只有 Native Subagent/Codex tree 内部能产生该 Agent Message。 |
| Parent Final 后 Child 能否继续？ | **能，已实测 30 秒和 120 秒。** | 两个真实 Child Turn 在 Parent 结束后继续并自动唤醒。 |
| Wrapper 是否增加模型调用、Token 或 Agent 槽？ | **会增加。** | Native Child 是独立 Codex Thread，产生自身 token usage；`spawn_agent` 占用原生并发 agent slot，且每个 Child 需要独立模型 Turn。 |
| 能否复用 Sidebar 和生命周期？ | **子代理生命周期可复用，Sidebar 复用未证实。** | 已观测到 Native Child Thread、`list_agents`/`send_message`/`wait_agent` 类工具；用户侧 Sidebar 归属未作为本轮测试目标。 |

## 方案比较

| 方案 | 语义 | 优点 | 主要问题 | 当前判断 |
|---|---|---|---|---|
| A. MCP Attention 长等待 | MCP tool call 保持活跃，返回后同一 Turn 继续 | 真实 SQLite Attention、无需 Host 私有接口、实现最少 | Parent 必须保持活跃，不解决真正 idle wake；长等待占用 Host turn/tool 资源 | 仅适合有界等待和交互式同步 |
| B. Thin Waiter + Codex Queue | 外部 SQLite waiter，返回后调用普通 `codex queue` | waiter 只读、实现简单、已在既有 Host Event Probe 中验证 loaded TUI/Goal 的相关 queue 路径 | queue 注入 `role=user`，不是 Worker-native 权限/语义；失败 resume 仍可能 exit 0；本轮 Native Wake 不能复用 | **`--notify-codex` NO-GO** |
| C. Native Subagent + `wake_on_agent_messages` | ZCode 由 Native Subagent 包装，Child 发出内部 Agent Message，Parent 自动恢复 | 语义最接近 Whole Task 完成通知；真实 CLI wake 已通过；Child 可独立于 Parent Final 运行 | 需要 wrapper 模型、额外 token/agent slot；Desktop 启用态未验证；没有外部公开 ingress | **长期默认候选，但不是当前生产默认；需另行授权做 Native-Subagent Adapter** |

本轮的推荐不是“把 Bridge 直接接上 Host”，而是：优先研究 C 的边界；不实现 B；不建设一个声称可让外部 Worker 直接写 Native Mailbox 的 Host Wake Adapter，因为当前公开接口不支持这个语义。

## 成本观察

以下是 rollout 中可观测的 Master/Child turn usage，不是账单审计，也不能直接推导一个百分比节省：

| 实验 | Parent 首个 Turn total | Child 最终 Turn total | 自动 Parent Turn total |
|---|---:|---:|---:|
| A OFF | 36887 | 36809 | 无 |
| B ON | 36764 | 36758 | 18501 |
| Long | 40035 | 39956 | 20114 |
| Desktop ordinary | 40357 | 174227（含多次 timer 尝试） | 无 |
| Desktop Goal | 84583 | 88548 | 无 |

这些数据显示 Native Subagent 并不是无成本的“通知通道”：Child 本身会消耗模型 token。`CHILD_SURVIVES_PARENT_FINAL` 与“零额外成本”不是同一件事。

## 结果分类

- `OBSERVED`：真实 Windows 进程、真实 Thread UUID、真实原生 Agent Message、真实 Host Turn 事件和 token usage。
- `DOCUMENTED`：官方源码中的 Feature gate、Plan/Interrupt 限制、消息类型和公开 AppServer method 列表。
- `INFERRED`：外部 Worker 必须经过 Native Subagent 包装；Desktop 启用态的可能行为；Sidebar 复用范围。
- `UNSUPPORTED`：外部 Bridge 直接通过公开接口写 Native Agent Mailbox。
- `BLOCKED`：Desktop Feature 启用态需要全局配置；未强行修改。
- `NOT_TESTED`：1 小时/4 小时压力、Plan/Interrupt 的真实 Native Wake 变体、Desktop 启用态普通/Goal Thread。

## 未解决问题

1. Desktop 默认配置为什么没有出现 Native Wake：是 Feature 默认关闭、Desktop 进程没有采用 `--enable`，还是其他 Desktop host gate；本轮没有修改全局配置，因此不能进一步归因。
2. 若使用独立 `CODEX_HOME` 启动 Desktop，能否在不触碰用户全局配置的情况下测试启用态；当前没有安全的 Desktop 启动/隔离方法。
3. Native Subagent 包装 ZCode 后，Worker 的真实结果如何以稳定的 Agent Message schema 回传，而不复制 Worker 自由文本或权限内容。
4. Native Child 的并发槽、取消、重复 Completion、Parent 再次 Final 后的 late message，以及 Goal 状态与 Wake 的交互仍需安全矩阵。

## 验证状态

- `evidence.json` 通过 PowerShell `ConvertFrom-Json`。
- `extract-native-wake-evidence.ps1` 通过 PowerShell parser，并对 5 个 case 的 10 份真实 rollout 完成脱敏 smoke extraction。
- `npm run test:affected` 退出码 `0`，模式为 `NO_TESTS_APPLICABLE`；`typecheck`、`build`、plugin validation 和 `git diff --check` 均为 PASS。
- `STRESS_TESTS_NOT_APPLICABLE`；本轮没有把文档映射结果写成单元测试通过。
- 构建生成物已恢复；用于验证的临时 `node_modules` junction 已移除。
- TUI trust prompt 曾向全局 `config.toml` 临时加入一个实验目录信任块；已按原始字节候选校验后恢复，最终 SHA256 为 `EA93A91E720DFDAEB24278DCE9F41C19AE3E5236536A4986AE2A2DACA7ABA37E`。
- 最终复核 `master` 仍只有 `M AGENTS.md` 和 `?? $null`。
