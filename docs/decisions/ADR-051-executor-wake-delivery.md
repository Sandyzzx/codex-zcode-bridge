# ADR-051：Executor Wake 交付

> Status: DECISION
> Date: 2026-11-22
> Decision: Accepted for the Async Executor Preview candidate
> Implementation status: IMPLEMENTED — PARTIAL / BLOCKED
> Baseline: `origin/preview` `1bf039fda2ccfd17a992458a871bddd7b48b38c1`
> PR #131 baseline: `a1bc911ec1b03cd22bbf13e717fc2233284e6183`
> Acceptance implementation: `7f54531acba0844937bc134609dae840090294ec`
> Related architecture: [BRIDGE_ASYNC_EXECUTION_V1.md](../architecture/BRIDGE_ASYNC_EXECUTION_V1.md)

## 决定

Wake 是独立 Executor 在 Operation durable `released` 后执行的一次性通知
Adapter。它不参与 Task、Result、Cleanup、Release 或 Recovery 判定，也不构成
第二任务管理器、调度器或持久化 Authority。

交付顺序固定为：

```text
Result committed -> Cleanup verified -> Operation released
                 -> Wake intent -> Queue / Web Notify -> Turn observation
```

Queue 是已确认 loaded/idle Thread 的首选 Wake Adapter。任何不确定条件都
fail closed 到 Web Notify，不调用 Queue，不创建模型 Turn。

## 授权策略

Queue Wake 只读取 Authority Root 下的精确
`<authority-root>/wake-policy.json`。该文件不是凭据，也不能绕过 TaskPackage
授权。它必须绑定：

- `task_id`、`attempt`、规范化 `workspace`；
- 原 Codex `thread_id`；
- 预期 `model`、`model_provider`、`reasoning_effort`；
- Owner 明确授予的 `scope: one_turn`、授予/过期时间和 `granted_by: owner`；
- 固定 `fallback: web_notify`。

授权窗口最长 24 小时；只接受 `minimal`、`low`、`medium`。文件必须 exact-key、
有界、普通文件且非 symlink。配置缺失、过期或无效都只允许 Web Notify。

受支持的 Owner 写入入口是：

```text
zcode-bridge task wake-authorize <task_id> \
  --attempt <current-attempt> \
  --thread <thread-id> \
  --model <exact-model> \
  --model-provider <exact-provider> \
  --reasoning-effort minimal|low|medium \
  --expires-in-minutes 1..1440 \
  --confirm-owner
```

CLI 先从同一 Executor Control 面确认 Task 存在且 `--attempt` 等于当前 Attempt，
再从持久 TaskPackage 取得 workspace。`wake-policy.json` 使用排他创建；已有策略
不会被静默覆盖。该命令不直接写 SQLite，不新增管理服务，也不发送 Queue。

## 派发前检查

Executor 通过 `codex app-server proxy --sock <control-socket>` 建立只读
App Server 会话，并同时确认：

1. Thread 位于 `thread/loaded/list`；
2. `thread/read` 状态为 `idle` 且 `canAcceptDirectInput=true`；
3. `cwd` 与授权 workspace 一致；
4. Thread 当前 `model`、`modelProvider`、`reasoningEffort` 与策略完全一致；
5. reasoning effort 不属于 High/Extra High。

任一字段缺失、不匹配、App Server 不可用或 Thread 不 loaded，都记录
`web_notify`，不得尝试 Queue。

CLI 参数不能覆盖原 Thread 的模型或 reasoning effort；因此策略不尝试用
`codex queue -c` 改配置。预算确认限定为 Owner 的一次性单 Turn 授权和
最高 `medium` effort；单 Turn 内部的实际 token/计费不可由本 Adapter
强制或精确观测，必须报告为 `UNKNOWN`。

## Queue 与状态

通过全部预检后，先持久化 `intent`，再只执行一次：

```text
codex queue --thread <thread-id> --message <bounded-wake-message>
```

不使用 `--resume`，不重试。状态语义：

| 观测 | 记录 |
|---|---|
| CLI 未启动 | `web_notify` / `queue_command_unavailable` |
| spawn 后退码非零、信号或 timeout | `submission_unknown` |
| exit 0 | `queued`，不表示 Turn 已启动 |
| 出现 baseline 之外的新 `inProgress` Turn | `turn_started` |
| Thread/模型/预算/加载条件不满足 | `web_notify` |

Queue 消息只包含 Task、Attempt、Operation、Result digest 和读取
`zcode_result(view=summary)` 的恢复指令，不复制 Worker 完整输出。

`QUEUED`、`TURN_STARTED`、`TURN_COMPLETED`、`DESKTOP_VISIBLE` 必须分别报告；
本 Adapter 没有 Desktop UI acknowledgement，故 Desktop visible 始终为
`UNKNOWN`。Queue exit 0、消息出现或 Turn 开始都不能冒充 Master 已恢复或
Task 已验收。

## SQLite v14 持久化

不新增 schema 或表。Wake 事实追加到现有 terminal Operation 的 bounded
`observation_recorded` evidence：

```text
reason=executor_wake
delivery_id, policy_digest, authorization_digest
task_id, attempt, operation_id, generation
result_digest, result_commit_ref
thread_id, state, reason_code, evidence_digest
```

`thread_id`、策略摘要和授权摘要在同一 delivery 内不可变。每次 Operation 最多
5 条 Wake 事实，单条 evidence 最多 2 KiB。相同 observation 幂等；冲突 binding、
非法 transition、重复 Queue ACK 或超过上限均 fail closed。Wake 事件只追加为
`released -> released` observation，不改变 Task、Result、Cleanup、Release、
capacity 或 Recovery projection。

Web 通知只在 `web_notify` 事实首次持久化后触发；展示失败不改变 SQLite
Authority，也不重试 Queue。

Task CLI 和 Web Console 的现有列表读取同一 SQLite 投影，并附加只读的
`wake: {state, reason_code, at}` 摘要。该摘要来自当前 Attempt 最新的
`executor_wake` Event，不新增表、通知数据库或后台轮询服务。Web Console 显示
Wake 计数、提示条和行内 badge；用户不再需要先逐条打开 Event 才能发现回退。

## 独立验收

- 已加载 idle 模式通过合成 App Server/Queue 客户端与跨进程 fake Worker
  Result -> Cleanup -> Release -> Wake -> Web fallback E2E。
- shipped MCP Host 进程被终止后，隔离 Executor 仍完成原 Attempt Result、
  Cleanup、Release；单次 Spawn，新 Host 可重连读取同一 Result。证据边界是
  `REAL MCP HOST PROCESS EXIT + SYNTHETIC WORKER`，不是真实 Desktop。
- 真实 Desktop loaded/idle Queue 证据来自 2026-11-21 B/C 实验；本候选没有
  在 Owner 当前 Desktop 上重放。
- notLoaded 的严格 C 与 Desktop 全退的严格 D 仍未运行，作为独立发布门禁，
  不阻塞已加载模式实验版。
- 真实 App Server control socket、真实 Queue 和真实付费模型未在候选测试中
  调用；当前 socket 不存在时真实 probe 固定记录
  `web_notify / app_server_unavailable`，Queue 调用为 0，费用/额度不可观测。
- 未合入 Preview、未发布；Async Master Skill 只有确定性合同测试，未完成真实
  模型遵循率验收。

完整实机验收记录见
[async-executor-real-host-acceptance-20261122.md](../reports/async-executor-real-host-acceptance-20261122.md)。

## 拒绝

- 不创建 Wake 数据库、journal、后台守护进程或第二套状态机。
- 不修改 Codex Desktop 私有数据库、IPC 或凭据。
- 不在模型、provider、effort、Thread 加载状态或预算授权未确认时自动 Queue。
- 不把 `submission_unknown` 自动重发，也不以新 Task/Attempt 掩盖未知提交。
- 不把 Web Notify、Queue ACK 或 Turn 开始当作结果验收。
