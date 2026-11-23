# ADR-051：Executor Wake 交付

> Status: DECISION
> Date: 2026-11-22
> Decision: Accepted for the Async Executor Preview candidate
> Implementation status: IMPLEMENTED — TRUSTED-LOCAL TARGETED / NATIVE READBACK BLOCKED BY INSTALLED HOST VERSION
> Baseline: `origin/preview` `1bf039fda2ccfd17a992458a871bddd7b48b38c1`
> PR #131 baseline: `a1bc911ec1b03cd22bbf13e717fc2233284e6183`
> Acceptance implementation: `7f54531acba0844937bc134609dae840090294ec`
> Readback diagnosis baseline: `f88e0919259b17862f012f6549b57f2b2608cfc6`
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

Wake Policy 有两种互斥的交付模式：

- `strict`：缺少该字段的既有策略和 CLI 默认值都归入此模式；必须取得同一
  Owner 的实时 loaded/idle 与精确模型配置预检后才能 Queue。
- `trusted_local`：仅用于单用户、本地可信 Windows Host 的显式 Owner 授权；
  允许在无法访问 Desktop 私有 stdio App Server 时提交一次 Queue。Owner
  明确接受目标 Thread 在任务期间改变 Model、Provider 或 Effort 的风险。

`trusted-local` 不是通用绕过开关。它仍要求精确 Task、Attempt、Workspace、
Thread、未过期的一次性 Owner 授权，以及已提交 Result、Cleanup verified 和
Operation released。它不改变 Task、Result、Cleanup、Release、Recovery 或
Executor Authority，也不引入 Daemon、Host Agent、Supervisor 或第二状态机。

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
  --delivery-mode strict|trusted-local \
  --confirm-owner
```

CLI 先从同一 Executor Control 面确认 Task 存在且 `--attempt` 等于当前 Attempt，
再从持久 TaskPackage 取得 workspace。`wake-policy.json` 使用排他创建；已有策略
不会被静默覆盖。该命令不直接写 SQLite，不新增管理服务，也不发送 Queue。

省略 `--delivery-mode` 时写入 `strict`。既有不含该字段的 v1 policy 继续按
`strict` 读取。`trusted_local` 中记录的 model/provider/effort 是授权时的
Owner 快照和审计字段，不是投递时的实时校验结论；不得把它们报告为
`MODEL_MATCH_PROVEN`。

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

`trusted_local` 不执行上述私有控制面预检。它只验证策略、绑定、授权时间和
Result/Cleanup/Release，然后先写入唯一 `intent`，再执行一次 Queue。该模式
不能证明 Thread 当前 loaded/idle、Owner 身份或当前模型与授权快照一致；这些
事实必须保持 `UNKNOWN`。

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
| trusted-local exit 0、无同 Owner 观察能力 | 先记 `queued`，再记 `web_notify` / `trusted_local_turn_start_unverified` |

Queue 消息只包含 Task、Attempt、Operation、Result digest 和读取
`zcode_status`、`zcode_result(view="summary", expected_attempt=<attempt>)`、
Cleanup/Release 核对与独立验收指令，不复制 Worker 完整输出。readback 必须
直接使用 Host 已注册的原生 MCP 工具；不得要求 Master 在受限 Thread 中用
`exec_command`、PowerShell、Node、`bridge.mjs`、Thin MCP 或 Task CLI
另起子进程连接 Executor Named Pipe。Host MCP 与工具沙箱是不同权限边界，
shell child 失败不能证明原生 MCP 不可用，也不能改写成 `TASK_NOT_FOUND` 或
Executor 不存在。CLI 输出中的官方 Queue message ID 作为可选
`queue_message_id` 追加到 `queued` evidence；该字段不改变凭证或公共 MCP
schema，也不提升 SQLite Schema Version。

原生 readback 只调用既有只读 `zcode_status`、`zcode_events` 和
`zcode_result`，不新增 Result 服务、第二持久化权威或写权限。若原生 MCP
已注册但版本仍是旧 in-process Manager，必须报告
`BLOCKED_BY_INSTALLED_HOST_VERSION`；在安装当前 Thin MCP 并取得真实
Authority readback 前，不得以普通本机 CLI 成功替代 Host readback。

`QUEUED`、`TURN_STARTED`、`TURN_COMPLETED`、`DESKTOP_VISIBLE` 必须分别报告；
没有 Desktop UI acknowledgement 时 Desktop visible 始终为 `UNKNOWN`。
Queue exit 0、消息出现或 Turn 开始都不能冒充 Master 已恢复或 Task 已验收。
trusted-local 的最终状态可以提高 Web 可发现性，但不能把
`trusted_local_turn_start_unverified` 改写为 `TURN_STARTED`。

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
- 新增 trusted-local 定向测试覆盖显式/旧 policy、过期授权、Task 绑定、
  单次 Queue、message ID、timeout、Turn 未确认降级和 SQLite v14 evidence；
  真实自动 Wake Turn、Master Result readback 与 Desktop Visible 仍需要新的
  Codex 模型预算授权，当前 `BLOCKED_BY_AUTHORIZATION`。
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
- 不在没有显式 `trusted_local` policy 时跳过严格预检。
- 不把 trusted-local 推广为远程、多租户或无人值守模型授权机制。
