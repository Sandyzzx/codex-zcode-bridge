# Trusted-Local Automatic Wake

> Status: RESEARCH / IMPLEMENTATION EVIDENCE
> Date: 2026-11-23（Asia/Shanghai）
> Wake implementation: `ca10518728c87b35c719b0293b48045946728932`
> CI isolation commit: `eac515a1c8080235ba18a0fe2a164544ef4e5203`
> PR: #131, open, base `preview`
> Overall result: `PARTIAL — TARGETED PASS / REAL TURN BLOCKED_BY_AUTHORIZATION`
> Preview recommendation: `NO-GO until isolated real Wake and Master Result readback pass`

## 结论

Bridge 现在有两种互斥的 Queue Wake 模式：

- `strict`：既有默认。缺少 `delivery_mode` 的 policy 仍按 strict 读取；必须从
  同一 Desktop Owner 的 App Server control socket 读取 loaded/idle、
  `canAcceptDirectInput`、workspace、model、provider 和 effort。
- `trusted_local`：只用于显式授权的单用户本地可信 Windows Host。Owner 接受
  目标 Thread 在投递时使用当前模型配置的风险；Bridge 不再要求不存在的私有
  control socket，但仍校验 Task/Attempt/Workspace、授权有效期、
  Result/Cleanup/Release 和一次性 intent，然后只提交一次官方 Queue。

`trusted_local` 不证明当前模型匹配、Thread loaded 或 Turn 已开始。Queue exit 0
只记录 `QUEUED`；没有同 Owner 观察面时随后记录
`web_notify / trusted_local_turn_start_unverified`，用于 Web 可发现性和安全
降级，不重发 Queue，也不改写为 `TURN_STARTED`。

## 官方机制核对

Observed 版本：Codex CLI / bundled app-server `0.171.0-alpha.13`，官方源码
tag `rust-v0.171.0-alpha.13`，commit
`581161ab41e643d942e1e1b5f561034060bf18e3`。

| 问题 | 观察 |
|---|---|
| `codex queue` 使用哪个 App Server | `session_queue_commands.rs` 通过 `start_app_server_for_session_command` 选择显式 remote、发现到的本地 daemon，或 embedded app-server。 |
| Queue 是否共享持久化 | `thread_queue_processor.rs` 的 `thread/queue/add` 通过 `QueuedItemService` 写入 Thread Store；目标 Thread unloaded 时仍从 store 解析 cwd/source 并入队。 |
| `--resume` 做什么 | 只在 Queue 成功后读取 Thread；若为 `notLoaded`，另行调用 `thread/resume`。resume 失败仅 warning，CLI 仍成功。 |
| Queue ACK 是否启动 Turn | 否。`thread/queue/add` 返回 `QueuedSubmission`；独立的 `thread/queue/start` 要求 loaded Thread、检查 provider config，并有 idle 条件。 |
| 外部是否能证明 Desktop Owner | 当前 Host 使用私有 stdio app-server，没有可发现的官方 control socket；独立 App Server 的状态不能冒充 Desktop 状态。 |
| 模型是否可由 Queue 参数覆盖 | 否。CLI help 明示 queued messages use the Thread's model；`-c` 不是 queued-message model override。 |
| 原子条件提交 | 当前可用的 `thread/queue/add` 不是 `enqueueIfIdleAndConfigMatches`；不存在 Bridge 可用的同 Owner 条件 Queue 合同。 |

因此 strict 仍保持 fail closed。trusted-local 是对该 Host 能力缺口的显式、
本地、单用户风险裁决，不是对模型匹配或 Owner 查询的伪造。

## Policy 与投递合同

Owner 入口：

```text
zcode-bridge task wake-authorize <task_id> \
  --attempt <current-attempt> \
  --thread <thread-id> \
  --model <authorization-snapshot-model> \
  --model-provider <authorization-snapshot-provider> \
  --reasoning-effort minimal|low|medium \
  --expires-in-minutes 1..1440 \
  --delivery-mode strict|trusted-local \
  --confirm-owner
```

`trusted-local` 中 model/provider/effort 是授权时快照和审计字段，不是实时
`MODEL_MATCH_PROVEN`。策略仍排他创建，最长 24 小时，不覆盖已有文件。

投递顺序：

```text
verify policy + Task/Attempt/Workspace + authorization
-> verify Result committed + Cleanup verified + Operation released via existing SQLite recorder
-> durable intent
-> one `codex queue --thread <id> --message <bounded>`
-> QUEUED + optional official Queue message ID
-> trusted_local_turn_start_unverified Web fallback
```

超时、信号、非零退出或未知结果记录 `submission_unknown`，不重试。相同
Task/Attempt/Operation 的既有 intent 阻止第二次 Queue。

## 状态矩阵

| 事实 | 当前状态 | 边界 |
|---|---|---|
| `TRUSTED_PREFLIGHT_AVAILABLE` | `false` | 当前 Desktop 无私用 control socket；不新增 Host Agent。 |
| `SAME_OWNER_PROVEN` | `false` in trusted-local | Owner 显式接受本地风险，未证明 Desktop Owner。 |
| `MODEL_MATCH_PROVEN` | `false` in trusted-local | 不把 policy 快照与实际 Thread 配置混同。 |
| `EXECUTOR_AUTO_QUEUE` | `PASS — SYNTHETIC` | Coordinator 在 post-Release hook 中自动调用一次 Queue。 |
| `QUEUE_ACK` | `PASS — SYNTHETIC` | exit 0 持久化 `queued`，并解析 official message ID。 |
| `TURN_STARTED` | `BLOCKED` | 无同 Owner 控制面；trusted-local 不改写为 started。 |
| `MASTER_RESULT_READBACK` | `BLOCKED_BY_AUTHORIZATION` | 需要真实 Codex Wake Turn。 |
| `MASTER_INDEPENDENT_ACCEPTANCE` | `BLOCKED_BY_AUTHORIZATION` | 固定 ACK 不计 PASS。 |
| `DESKTOP_VISIBLE` | `BLOCKED_BY_AUTHORIZATION` | 本轮未触发新 Desktop Turn。 |
| `WEB_NOTIFY_FALLBACK` | `PASS — TARGETED` | SQLite v14 evidence、CLI/Web 投影与通知回调保留。 |

## 定向验证

已运行：

```text
npm run typecheck
npm run build:test
node scripts/test-isolated.mjs \
  dist-test/test/executor-wake.test.js \
  dist-test/test/task-cli.test.js \
  dist-test/test/skill-policy.test.js \
  test/sqlite-candidate/wp6b2b1/lifecycle-port.test.mjs \
  test/sqlite-candidate/wp6c/executor-wake.test.mjs
node scripts/test-isolated.mjs \
  --test-name-pattern="a real Executor commits a synthetic Worker Result, Cleanup, and Release across processes" \
  dist-test/test/executor-process.test.js
```

结果：`72/72 PASS`。覆盖 strict 原行为、trusted-local 显式/旧 policy、
过期授权、Task/Attempt/Workspace 绑定、单次 Queue、Queue message ID、
timeout `submission_unknown`、Web fallback、Skill 合同、SQLite v14 evidence
与历史读取兼容。当前源码的跨进程 E2E 另为 `1/1 PASS`：真实 Executor 与
synthetic Worker 完成原 Attempt 的 Result、Cleanup Verified、Release，并
记录一次 policy-missing Web fallback；该结果仍不是自动 Queue Turn。

## CI 证据

PR run `45095687608` 的首轮 Cost Lab job `137434933391` 与单 job rerun
`137440844056` 均在同一个 Windows 进程树探针超时：

```text
COST_LAB_RELEASE_WAIT_FAILED
bridge_release_unverified
result_committed
cleanup_pending
cleanup_unverified
reason=process_tree_probe_timeout
probe_state=incomplete
```

Executor 正确保持 Cleanup Hold，未把未证明的 Cleanup 当成 Release；这不是
Wake 或 Result 丢失。Commit `eac515a1` 仅将 Cost Lab 测试文件串行执行，
避免并行测试争用 Windows 进程树探针。本地
`npm run cost-lab:test` 为 `90/90 PASS`；对应进程所有权 E2E 用时 17.4 秒，
低于其 120 秒测试预算。最终 PR CI 结果必须在 exact head 上重新采集。

## 真实 E2E 边界

本轮没有：

- 发起新的 Codex 模型请求；
- 向 Owner 当前工作 Thread 注入 Wake；
- 关闭 Desktop；
- 合并 Preview 或发布 Release；
- 将历史人工 Queue 结果当成本轮自动 Wake 结果。

历史人工实验仍只证明 loaded/idle Thread 的真实 Queue ACK、Turn Started、
Master response 和 Desktop Visible，message ID
`01a205cc-60d0-7dc1-a396-c6385de2a417`。它不证明 Executor 自动预检或自动
Master Result readback。

## 最小后续实验

1. 取得隔离 Thread 的明确低成本模型/费用预算授权。
2. 用 synthetic Worker 派发隔离 Task，并写入 trusted-local one-shot policy。
3. Executor 完成原 Result/Cleanup/Release 后自动 Queue 一次。
4. 分别采集 Queue ACK、message ID、新 Turn、Master 的
   `zcode_status`/`zcode_result` readback、Result digest、Cleanup/Release 与
   Desktop 可见性。
5. 不重试未知提交；若未自动启动 Turn，保留 Web Notify 并标
   `TURN_STARTED=UNKNOWN`。

## 发布建议

当前实现可作为 PR #131 的 targeted candidate 评审，但不应仅凭本报告合并
Preview。发布仍需要：

- isolated real automatic Wake Turn；
- Master 读取原 Result 并独立验收；
- 至少一次真实 Desktop Visible 证据；
- 最终候选 exact-head Release Gate。
