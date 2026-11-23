# Trusted-Local Automatic Wake

> Status: RESEARCH / IMPLEMENTATION EVIDENCE
> Date: 2026-11-23（Asia/Shanghai）
> Wake implementation: `ca10518728c87b35c719b0293b48045946728932`
> CI isolation commit: `eac515a1c8080235ba18a0fe2a164544ef4e5203`
> CI timeout alignment: `99d034bf561dcc8845037cd43fb83cc1f060b58f`
> CI stress-wait alignment: `17dd8d8ea4dd0798780ced3d48019e49a22da3f2`
> PR: #131, open, base `preview`
> Real E2E baseline: `ab73180b929be219bb680a0cc50825feca74b478`
> Readback diagnosis baseline: `f88e0919259b17862f012f6549b57f2b2608cfc6`
> Readback contract fix: `42667cff0646fbdac907809ba546cb500362503b`
> Overall result: `PARTIAL — REAL AUTO QUEUE + TURN_STARTED PASS / NATIVE READBACK BLOCKED BY INSTALLED HOST VERSION`
> Preview recommendation: `NO-GO until the current Thin MCP is installed in the Host and native Result readback passes a fresh Wake Turn`

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

2026-11-23 的隔离真实 E2E 进一步证明：Executor 会在 Result Commit、
Cleanup Verified、Operation Released 后自动调用一次官方 Queue；Queue ACK
之后原 Desktop Thread 确实启动了新 Turn，实际模型/provider/effort 与授权快照
一致。该 Turn 的测试包装器明确要求 Master 通过 `exec_command` 启动
Thin MCP 子进程，结果收到 `EXECUTOR_UNAVAILABLE`；相同命令在普通本机进程
中成功。该证据只证明 **sandboxed shell child path** 失败，不等于原生
Host MCP 失败。

后续只读诊断发现本轮另一个更早的部署条件：当前 Codex Host 注册的
`zcode_bridge` 仍指向 `2.0.0-preview.13` 的旧 in-process Manager，而 PR #131
候选的 shipped MCP 已是 Thin control transport。原生 `zcode_status` /
`zcode_result` 工具确实可调用，但只能读取安装版 Authority：对旧的隔离 Task
返回 `TASK_NOT_FOUND`。因此 `NATIVE_MCP_READBACK` 当前是
`BLOCKED_BY_INSTALLED_HOST_VERSION`，没有进行新的真实模型 Turn。

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
| `EXECUTOR_AUTO_QUEUE` | `PASS — REAL + SYNTHETIC` | 真实 post-Release hook 自动提交一次 Queue。 |
| `QUEUE_ACK` | `PASS — REAL` | exit 0 持久化 `queued` 并记录 official message ID。 |
| `TURN_STARTED` | `PASS — REAL` | 原 Thread 出现 `turn_trigger=queue` 的新 Turn。 |
| `SANDBOX_READBACK` | `FAIL — REAL` | 测试包装器让受限 Thread 的 shell 子进程启动 Thin MCP；连接 Executor 返回 `EXECUTOR_UNAVAILABLE`。 |
| `NATIVE_MCP_REGISTERED` | `PASS — OBSERVED` | Host 原生 tools 可调用；`zcode_bridge` 注册为 enabled。 |
| `NATIVE_MCP_CURRENT_RC` | `FAIL — DEPLOYMENT` | 注册插件仍是 Preview.13 in-process Manager，不包含候选 Thin control marker。 |
| `MASTER_RESULT_READBACK` | `BLOCKED_BY_INSTALLED_HOST_VERSION` | 原生工具不能读取旧隔离 Executor；未启动新 Turn，不伪称 PASS/FAIL。 |
| `MASTER_INDEPENDENT_ACCEPTANCE` | `NOT_RUN` | 没有任何本轮原生 Result readback，固定 ACK 仍不计 PASS。 |
| `DESKTOP_VISIBLE` | `PASS — REAL, POST-COMPLETION` | Thread 与失败回复在 Desktop 可见；运行中截图未采集。 |
| `WEB_NOTIFY_FALLBACK` | `PASS — TARGETED` | SQLite v14 evidence、CLI/Web 投影与通知回调保留。 |

## 2026-11-23 隔离真实 E2E

测试 Thread：

```text
01a205c7-1bca-7642-919c-38e09cc22bf6
cwd = C:\Users\Sandy\.codex\worktrees\async-executor-pr5-20261122\codex-zcode-bridge
```

Executor 以独立 Node 进程运行，Lease 为
`84b5a510-b616-4737-8fd8-fbe84385d05b`。MCP Host 在收到 Task 受理回执后
退出；synthetic Worker 继续执行。Task/Attempt 为
`wakeauto202611231119 / 1`，Operation 为
`sqlite-70b3dfb63ff8c2a128cce2a1d3d44133`。

| 事实 | 结果 | 证据 |
|---|---|---|
| synthetic Worker spawn | `PASS — 1` | `worker-spawns.log`、PID `12820` |
| Result Commit | `PASS — 1` | digest `8df0d8198fef63e8dc7ea88b109483cee3cf69ee8b5371091d80618f32b29f0f` |
| Cleanup Verified | `PASS — 1` | `operation_resources_complete=true`、`workspace_touched=false` |
| Operation Released | `PASS — 1` | `task-events.json` 中唯一 `released` |
| Executor auto Queue | `PASS — 1` | Queue wrapper 唯一 invocation，exit `0` |
| Queue Message ID | `PASS — REAL` | `01a2066a-e167-7830-ab7d-e40f4e07a673` |
| new Turn | `PASS — REAL` | `01a2066a-f9d9-70e3-a76b-3353876ee25d`，`turn_trigger=queue` |
| model/provider/effort | `PASS — SNAPSHOT MATCH` | `opencode-go/deepseek-v4.1-flash` / `magpie` / `low` |
| Master `zcode_status` | `FAIL — REAL` | `EXECUTOR_UNAVAILABLE: EXECUTOR_UNAVAILABLE` |
| direct non-sandbox readback | `PASS — REAL` | completed、attempt 1、Result/Cleanup/Release/Wake facts 各一次 |
| duplicate Queue / Worker / Turn | `PASS — NONE` | 唯一 Queue invocation、Worker spawn、`turn_trigger=queue` Turn |

目标 Turn 的 rollout 记录显示其权限为 managed restricted filesystem、
`network=restricted`、`sandbox_policy=read-only`。Thread 内 readback 子进程
已经打印正确的隔离 Authority Root，并加载 Thin MCP，但连接 Executor 时失败。
相同命令在受限 Thread 外的本机进程 PASS。当前证据可以排除 Result 丢失、
Executor 提前退出和 Authority Root 选择错误；不能进一步区分 Named Pipe
ACL、沙箱网络分类或子进程继承策略，因此根因标记 `UNKNOWN_SANDBOX_PATH`。

本轮第一个 harness 尝试在调用官方 Queue 之前被包装器参数错误拒绝，记录
`QUEUE_WRAPPER_COMMAND_INVALID`。它没有产生官方 Queue、模型请求或新 Turn。
修复后使用新的 Task 完成上述唯一真实 Queue；旧 Task/Attempt 未重发。

Token usage 可从 rollout 观测，目标 Turn 累计为
`input=44,367 / cached=21,760 / output=358 / reasoning=74 / total=44,725`。
Provider 费用和账户扣费不可观测，报告不估算金额。单 Turn 内有一次
readback tool callback，因此包含两次 token usage record；没有第二个 Queue
Turn。

## Native MCP 与沙箱 shell 诊断

本次只读检查没有产生模型请求，也没有启动第二个 Executor：

| 观测 | 结果 |
|---|---|
| Codex Desktop / CLI | `26.1117.4957.0` / `0.171.0-alpha.13` |
| Desktop App Server | PID `23280`，包安装路径 `OpenAI.Codex_26.1117.4957.0_x64__2p2nqsd0c76g0` |
| 插件 MCP 进程 | PID `27344`，父 PID `23280`，`node ./launch-node24.mjs` |
| `zcode_bridge` 注册 cwd | `C:\Users\Sandy\.codex\plugins\cache\codex-zcode-bridge-preview\codex-zcode-bridge\2.0.0-preview.13\.` |
| 安装版 bundle | SHA-256 `02b2d24b98acb56ac5b64454fb7b05c68c9ccd12f8b54c31b17c55043058045b`，无 Thin control marker |
| 当前 RC bundle（修复前） | SHA-256 `202be2e4834e5c8f154c46293b7dfe607c4f788de38ed7c4d0c29186f8946cf8`，有 Thin control marker |
| 原生 `zcode_doctor` | 可调用；读取安装版 SQLite Authority |
| 原生 status：隔离 Task | `TASK_NOT_FOUND` |
| 原生 status/result：安装版 cancelled Task | 可读取；原生 transport 本身可达 |
| Named Pipe 探针 | 普通进程连接 PASS；CLI 无法在此进程重建同款 packaged Windows sandbox，未取得限制态 OS error code |

关键结论：当前失败不是“Host 无法调用 MCP”，也不是 Result 丢失。它是两个
独立边界：

1. 旧测试 Turn 使用了不被支持的 sandboxed shell child readback；
2. 当前安装版 Host 尚未部署 PR #131 Thin MCP，因此原生工具指向错误 Authority。

为避免测试器再次把 shell child 当成原生 MCP，Wake message 与 Async Handoff
Skill 已明确要求直接调用 Host 已注册的原生 `zcode_status` 和
`zcode_result(view="summary", expected_attempt=<attempt>)`，并禁止通过
`exec_command`/PowerShell/Node 启动 `bridge.mjs`、Thin MCP 或 Task CLI
读取 Named Pipe。该修改不改变 Queue、Task、Result、Cleanup、Release 或
Recovery 合同。

该修复提交后的定向验证：

```text
npm run typecheck                                  PASS
npm run build                                      PASS
npm run validate:plugin                            PASS
npm run check:generated                            PASS, 14 files fresh
npm run test:affected -- --development --t0-only   PASS
executor-wake + skill-policy                        23/23 PASS
MCP stdio Thin transport                            5/5 PASS
Thin MCP reconnect + Host-exit Result durability    2/2 PASS
git diff --check                                   PASS
```

`executor-process` 当前代码的 2 项定向 E2E 分别证明：MCP 断连后 Executor
继续原 Attempt，并允许新 Host 读取同一 Result；shipped MCP Host 进程退出后
synthetic Worker 只 Spawn 一次，原 Attempt 产生一个 Result、Cleanup verified
与 released，重连后 `zcode_result` 仍返回 attempt 1。

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
记录一次 policy-missing Web fallback。该定向结果本身不是 Queue Turn；
真实自动 Queue Turn 见上一节。

## CI 证据

PR run `45095687608` 的首轮 Cost Lab job `137434933391` 与单 job rerun
`137440844056` 均在同一个 Windows 进程树探针超时。串行测试提交后，run
`45098105506` 的 job `137442456030` 仍在同一处失败：

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
Wake 或 Result 丢失。这三次失败证明串行化不是充分修复；Hosted Windows
Runner 的进程表枚举本身可以超过原 30 秒 Gate 和 20 秒 helper 响应预算。
Commit `99d034bf` 只对齐超时预算：精确 Process Tree 证明合同不变，
enumeration response 为 60 秒、Lifecycle Tree Gate 为 90 秒、Cost Lab
Release 观察为 120 秒。定向验证为：

```text
npm run typecheck                      PASS
npm run build                          PASS
windows-recorded-tree-native + process-spawn   6/6 PASS
cleanup/process-tree composition               24/24 PASS
executor-process synthetic Result/Cleanup/Release 1/1 PASS
npm run cost-lab:test                  90/90 PASS
npm run validate:plugin                PASS
npm run check:generated                14/14 fresh
```

本地 Cost Lab 进程所有权 E2E 用时 14.9 秒。后续 run `45099743834`
在代码提交 `17dd8d8e` 上全部通过：Fast PR gate、Ubuntu Verify、
Windows Verify 两分片与聚合、Windows/Ubuntu SQLite resource matrix、
Cost Lab 和 impact selection 均为 success；Integration gate 按配置 skipped。
该门禁同时验证了 32,000-event Windows stream stress 与 Cost Lab 进程所有权。

## 真实 E2E 边界

本轮只使用一个隔离测试 Thread、一个 synthetic Worker 和一个真实 Queue
Wake Turn。没有关闭 Desktop，没有向 Owner 当前工作 Thread 注入消息，
没有合并 Preview，没有发布 Release。未自动重试 Queue，也没有对同一
Task/Attempt 重发。

Desktop 在新 Turn 完成后显示了 original Wake message、失败 readback 和
“No acceptance determination was made.”。证据截图：
`.run/executor-auto-wake-e2e-20261123/desktop-visible.png`。运行中状态由
Thread 工具观测为 `active`，但没有在 Turn 进行中采集 Desktop 截图。

## 最小后续实验

1. 不重跑已经消费授权的 Turn。先在隔离 Host 中部署当前 PR #131 Thin MCP，
   确认 `zcode_bridge` 的注册 cwd/bundle hash 指向该候选，而不是
   Preview.13 in-process Manager。
2. 用真实独立 Executor、真实 Control IPC 和 synthetic Worker 验证原生
   `zcode_status` / `zcode_result` 能读取同一 Authority；错误 Task/Attempt
   不得返回其他结果，读取路径不得 Spawn Worker 或调用 Task/Cancel/Continue/
   Shutdown。
3. 取得新的单 Turn 授权后，用全新 synthetic Task 重做一次自动 Queue E2E；
   Master 必须在原生工具中读取同一 Result digest、Cleanup 和 Release，再作
   独立验收。上一次失败的 Task/Attempt 不重发。
4. 若原生工具仍不可用，保持 `QUEUED + Web Notify` 安全降级，不宣称自动
   Master recovery；不得回退到沙箱 shell child。

## 发布建议

当前实现可作为 PR #131 的 targeted candidate 评审，但不应合并 Preview。
自动 Queue 和 Turn Started 已真实通过；结果读取实现本身已有跨进程
Result/Cleanup/Release 与 Thin MCP reconnect 证据。当前发布阻断是部署与
验收边界：安装版 Host 仍为旧 in-process Manager，且没有在新的原生 readback
路径上取得真实 Turn 证据。发布建议保持 `NO-GO`，直到原生 Host readback
真实 PASS。

## 证据索引

本地隔离证据位于：

```text
.run/executor-auto-wake-e2e-20261123/queue-invocation.json
.run/executor-auto-wake-e2e-20261123/queue-wrapper.jsonl
.run/executor-auto-wake-e2e-20261123/task-events.json
.run/executor-auto-wake-e2e-20261123/task-result.json
.run/executor-auto-wake-e2e-20261123/readback-outside-sandbox.json
.run/executor-auto-wake-e2e-20261123/executor-status.json
.run/executor-auto-wake-e2e-20261123/desktop-visible.png
.run/pr131-native-readback-20261123/codex-mcp-list.txt
.run/pr131-native-readback-20261123/native-readback-evidence.json
.run/pr131-native-readback-20261123/pipe-probe-evidence.json
```

首次预提交包装器失败保存在相邻的
`.run/executor-auto-wake-e2e-20261123-preflight-wrapper-failure/`，不属于
Queue 或模型请求证据。
