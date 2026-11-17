# Cost Lab Discount Causal Probe V4

> Status: RESEARCH
> Date: 2026-11-17
> Branch: `codex/cost-lab-discount-causal-v4-20261117`
> Base: `c13c4ac941a661d04b92d4acf23818a578f2dbac`
> Base tree: `dc9bffa5edb7f1716a55247a6e3837c8f59b7aec`
> Official source: ZCode `3.18.2`, commit
> `fec975905a2abd4c07e35c40d51fa097a2258ec9`, tree
> `5e90fec80706b8381f94e4eef48cf821b9868916`
> Security boundary: no credential contents were copied or committed; only
> sanitized fingerprints and metadata are retained in ignored `.run/` evidence

## 1. 最终结论

| 项目 | 结果 | 证据边界 |
|---|---|---|
| 官方源码定向调查 | `COMPLETE` | 只调查优惠相关装配、Device MID、Project location、Gateway 与请求结构 |
| Hypothesis Ledger | `COMPLETE` | `tools/cost-lab/HYPOTHESIS_LEDGER.md` |
| Variant Harness | `PASS` | 支持 baseline、Project location cache、official Device MID |
| 官方 Billing Reader | `PASS` | 可取得 fresh before/after，并在 11 分钟后观察到 `23:00` 桶结算 |
| H1 Project location cache | `FAIL` | 实跑确认 cache hit，但额外倍率为 `1.0000031421` |
| H3 official Device MID | `FAIL` | 复用真实官方 Device MID 后，额外倍率为 `0.9999719179` |
| Bridge discount | `FAIL` | 两个已实跑的 V4 变体均得到约 `1.0`，不是 `0.67` |
| Discount trigger | `UNKNOWN` | 已排除两个单变量候选，但未找到可复现触发条件 |
| Discount trigger reproduced | `NOT_APPLICABLE` | 没有任何变体首次获得 `0.67` |
| Root cause | `UNKNOWN` | 剩余候选未形成可执行单变量实验 |
| Production code changed | `NO` | 只修改 Cost Lab 与报告 |

本轮没有为了追求 PASS 而继续随机修改 Header、身份或请求结构。两个真实 V4
变体各只执行一次任务；没有人工重试，也没有因账单延迟而重发模型请求。

## 2. 固定基线与工作区

本地 Worktree：

```text
D:\codex-zcode-bridge\.run\cost-lab-discount-causal-v4-20261117
```

固定输入：

```yaml
ACCOUNT: personal
PLAN: CODING_PLAN
PROVIDER: account:bigmodel-individual-coding-plan
MODEL: GLM-5.3-Flash
REASONING: low
QUERY_SOURCE: main_turn
TIMEZONE: Asia/Shanghai
```

未修改生产 Bridge 认证、Provider 路由、Worker、Manager、SQLite Authority、
Magpie、Host Wake、Start Plan、Desktop 安装目录、登录态或持久凭据。

## 3. 官方活动证据

匿名 client-config 请求采集于 `2026-11-17T22:33:43+08:00`，HTTP 状态为
`200`。返回的活动文案仍声明：

```text
用户在 ZCode 中通过 Coding Plan 调用模型时，
额度消耗全周期按 0.67 系数折算。
```

文案同时把该活动描述为约 `150%` 套餐额度。此证据确认活动在采集时仍然公开，
但响应没有提供模型白名单、账户白名单、生效时间或服务端执行字段，因此不能单独
证明某个请求实际获得优惠。

## 4. H1：Project location cache

### 4.1 单变量

```yaml
BASELINE_VARIANT: fixture-local Project location map
CHANGED_COMPONENT: persistent official project-key-location cache read-only
UNCHANGED_COMPONENTS:
  - official OAuth and Project Token path
  - Provider and model
  - isolated Device MID behavior
  - prompt, tools and billing scene
EXPECTED_DELTA: restore Native project-key location context
ACTUAL_DELTA: no discount
BILLING_RESULT: FAIL
CAUSALITY_STATUS: SINGLE_VARIABLE_EXERCISED
```

### 4.2 实跑证据

```text
Time: 2026-11-17 22:07:26-22:07:38 Asia/Shanghai
Request ID: msg_20261117220730729d503e66c34be1
Runtime usage: input 13,431, output 20, total 13,451
Project location loads: 1
Project location cache hits: 1
Project location cache misses: 0
Project location writes: 0
```

官方 `22:00` 桶：

```text
Cached input: 0
Uncached input: 13,733
Output: 30
Actual credits: 1.5913
```

对账：

```text
BASE = (13733 * 2.3 + 30 * 8) / 10000
     = 3.18259

EXPECTED_NORMAL = 3.18259 * 0.5
                = 1.591295

EFFECTIVE_EXTRA_RATIO = 1.5913 / 1.591295
                      = 1.0000031421
```

结论：目标 cache 读取真实发生，但账单仍按 `1.0` 额外倍率计算。Project
location cache 不是 `0.67` 开关。该假设不再重复测试。

## 5. H3：Official Device MID

### 5.1 单变量

```yaml
BASELINE_VARIANT: fixture-generated Device MID
CHANGED_COMPONENT: authentic Device MID reused from official telemetry state
UNCHANGED_COMPONENTS:
  - in-memory Project location behavior
  - official OAuth, Project Token and Request Auth services
  - Provider, model, account and billing scene
  - prompt, reasoning, tools and AppServer lifecycle
EXPECTED_DELTA: official Device MID reaches source headers and metadata.user_id
ACTUAL_DELTA: no discount
BILLING_RESULT: FAIL
CAUSALITY_STATUS: SINGLE_VARIABLE_EXERCISED
```

Harness 只从官方
`${ZCODE_DATA_BASE_DIR}/.zcode/v2/telemetry-state.json` 读取已有 `deviceMid`，
写入隔离 fixture 的相同官方 schema。原始值未提交，证据只保留 SHA-256
fingerprint；运行结束后隔离 fixture 中的原始 Device MID 文件被删除。

### 5.2 Zero-billing gates

```text
Protocol smoke: PASS
Model requests: 0
Device mode: OFFICIAL_DEVICE_MID_REUSED
Device fingerprint: MATCH with unchanged official telemetry state
AppServer lifecycle: PASS
Shared state unchanged: PASS
Keyring lock release: PASS
Host Wake: PASS
Cleanup: PASS
Device fixture cleanup: PASS
```

### 5.3 Clean-window real task

```text
Billing date/hour: 2026-11-17 23:00 Asia/Shanghai
Off-peak: true
Before: 23:00:24, target bucket 0 tokens and 0 credits
Task: 23:01:08-23:01:18
After: 23:11:55, target bucket settled
Real main tasks: 1
Automatic retries: 0
```

两个模型 HTTP 请求均由同一任务自动产生：

| Request | Source | Result | Usage |
|---|---|---|---|
| `msg_2026111723011188684834b2524bc0` | `main_turn` | HTTP `200`, completed | input `13,441`, output `37` |
| title request `f68dd93d-0acf-4787-8d00-7f4100c449d7` | `session_title` | cancelled during shutdown | `USAGE_MISSING` |

官方 `23:00` 桶：

```text
Cached input: 0
Uncached input: 13,743
Output: 55
Total: 13,798
Credits: 1.6024
```

相对主请求的差值为：

```text
Uncached input residual: 302
Output residual:       18
Total residual:        320
```

该小时桶在 before 时为零。After 快照中只有 `GLM-5.3-Flash` 的 `23:00` 桶
发生变化，没有其他模型小时桶增量。唯一额外请求是自动 `session_title` 请求；
其时间线和 Token 残差与差值相容。由于该请求在关闭阶段被取消，没有请求级
Usage，因此 `302/18` 不能单独提升为请求级 `CONFIRMED`，但整个干净小时桶仍可
作为本次单一任务的任务级官方账单。

### 5.4 积分对账

```text
BASE =
  (13743 * 2.3 + 55 * 8) / 10000
  = 3.20489

EXPECTED_WITHOUT_EXTRA_DISCOUNT =
  3.20489 * 0.5
  = 1.602445

EXPECTED_WITH_0_67 =
  1.602445 * 0.67
  = 1.07363815

ACTUAL =
  1.6024

EFFECTIVE_EXTRA_RATIO =
  1.6024 / 1.602445
  = 0.9999719179
```

官方未发生 `0.67` 折算。该结论不依赖把 `302/18` 精确拆分到 title 请求：无论
按主请求还是按整个干净任务桶计算，实际积分都没有接近 `0.67` 应有的结果。

## 6. 身份与渠道证据

本次任务的目标身份一致：

```text
Provider: account:bigmodel-individual-coding-plan
Model: GLM-5.3-Flash
Account scope: personal
Usage scene: CODING_PLAN
```

Before/after 快照中的 API Key ID、organization 和 project identity 均稳定且
匹配；网络证据也报告 API Key/API Key ID parity 为 `MATCH`。这不等于优惠资格
成立，只排除了同一任务中被错误路由到另一个可见项目的情况。

官方安装版源码将精确的 BigModel Anthropic `/v1/messages` 流量映射到 Ultra
Gateway。Bridge 观测到的
`/api/v1/ultra/anthropic/v1/messages` 因此是预期官方路由，而不是已验证的
Bridge 特有偏离。Gateway 假设降级，未单独消耗真实请求。

## 7. 假设状态

| ID | 假设 | 状态 | 说明 |
|---|---|---|---|
| H1 | Persistent Project location cache | `FAIL` | cache hit 已实际发生，仍为 `1.0` |
| H2 | Full official account-auth composition | `DEFERRED` | resolver-only 不是独立完整装配；需要真正不同的服务图 |
| H3 | Official Device MID divergence | `FAIL` | 真实官方 Device MID 已复用，仍为 `1.0` |
| H4 | Gateway selection | `DOWNGRADED` | Ultra Gateway 是官方映射，缺少 Bridge 特有指令证据 |
| H5 | Messages/tools structure | `NOT TESTED` | 与上下文和 Token 大小混杂，当前置信度低 |

因此当前不能把剩余差异归因于某个单一组件。特别是，不能再把“生产 Bridge
复用真实 ZCode 数据根”当作优惠成立依据；官方 Device MID 相同并不足以获得
`0.67`。

## 8. 数据完整性、局限与剩余疑点

- 官方账单是小时聚合，不是逐请求账单。
- 干净窗口中只有一个真实任务，且任务内仅有两个自动模型 HTTP 请求，因此可以做
  任务级归因。
- `session_title` 请求在 AppServer 关闭时取消，Usage 缺失；官方小时桶多出的
  `302` input 和 `18` output Token 与该请求相容，但无法独立取得其响应 Usage。
- 没有重新执行 Native 对照，也没有为了寻找优惠继续随机改变请求。
- 官方活动文案仍存在，不代表当前账户、模型或该 Bridge 请求已被服务端授予活动。
- H2/H5 不是已被否定，而是证据不足以支持下一轮单变量真实试验。

## 9. 测试

已运行：

```text
node --check tools/cost-lab/official-assembly-live-probe.mjs
node --check tools/cost-lab/test/official-assembly-live-probe.test.mjs
node --test tools/cost-lab/test/official-assembly-live-probe.test.mjs
node --test tools/cost-lab/test/*.test.mjs
git diff --check
```

定向测试为 `18/18 PASS`；完整 Cost Lab 测试为 `81/81 PASS`。覆盖 Project
location 只读策略、Device MID 复用与清理、variant 参数、共享状态比较、账单
窗口验证、小时换算、辅助请求 Usage Missing 和优惠对账。

完整 CI、全量回归、Windows/Ubuntu matrix、压力测试和 Release gate 按本轮
Goal 明确暂缓，不把定向测试表述为完整 CI PASS。

## 10. 结论与下一步

```yaml
GOAL: COST_LAB_DISCOUNT_CAUSAL_PROBE_V4

OFFICIAL_SOURCE_RESEARCH: COMPLETE
HYPOTHESIS_LEDGER: COMPLETE
VARIANT_HARNESS: PASS
BILLING_READER: PASS
BRIDGE_BASELINE:
  EFFECTIVE_RATIO: 1.0
  STATUS: CONFIRMED_FROM_EXISTING_EVIDENCE
NATIVE_CONTROL:
  EFFECTIVE_RATIO: 0.67
  STATUS: HISTORICAL_CONTROL
VARIANT_A_PROJECT_LOCATION: FAIL
VARIANT_B_GATEWAY: DOWNGRADED
VARIANT_C_REQUEST_AUTH: DEFERRED
VARIANT_D_DEVICE_MID: FAIL
VARIANT_E_REQUEST_STRUCTURE: NOT_TESTED
DISCOUNT_TRIGGER: UNKNOWN
DISCOUNT_TRIGGER_REPRODUCED: NOT_APPLICABLE
ROOT_CAUSE: UNKNOWN
ROOT_CAUSE_CONFIDENCE: LOW
PRODUCTION_CODE_CHANGED: NO
PRODUCTION_AUTH_CHANGED: NO
PRODUCTION_ROUTING_CHANGED: NO
MAGPIE_CHANGED: NO
HOST_WAKE_CHANGED: NO
START_PLAN_CHANGED: NO
FULL_CI: DEFERRED
```

下一步若继续，应设计一个真正不同于现有 minimal helper 的官方完整
account-auth/Local Services 装配，并把它拆成可观测的单变量增量；或者先取得能
直接证明服务端权益上下文的官方证据。当前不建议修改生产 Bridge、复制更多身份
字段，或通过 Header/Device MID 随机试探来追求 `0.67`。
