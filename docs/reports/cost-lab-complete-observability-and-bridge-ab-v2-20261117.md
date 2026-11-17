# Cost Lab Complete Observability and Bridge A/B V2

> Status: RESEARCH
> Date: 2026-11-17
> Branch: `codex/cost-lab-observability-ab-v2-20261117`
> Base: `4aae0fc12ae6bac6eff9865d3f59d4036ef64b3a`
> Base tree: `affbd950e1780e190baa4d1b3cddb96d58dc68bb`
> Official source: ZCode `3.18.2`, commit
> `fec975905a2abd4c07e35c40d51fa097a2258ec9`, tree
> `5e90fec80706b8381f94e4eef48cf821b9868916`
> Evidence class: 固定官方 Runtime、隔离 AppServer、实时 Wire/RPC/HTTP 探针、离线重放、
> 官方 Coding Plan 小时账单和一次真实 Bridge B 任务
> Security boundary: 未输出 Authorization、Cookie、JWT 原文、Project Token、凭据密文或
> 完整 API Key；身份只保存本地 SHA-256 指纹和长度

## 1. 最终结论

| 项目 | 结论 | 证据边界 |
|---|---|---|
| Network / HTTP / RPC / Identity 观测 | `COMPLETE` | 原始 Wire 证据完整；最终代码离线重分类 Ultra Gateway 路径后达到完整覆盖 |
| 辅助模型请求 Usage | `PARTIAL_WITH_USAGE_MISSING` | `session_title` 请求被发现并以失败终态记录，但未暴露 Usage |
| 合成 E2E | `PASS` | Mock 覆盖 fetch、Undici、Node HTTP、SSE、失败、超时、重定向和 Ultra 路径 |
| 可复现构建 | `PASS` | 两次 clean-source 构建字节一致 |
| 生产 Bundle 隔离 | `PASS` | Cost Lab 不在生产 package/plugin 构建入口中 |
| Bridge 真实 B 实验 | `PASS` | 只启动一次授权任务，无自动重试；两个模型 HTTP 请求均被观测 |
| 官方账单对账 | `PASS` | 18:00 桶从零增量到 13,925 Token / 1.6072 Credits，Token 分类自洽 |
| Bridge 获取额外 0.67 优惠 | `FAIL` | 有效额外倍率 `1.0000087108772724`，与未优惠公式一致 |
| Native / Bridge 优惠渠道一致性 | `FAIL` | 历史 Native 为约 0.67，本轮 Bridge 为 1.0 |
| 根因 | `UNKNOWN` | 尚无 Native 请求级实时 Wire/Identity 对照，不能指定单个装配或 Header 为根因 |
| 根因置信度 | `LOW` | 可确认结果差异，不能确认服务端权益判定原因 |

本轮最重要的结论是：官方账单明确显示 B 路径没有获得额外 0.67。该结论不依赖预先假定
`session_title` 的倍率，也不需要从混合账单中强行拆分单请求积分。

## 2. 工作区与执行边界

实验在独立 Worktree 执行：

```text
D:\codex-zcode-bridge\.run\cost-lab-observability-ab-v2-20261117
codex/cost-lab-observability-ab-v2-20261117
```

只修改 `tools/cost-lab/`、其测试、测试影响映射和本报告。未修改生产 Bridge 认证、Provider
路由、Worker、Manager、SQLite Authority、Start Plan、Host Wake、Magpie 或官方安装文件。
未使用 Start Plan，未操作其他 Agent Worktree，未 merge、rebase、发布 Preview 或 Release。

真实请求预算：

```text
B_AUTHORIZED_TASKS: 1
B_REAL_TASKS: 1
B_MODEL_HTTP_REQUESTS: 2
AUTOMATIC_RETRIES: 0
ADDITIONAL_TASKS_AFTER_FAILURE: 0
```

第二个模型 HTTP 请求是官方自动产生的 `session_title` 辅助请求。它在主 Turn 完成后启动，
没有暴露 Usage，不能记成零，也不能据此再派发任务。

## 3. 网络入口与观测范围

### 3.1 目标进程清单

| Process role | 已知网络入口 | 观测方式 | 状态 |
|---|---|---|---|
| Bridge/实验 Harness | global fetch、Undici、`node:http`、`node:https` | preload、diagnostics_channel、HTTP wrapper | 已覆盖 |
| Bridge Worker | 同上 | 继承 `NODE_OPTIONS` preload | 目标已定义；本实验未启动独立 Worker |
| 官方 AppServer | bundled Undici、Node HTTP(S)、WebSocket | 官方 preload、Undici diagnostics、官方 `process/networkCapture` | 已覆盖本次实际路径 |
| Node Helper 子进程 | fetch、Undici、Node HTTP(S) | 继承 preload | 已覆盖实际出现的子进程 |
| ZCode Runtime Host Helper | 未发现 JavaScript 网络客户端 | 进程树与 AppServer 交叉核对 | `PROCESS_CONTROL_ONLY` |

浏览器、语音 WebSocket、MCP 远端连接不属于本次隔离 B 任务的实际请求集，均列为
`NOT_APPLICABLE`，没有用静态清单冒充运行时覆盖。

### 3.2 实时请求结果

本次 B 实验记录 5 条 Wire Request：

| 来源 | Method | Endpoint | 结果 |
|---|---|---|---|
| Harness | GET | `bigmodel.cn/api/biz/customer/getCustomerInfo` | 200 |
| Harness | GET | `bigmodel.cn/.../projects/{project_id}/api_keys` | 200 |
| Harness | POST | `bigmodel.cn/.../api_keys/{api_key_id}/access_tokens` | 200 |
| AppServer | POST | `zcode.z.ai/api/v1/ultra/anthropic/v1/messages` | 200，主 Turn，SSE，Usage 已观测 |
| AppServer | POST | `zcode.z.ai/api/v1/ultra/anthropic/v1/messages` | failed，`session_title`，Usage Missing |

主模型请求：

```text
HTTP method: POST
Provider: account:bigmodel-individual-coding-plan
Model: GLM-5.3-Flash
Query source: main_turn
HTTP status: 200
Transport: SSE
Stop reason: end_turn
Input: 13,544
Cached input: 0
Uncached input: 13,544
Output: 68
Total: 13,612
```

辅助请求：

```text
Query source: session_title
HTTP method: POST
Model: GLM-5.3-Flash
Request body: 1 message, 1 system block, 0 tools
Terminal state: failed
Usage: USAGE_NOT_EXPOSED
```

`session_title` 缺失 Usage，不能通过把残留 313 Token 强行锁定为该请求的精确单项 Usage
来消除缺口。官方小时桶可用于实验级聚合对账，但该请求级缺口仍为 Unknown。

### 3.3 覆盖修正

首次运行时，分类器只把路径中的 `/api/anthropic` 识别为模型端点，因此把实际
`/api/v1/ultra/anthropic/v1/messages` 标为 `other`，导致初始自动判定为 `PARTIAL`。
原始 Wire 记录本身已经包含 URL、Header、Body 结构、SSE Usage 和失败终态。

最终代码增加：

- `/anthropic` 任意合法路径段识别，包括 Ultra Gateway；
- 对官方 Capture 停止后才终止的失败请求，保留 preload-only 终态，但要求 Header、请求体、
  结束时间和失败状态齐全；
- 至少一个完成态 AppServer 请求必须由官方 Capture 独立匹配；
- 未解释的 preload-only 请求继续 fail closed。

使用同一批原始 Wire 文件离线重放后：

```text
PROBE_COVERAGE: COMPLETE
HTTP_METHOD_COVERAGE: COMPLETE
NON_MODEL_HTTP_COVERAGE: COMPLETE
RPC_COVERAGE: COMPLETE
IDENTITY_OBSERVABILITY: COMPLETE
AUXILIARY_USAGE_COVERAGE: PARTIAL_WITH_USAGE_MISSING
```

主模型请求与官方 `process/networkCapture` 记录在 23 ms 内匹配。第二个失败请求没有伪造
官方 Capture 记录，而是明确保留为 `failed_preload_only`。原始证据文件未被改写；重放结果
写入独立的 `network-evidence-reevaluated.json`。

## 4. RPC 与请求关联

本次记录 9 个结构化 RPC：

```text
provider/updateAccountConfig
session/create
session/requestRuntimePreferences
session/subscribe
session/send
interaction/requestProviderRuntimeHeaders
session/event:terminal
interaction/requestProviderRuntimeHeaders (session title)
```

两个模型 HTTP 请求都能回到成功的 `session/send` 时间窗口；运行前认证请求也能关联到
`interaction/requestProviderRuntimeHeaders`。主 Turn 的终止通知为：

```text
terminal_type: turn.completed
result_type: success
```

RPC 摘要只保存字段类型、数组长度和 allowlist 标量，不保存 Prompt、Tool 参数、Header Secret
或完整响应。

## 5. Identity 观测

Bridge 实际模型请求使用同一个 459 字符 Project Token 作为：

- `authorization: Bearer ...`
- `x-api-key`

两者本地指纹相同。JWT 只解析非秘密 Metadata：

```text
alg: HS256
iss: platform-biz
aud: wd-openapi
scope: NOT_EXPOSED
```

Host `requestAuth`、Wire `authorization`、Wire `x-api-key` 的本地指纹一致：

```text
API_KEY_PARITY: MATCH
API_KEY_ID_PARITY: MATCH
API_KEY_ID_TRANSPORT: PROJECT_PATH
ACCOUNT_SCOPE: HOST_OBSERVED
PROJECT_IDENTITY_PARAMETERS: OBSERVED
```

官方 before/after Snapshot 的 API Key ID、Organization ID、Project ID 保持稳定，并与 Project
Token 获取路径中的本地指纹匹配：

```text
SNAPSHOT_IDENTITY_STABLE: MATCH
ORGANIZATION_ID_PARITY: MATCH
PROJECT_ID_PARITY: MATCH
PROJECT_IDENTITY_PARITY: MATCH
```

这里证明的是 Bridge 内部“账单账户 → Project Token → 模型请求”身份链一致。它不证明 Native
实际使用了同一 Project Token、同一服务端权益上下文或同一优惠判定。

## 6. Native / Bridge 差异矩阵

| 字段 | Native 历史基线 | Bridge V2 B | 状态 |
|---|---|---|---|
| Provider | `account:bigmodel-individual-coding-plan` | 同左 | `MATCH` |
| Model | `GLM-5.3-Flash` | 同左 | `MATCH` |
| Account scope | personal | personal | `MATCH` |
| Usage scene | CODING_PLAN | CODING_PLAN | `MATCH` |
| Query source | main_turn | main_turn | `MATCH` |
| Model transport | SSE | SSE | `MATCH` |
| Provider kind | anthropic | anthropic | `MATCH` |
| Native 日志端点 | `open.bigmodel.cn/api/anthropic` | Wire 为 Ultra Gateway | `DIFFERENT / LOGICAL_EQUIVALENCE_UNKNOWN` |
| Runtime assembly | Desktop full Host services | isolated official AppServer | `DIFFERENT` |
| Messages | 5 | 2 | `DIFFERENT` |
| Tools | 58 | 21 | `DIFFERENT` |
| Native request auth | 未实时观测 | Project Token Wire 已观测 | `UNKNOWN` |
| API Key ID parity | Native 未观测 | 内部一致 | `UNKNOWN` |
| Project Token scope | Native 未观测 | scope 未暴露 | `UNKNOWN` |
| RPC sequence | 部分日志 | 9 个结构化 RPC | `DIFFERENT / COVERAGE_DIFFERENT` |
| Response entitlement fields | 未返回 | 未返回 | `UNKNOWN` |
| Auxiliary Usage | title 已观测，memory extract Missing | title Missing | `DIFFERENT` |
| Extra 0.67 | 约 0.67 | 1.0 | `DIFFERENT` |

Native 的 `endpoint_host/path` 来自 SQLite/Model I/O 日志；Bridge 的
`zcode.z.ai/api/v1/ultra/anthropic/v1/messages` 来自实际 Wire。官方 `3.18.2` 的
`official-coding-plan-gateway` 会把部分 Anthropic 基础端点映射到 Ultra Gateway。因此当前
只能证明“可观测端点层次不同”，不能证明 Native 与 Bridge 的最终上游 URL 不同。

请求体 Messages、Tools、辅助请求和 Runtime Assembly 都存在差异，但没有控制变量证据，不能把
其中任一项认定为优惠丢失根因。

## 7. 辅助请求与 Token 缺口

### 7.1 Native 历史基线

```text
Local main request:       27,186
Local session_title:         261
Local observed total:     27,447
project_memory_extract:   USAGE_MISSING
Official bucket:          55,686
Unattributed residual:    28,239
```

### 7.2 Bridge V2 B

```text
Local main request:       13,612
session_title:            USAGE_MISSING
Official bucket delta:    13,925
Residual:                    313
```

Bridge 的两个模型 HTTP 请求都在隔离实验中观测到，且没有其他已发现的模型请求。因此 313 Token
可以归入“本次实验的官方聚合流量”，但不能拆成可验证的请求级 Usage。优惠结论使用官方分类
聚合值计算，不依赖这一拆分。

## 8. 真实 B 实验

### 8.1 实验假设

```text
Hypothesis:
  完整 isolated official AppServer 装配会恢复 GLM-5.3-Flash 的额外 0.67 积分优惠。

Control:
  Native 历史同账户、同模型、personal Coding Plan，约 0.67。

Treatment:
  Bridge isolated official AppServer，单变量为官方完整装配路径。

Expected observation:
  official effective extra ratio 约 0.67。
```

### 8.2 时间窗口

所有时间均为 Asia/Shanghai：

```text
2026-11-17 18:02:50  before snapshot, 18:00 目标桶为零
2026-11-17 18:02:16  零计费 protocol smoke PASS
2026-11-17 18:06:56  B 实验开始
2026-11-17 18:07:03  main model HTTP 开始
2026-11-17 18:07:11  main model HTTP 完成
2026-11-17 18:07:11  session_title HTTP 启动后失败
2026-11-17 18:07:11  Turn terminal: turn.completed / success
2026-11-17 18:10:01  首次 after snapshot，仍为零
2026-11-17 18:12:18  结算后 after snapshot，官方桶已更新
```

首次 after 快照没有强行使用零值作为结果。有限等待后，第二次 after 快照取得已结算数据。

### 8.3 运行门禁

```text
EXECUTION_GATE: PASS
SAFETY_GATE: PASS
NETWORK_GATE: PASS (same raw evidence offline reevaluation)
CLEANUP: PASS
SHARED_STATE_UNCHANGED: PASS
HOST_WAKE: PASS
MANAGED_PROCESSES_AFTER: 0
OWNED_PIDS_STILL_ALIVE: 0
```

共享状态监控 14 个文件，无持久变化。官方瞬时 Keyring Lock 只按批准语义出现并释放。

## 9. 官方账单对账

### 9.1 官方分类增量

```text
Billing date:             2026-11-17
Billing hour:             18
Peak window:              NO
Time multiplier:          0.5
Cached input:             192
Uncached input:           13,654
Output:                   79
Total tokens:             13,925
Total credits:            1.6072
Cached input credits:     0.0054
Uncached input credits:   1.5702
Output credits:           0.0316
```

分类积分合计：

```text
0.0054 + 1.5702 + 0.0316 = 1.6072
```

Token 分类合计：

```text
192 + 13,654 + 79 = 13,925
```

### 9.2 理论积分

```text
BASE_CREDITS =
  (13,654 × 2.3 + 192 × 0.56 + 79 × 8) / 10,000
  = 3.214372

OFF_PEAK_NORMAL =
  3.214372 × 0.5
  = 1.607186

WITH_0_67 =
  1.607186 × 0.67
  = 1.07681462

ACTUAL =
  1.6072

EFFECTIVE_EXTRA_RATIO =
  1.6072 / 1.607186
  = 1.0000087108772724
```

判定：

```text
BRIDGE_DISCOUNT: FAIL
```

实际积分与“非高峰 0.5 倍、无额外优惠”的理论值相差 `0.000014` Credits；远低于 0.67
路径的 `1.07681462`。本小时无其他模型 Bucket 活动，before 桶为零，after 已结算，因此聚合
窗口足以否定“本轮 Bridge 取得 0.67”。

## 10. 根因判断

可以确认：

1. Bridge 内部的 Billing Account、Project Token 路径和模型请求身份链一致。
2. 官方账单明确显示本轮 Bridge 没有取得额外 0.67。
3. Native 历史对账明确显示另一窗口取得约 0.67。
4. Native 与 Bridge 在 Runtime 装配、请求结构、可观测端点和辅助请求上存在差异。

不能确认：

1. Native 实际发送到服务端的 Project Token、API Key ID 和 Endpoint 与 Bridge 完全相同。
2. 服务端是否使用了不同的隐藏权益上下文。
3. Messages、Tools、`session_title`、RPC 序列或 Host 服务中的哪一项与优惠判定存在因果关系。
4. 是否存在某个合法客户端装配字段能够恢复优惠。

因此：

```text
ROOT_CAUSE: UNKNOWN
ROOT_CAUSE_CONFIDENCE: LOW
```

当前证据不支持修改生产认证、Header、设备身份或路由来尝试“修复”优惠。

## 11. 构建与测试

Build provenance：

```text
OFFICIAL_VERSION: 3.18.2
OFFICIAL_COMMIT: fec975905a2abd4c07e35c40d51fa097a2258ec9
OFFICIAL_TREE: 5e90fec80706b8381f94e4eef48cf821b9868916
PATCH_BYTES: 23,004
PATCH_SHA256: 723983FBDA9803BD5970F6A93A442E79896281D87B11A83A58AFEF06DF24D9F0
BUNDLE_BYTES: 1,672,078
BUNDLE_SHA256: 4414B2436D26F7D6D0467C69FFA182C25496A4E3453FF8AFE8F9D8D7D9129E62
REPRODUCIBLE_BUILD: PASS (2 builds, BYTE_IDENTICAL)
PRODUCTION_BUNDLE_EXCLUDED: PASS
```

定向测试覆盖：

- fetch / bundled Undici / Node HTTP(S) / SSE / failure / timeout / redirect；
- 官方 Ultra Anthropic Gateway 路径分类；
- 官方 Capture 与 preload 双向关联；
- 已解释失败 preload-only 与未解释预加载请求的 fail-closed 边界；
- RPC request/response shape 与 HTTP 时间关联；
- Project path、API Key、API Key ID、Account scope 指纹；
- 官方账单 Snapshot 当前 schema、小时桶和辅助 Usage 缺失时的聚合对账；
- 输出路径、Secret redaction、官方 Runtime 来源和 Bundle Hash。

定向 Cost Lab 测试：

```text
tests:   72
pass:    72
fail:     0
```

受影响全量回归：

```text
npm run test:affected -- --base origin/preview
tests: 995
pass:  993
skip:    2
fail:    0
result: FULL_REGRESSION_PASS
```

## 12. Git 与远程

```text
BASE_COMMIT: 4aae0fc12ae6bac6eff9865d3f59d4036ef64b3a
LOCAL_COMMIT: PENDING
LOCAL_TREE: PENDING
REMOTE_PUSH: PENDING
REMOTE_TREE_MATCH: PENDING
```

本轮只创建独立实验提交和独立远程分支。`MERGE: NO`、`PREVIEW: NO`、`RELEASE: NO`。

## 13. 尚未解决的问题

1. Native 历史基线缺少实时 Wire、Project Token 和 API Key 身份证据。
2. 官方没有返回可记录的优惠 Campaign / Entitlement 判定字段。
3. `session_title` 的请求级 Usage 仍为 `USAGE_MISSING`；实验级官方聚合已经对账，但无法精确
   拆分该请求的 Token。
4. Native `project_memory_extract` 的 28,239 Token 缺口仍只能作为聚合残差。
5. 请求结构、Runtime 装配和上游 Endpoint 差异都只能作为候选比较项，不能作为根因。

若后续继续调查，下一个有判别价值的最小步骤不是修改 Bridge，而是在独立账单窗口对 Native 做
一次同等级的实时 Wire/Identity 捕获，验证 Native 最终 Endpoint、Project Token、API Key ID、
辅助请求和 RPC 上下文。没有这项对照，继续调整 Bridge 认证或 Header 没有证据基础。

## 14. 最终状态

```yaml
GOAL: COST_LAB_COMPLETE_OBSERVABILITY_AND_BRIDGE_AB_V2

NETWORK_INVENTORY: COMPLETE
HTTP_COVERAGE: COMPLETE
RPC_COVERAGE: COMPLETE
IDENTITY_OBSERVABILITY: COMPLETE
AUXILIARY_USAGE_COVERAGE: PARTIAL_WITH_USAGE_MISSING

SYNTHETIC_E2E: PASS
REPRODUCIBLE_BUILD: PASS
PRODUCTION_BUNDLE_EXCLUDED: PASS

NATIVE_BASELINE_REUSED: YES
DSH_INVESTIGATION: NOT_IN_SCOPE

BRIDGE_REAL_AB: PASS
BILLING_RECONCILIATION: PASS
BRIDGE_DISCOUNT: FAIL
ROOT_CAUSE: UNKNOWN
ROOT_CAUSE_CONFIDENCE: LOW

PRODUCTION_CODE_CHANGED: NO
PRODUCTION_AUTH_CHANGED: NO
PREVIEW: NO
RELEASE: NO

LOCAL_COMMIT: PENDING
REMOTE_PUSH: PENDING

NEXT_ACTION: CAPTURE_EQUIVALENT_NATIVE_WIRE_AND_IDENTITY_IN_A_CLEAN_BILLING_WINDOW
```
