# Cost Lab Full Probe and Bridge A/B

> Status: RESEARCH
> Date: 2026-11-17
> Branch: `codex/cost-lab-native-control-20261117`
> Base: `02cf2fa92c8235370fe7a883d4c5b30d93a8ab33` (`origin/preview`)
> Official source: ZCode `3.18.2`, commit
> `fec975905a2abd4c07e35c40d51fa097a2258ec9`, tree
> `5e90fec80706b8381f94e4eef48cf821b9868916`
> Evidence class: Clean-source deterministic build、被动请求探针、既有 Native/Bridge 请求证据、
> 官方机器可读 Coding Plan 小时账单、离线对账与全量回归
> Security boundary: 未输出 Authorization、Cookie、JWT、Project Token、凭据密文或完整 API Key

## 1. 最终结论

| 项目 | 结论 | 证据边界 |
|---|---|---|
| Cost Lab 工程门禁 | `PASS` | `npm run test:affected -- --base origin/preview` 完整通过 |
| 官方 Billing Runtime 来源 | `PASS` | 固定 clean source commit/tree、固定 Patch、可校验依赖锁 |
| 可复现构建 | `PASS` | 两次独立构建字节一致，Bundle SHA-256 相同 |
| 生产 Bundle 隔离 | `PASS` | Cost Lab 不在生产 package/plugin 构建输入中 |
| 被动请求 Probe | `PARTIAL` | 增加模型生命周期、endpoint、status、transport、响应标识和 RPC 摘要；认证 HTTP 仍未观测 |
| Official Billing Access | `PASS` | fresh snapshot 于 `2026-11-17 14:48:51 Asia/Shanghai` 成功取得 |
| Native 官方账单对账 | `PASS` | 12:00 桶 Token 精确匹配，实际倍率 `0.6699917496767714` |
| Bridge clean-window B 对账 | `PASS` | 10:00 桶 Token 精确匹配，实际积分 `1.5491` |
| Bridge 获取额外 0.67 优惠 | `FAIL` | 实际有效倍率 `1.000027758823594`，与未优惠理论值一致 |
| Native / Bridge 渠道差异 | `FAIL` | 两端的可见请求元数据和运行时装配不同，优惠结果也不同 |
| 差异根因 | `UNKNOWN` | 未观测到请求级 Project Token/API Key entitlement 或服务端权益字段 |
| 根因置信度 | `LOW` | 不能把请求结构或 Runtime 差异提升为因果结论 |

本轮没有为重复观察再发起真实模型请求。已有一个可唯一归因的 Bridge B 请求和一次 Native
请求，足以完成本轮 Token 与积分对账；额外调用不会提高当前证据的判别力。

## 2. 工作区与执行边界

本任务在独立 Worktree 执行：

```text
D:\codex-zcode-bridge\.run\cost-lab-native-control-20261117
codex/cost-lab-native-control-20261117
```

本轮变更仅位于 `tools/cost-lab/`、其测试与 README，以及本报告。未修改生产 Bridge 认证、
模型路由、Worker、Manager、SQLite Authority、Start Plan、Host Wake 或 Magpie。未 push、
merge、rebase、创建 PR 或发布 Preview。

真实调用预算的使用情况：

```text
EXISTING_BRIDGE_CLEAN_B_REUSED: 1
BRIDGE_REAL_TASKS_THIS_ROUND: 0
REAL_MODEL_REQUESTS_THIS_ROUND: 0
ADDITIONAL_CREDITS_USED: 0
EXPERIMENT_VARIANT: NONE_SELECTED
```

## 3. ENOSPC 解除与空间状态

上一轮 `test:affected` 在 build 阶段因 D 盘空间耗尽而阻断。已有会话记录只确认：

```text
2026-11-17 约 13:16: D 盘剩余空间约 0.009 GB
2026-11-17 约 13:40: D 盘剩余空间恢复到约 6.00 GB
```

当前核验结果：

```text
D: used 104.32 GB
D: free   5.68 GB
```

没有足够证据确认当时具体删除的目录，因此本报告不把任何清理路径写成已核实事实。空间恢复后，
本轮正式 `test:affected` 已完整执行并通过。

此外，上一轮 sparse checkout 未物化 `.github/workflows/ci.yml`，导致唯一一个仓库策略测试
失败。本轮先执行 `git sparse-checkout add .github`，随后完整测试通过。

## 4. Clean-source 可复现构建

新增：

```text
tools/cost-lab/build-official-billing-runtime.mjs
tools/cost-lab/vendor/patches/cost-lab-billing-runtime.patch
tools/cost-lab/vendor/patches/cost-lab-billing-runtime.patch.sha256
```

构建脚本在开始前强制校验：

- Source version 为 ZCode `3.18.2`；
- HEAD 为 `fec975905a2abd4c07e35c40d51fa097a2258ec9`；
- HEAD tree 为 `5e90fec80706b8381f94e4eef48cf821b9868916`；
- Source worktree 无 tracked 或 untracked 变更；
- Node 为 `v24.16.0`；
- esbuild 为 `0.28.2`。

构建过程创建临时 detached worktree，只应用固定 Patch，并在打包前断言工作区变更路径集合恰好为
Patch 声明的五个文件。完成后反向应用 Patch、清理临时链接并移除临时 worktree。

固定证据：

```text
PATCH_BYTES:   23,004
PATCH_SHA256:  723983FBDA9803BD5970F6A93A442E79896281D87B11A83A58AFEF06DF24D9F0
BUNDLE_BYTES:  1,672,078
BUNDLE_SHA256: 4414B2436D26F7D6D0467C69FFA182C25496A4E3453FF8AFE8F9D8D7D9129E62
```

Build-g 与 build-h 的 Bundle SHA-256 均为
`4414B2436D26F7D6D0467C69FFA182C25496A4E3453FF8AFE8F9D8D7D9129E62`：

```text
REPRODUCIBLE_BUILD: PASS
```

Patch 只包含 Cost Lab billing facade、最小只读 Credential 选项和 Runtime entry。完整来源、
依赖锁、Patch/Bundle Hash、Keyring 版本、只读 Guard 和可复现性记录在
`tools/cost-lab/vendor/BUILD_PROVENANCE.json`。

## 5. Probe 覆盖

### 5.1 新增能力

本次将模型生命周期事件按 `requestId` 合并，并增加：

- endpoint host / path；
- HTTP status、method 的已知或 `UNKNOWN` 状态；
- model transport 与 provider kind；
- Provider response ID；
- allowlist 内的响应 Header 名和值；
- `ttft.model.request_started`、response headers、completed、failed 等生命周期摘要；
- `zcode_protocol.*` 的 started/completed/failed 事件级摘要，不保留 payload；
- `HTTP_ENDPOINT_COVERAGE`、`HTTP_STATUS_COVERAGE`、`RPC_COVERAGE` 和
  `NON_MODEL_HTTP_COVERAGE`。

失败的辅助模型请求保留 `USAGE_MISSING`，不会因为失败或日志 Usage 被脱敏就写成零。

### 5.2 当前覆盖边界

```text
PROBE_COVERAGE: PARTIAL
MODEL_REQUEST_COVERAGE: SQLITE_MODEL_IO_AND_LOG
AUTH_METADATA_COVERAGE: NOT_OBSERVED
NON_MODEL_HTTP_COVERAGE: NOT_OBSERVED
RPC_COVERAGE: LIFECYCLE_PARTIAL
HTTP_METHOD_COVERAGE: NOT_OBSERVED
```

仍未观测：

- Account、OAuth、Project、Token 等非模型 HTTP；
- RPC request / response payload；
- HTTP method；
- Native `project_memory_extract` 的请求级 Usage；
- 请求级 Project Token scope、API Key entitlement 和服务端优惠判定字段。

### 5.3 现有证据重放

Bridge clean-window B：

```text
model HTTP attempts:       2
confirmed main HTTP:       1, status 200
session_title attempts:    1, failed, USAGE_MISSING
persisted usage tokens:    13,402
retry attempts:            0
```

Native baseline：

```text
model HTTP attempts:       3
main HTTP:                 1, status 200
session_title:             1, usage observed
project_memory_extract:    1, USAGE_MISSING
persisted usage tokens:    27,447
retry attempts:            0
```

两端主请求均为：

```text
endpoint:      open.bigmodel.cn/api/anthropic
transport:     sse
provider kind: anthropic
HTTP status:   200
```

## 6. 官方账单快照

Fresh snapshot：

```text
file:        .run/fresh-billing-20261117T1447.json
captured_at: 2026-11-17T06:48:51.272Z
local time:  2026-11-17 14:48:51 Asia/Shanghai
provider:    account:bigmodel-individual-coding-plan
plan scope:  personal
quota level: lite
model:       GLM-5.3-Flash
```

当日 14:48 的聚合值：

```text
total tokens:  66,606,449
total credits: 2,089.628
```

关键小时桶：

| 桶 | Cached Input | Uncached Input | Output | Total Token | Cached Credits | Uncached Credits | Output Credits | Total Credits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 10:00 | 64 | 13,291 | 47 | 13,402 | 0.0018 | 1.5285 | 0.0188 | 1.5491 |
| 12:00 | 0 | 55,658 | 28 | 55,686 | 0 | 4.2884 | 0.0075 | 4.2959 |
| 14:00 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

14:00 桶在抓取时为零，只用于证明 fresh snapshot 成功和采集时间，不作为真实调用窗口。

用户补充的当前工作日峰谷规则为：`14:00-17:59 Asia/Shanghai` 为峰时，峰时消耗是非高峰的
两倍。Cost Lab 当前以 `off_peak_multiplier=0.5`、`peak_multiplier=1.0` 表达同一规则；本轮
10:00 与 12:00 均为非高峰。

## 7. 请求级时间线

时区均为 `Asia/Shanghai`。

### 7.1 Bridge clean-window B

```text
session:  sess_47c08f1c-1ff0-419a-9ab5-01e977d1a605
turn:     turn_0eb5056d-65ef-4a64-a50f-158706740359
trace:    9315497b-c685-4a6d-b7d2-aaa65781691d
```

| 请求 | Query Source | 开始 / 完成 | Input | Cached | Uncached | Output | Total | 状态 |
|---|---|---|---:|---:|---:|---:|---:|---|
| `461f8490-9a43-4abe-b26f-0fa8543766c2` | `main_turn` | 10:14:05.332 / 10:14:12.848 | 13,355 | 64 | 13,291 | 47 | 13,402 | HTTP 200 |
| `8674ea99-6900-49da-90e4-bb3705a7e087` | `session_title` | 10:14:12.887 / 10:14:12.910 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | failed, `USAGE_MISSING` |

### 7.2 Native baseline

```text
session:  sess_76ea7052-7fdc-413c-a4fa-f6514a1f652c
turn:     turn_a0e18493-939f-48b0-a9b6-593d8af84d13
trace:    664afdd7-7448-459d-ac64-993cb2a8c7d2
```

| 请求 | Query Source | 开始 / 完成 | Input | Cached | Uncached | Output | Total | 状态 |
|---|---|---|---:|---:|---:|---:|---:|---|
| `33c73b56-5b37-43af-9be6-909f88d3e91b` | `main_turn` | 12:24:04.200 / 12:24:10.701 | 27,177 | 0 | 27,177 | 9 | 27,186 | HTTP 200 |
| `f09af1b7-01a7-4a74-b1e9-ae1d3769f2f3` | `session_title` | 12:24:10.779 / 12:24:12.399 | 248 | 0 | 248 | 13 | 261 | completed |
| `54a70c98-c359-4624-9d6f-6a780a05e6d2` | `project_memory_extract` | 12:24:10.805 / 12:24:16.200 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | `USAGE_MISSING` |

## 8. 官方积分对账

### 8.1 Bridge clean-window B

本地 Runtime Usage 与 10:00 官方桶的 Token 分类完全一致：

```text
cached input:      64
uncached input: 13,291
output:            47
total:         13,402
```

10:00 为非高峰：

```text
BASE_CREDITS
  = (13,291 * 2.3 + 64 * 0.56 + 47 * 8) / 10,000
  = 3.098114

WITHOUT_0.67
  = 3.098114 * 0.5
  = 1.549057

WITH_0.67
  = 1.549057 * 0.67
  = 1.03786819

ACTUAL
  = 1.5491

EFFECTIVE_EXTRA_DISCOUNT_RATIO
  = 1.5491 / 1.549057
  = 1.000027758823594
```

官方四位小数与理论未优惠值的差异为 `0.000043`；与 0.67 理论值明显不符：

```text
BRIDGE_DISCOUNT: FAIL
BILLING_RECONCILIATION: PASS
```

### 8.2 Native baseline

12:00 桶：

```text
BASE_CREDITS
  = (55,658 * 2.3 + 28 * 8) / 10,000
  = 12.82374

WITHOUT_0.67
  = 12.82374 * 0.5
  = 6.41187

WITH_0.67
  = 6.41187 * 0.67
  = 4.2959529

ACTUAL
  = 4.2959

EFFECTIVE_EXTRA_DISCOUNT_RATIO
  = 4.2959 / 6.41187
  = 0.6699917496767714
```

Native 本窗口可靠取得额外 0.67：

```text
NATIVE_DISCOUNT: PASS
BILLING_RECONCILIATION: PASS
```

`project_memory_extract` 的精确 Usage 未持久化，因此本地请求字段不能解释桶内全部残差；
但官方 Token 分类和积分分类可以与 12:00 聚合桶整体精确对账。结论只适用于该账号、该模型和
该小时窗口。

## 9. Native / Bridge 差异矩阵

| 项目 | Native baseline | Bridge clean-window B |
|---|---|---|
| Provider | `account:bigmodel-individual-coding-plan` | 同左 |
| Model | `GLM-5.3-Flash` | 同左 |
| Query Source | `main_turn` | 同左 |
| Reasoning | `low` | 同左 |
| Account Scope | personal | personal |
| Usage Scene | `CODING_PLAN` | 同左 |
| Endpoint | `open.bigmodel.cn/api/anthropic` | 同左 |
| Transport | SSE | SSE |
| Provider Kind | anthropic | anthropic |
| Runtime 边界 | Native Desktop full Host services | isolated official AppServer B assembly |
| 主请求 messages / tools | 5 / 58 | 7 / 21 |
| 辅助请求序列 | title observed + memory extract missing | title failed, missing usage |
| 本地可持久化 Token | 27,447 | 13,402 |
| 官方桶 Token | 55,686 | 13,402 |
| 实际积分 | 4.2959 | 1.5491 |
| 有效倍率 | 0.6699917496767714 | 1.000027758823594 |
| 优惠结果 | `PASS` | `FAIL` |

身份边界：

```text
PROJECT_IDENTITY_PARITY: SUPPORTED_IDENTICAL
API_KEY_ID_PARITY: UNKNOWN
ACCOUNT_SCOPE_PARITY: MATCH
USAGE_SCENE_PARITY: MATCH
QUERY_SOURCE_PARITY: MATCH
VISIBLE_SAFE_HEADER_PARITY: SUPPORTED_IDENTICAL
REQUEST_STRUCTURE_DELTA: Native 5 messages / 58 tools; Bridge 7 / 21
RUNTIME_TRANSPORT_ASSEMBLY: DIFFERENT
```

`PROJECT_IDENTITY_PARITY: SUPPORTED_IDENTICAL` 只覆盖本地可核实的账户配置和官方账单身份，
不等于请求级 Project Token、API Key entitlement 或服务端权益上下文已经一致。

## 10. 根因判断

当前最可信的描述是：

```text
ROOT_CAUSE:
  UNKNOWN_SERVER_SIDE_OR_UNOBSERVED_PROJECT_IDENTITY_CONTEXT
ROOT_CAUSE_CONFIDENCE: LOW
```

支持的候选方向：

1. 服务端把优惠绑定到本地日志未暴露的 Project / API Key / entitlement 上下文；
2. Native full Desktop Host 与隔离官方 AppServer assembly 之间存在未观测的认证或权益解析差异；
3. 请求结构和辅助请求序列不同，但当前不能把这些结构差异证明为触发条件。

当前不支持：

- 仅凭可见 Header 差异修复；
- 仅修改 User-Agent、设备信息或客户端标识；
- 硬编码 `0.67`；
- 复制凭据、Project Token 或设备身份；
- 为获得期望结果重复发起模型请求。

因此本轮不选择新的 Bridge 实验变体，也不修改生产认证或请求行为。

## 11. 验证

| 验证 | 结果 |
|---|---|
| `npm run test:affected -- --base origin/preview` | PASS；`FULL_REGRESSION_PASS` |
| 完整测试计数 | 961 total / 959 pass / 0 fail / 2 skip |
| `node --test tools/cost-lab/test/*.test.mjs` | PASS，38/38 |
| `git diff --check` | PASS |
| 压力测试边界 | `STRESS_TESTS_NOT_APPLICABLE` |

`test:affected` 已包含 typecheck、build、plugin validation、generated freshness 和完整隔离回归，
因此本轮没有另起第二个全量测试。

## 12. 证据

本 Worktree 的增强重放与 fresh snapshot：

```text
.run/fresh-billing-20261117T1447.json
  SHA-256: 13BAD1CCA4E51DD6279B173B85184C868497E8E502E31CBA51ADBE12C275FB98
.run/bridge-b-enhanced/probe-result.json
  SHA-256: F90D30F63DC4B41A2B7AEDFF132FA98C130049960EC446C77EAB07BC4B68CB1C
.run/native-baseline/native-glm53-20261117-enhanced/probe-result.json
  SHA-256: 300719BE21F2736471A5FF369578161B5DCBFD405DE14E8594433D5533FEBA39
```

既有 Bridge B 原始账单证据位于：

```text
D:\codex-zcode-bridge\.run\coding-plan-assembly-ab-20261116\.run\clean-window-b-20261117\
```

本任务没有修改该 Worktree，只读复核并重放其请求证据。

## 13. 剩余不确定性与下一步

仍不能证明：

- 请求级 API Key / Project Token scope 是否完全一致；
- 0.67 的服务端规则名称、权益字段和触发条件；
- Native 与 Bridge 的哪个单独组件造成了本次优惠差异；
- Native `project_memory_extract` 的请求级 Usage。

不建议仅为重复观察再消耗一次 Bridge 模型调用。若 Owner 后续继续调查，应优先以非秘密方式补齐
请求级 Project / API Key / entitlement 身份边界，或寻找服务端明确返回的权益证据；在没有新判别
条件前，不应随机修改 Header、Token、设备信息或认证流程。

## 14. 最终状态

```yaml
GOAL: COST_LAB_FULL_PROBE_AND_BRIDGE_AB

BUILD_PROVENANCE: PASS
REPRODUCIBLE_BUILD: PASS
PRODUCTION_BUNDLE_EXCLUDED: PASS
PROBE_COVERAGE: PARTIAL
RPC_COVERAGE: LIFECYCLE_PARTIAL
AUXILIARY_REQUEST_COVERAGE: PARTIAL_WITH_USAGE_MISSING
PROJECT_IDENTITY_PARITY: SUPPORTED_IDENTICAL
API_KEY_ID_PARITY: UNKNOWN
ACCOUNT_SCOPE_PARITY: MATCH
USAGE_SCENE_PARITY: MATCH
REQUEST_STRUCTURE_DELTA: NATIVE_5_MESSAGES_58_TOOLS; BRIDGE_7_MESSAGES_21_TOOLS
EXPERIMENT_VARIANT: NONE_SELECTED

BRIDGE_REAL_TASKS: 0
BRIDGE_HTTP_REQUESTS: 0
BRIDGE_TOTAL_TOKENS: 0
EXISTING_CLEAN_B_REUSED: 1
REAL_MODEL_REQUESTS: 0
ADDITIONAL_CREDITS_USED: 0

BILLING_RECONCILIATION: PASS
BRIDGE_ACTUAL_CREDITS: 1.5491
BRIDGE_EXPECTED_NORMAL: 1.549057
BRIDGE_EXPECTED_WITH_0_67: 1.03786819
BRIDGE_EFFECTIVE_RATIO: 1.000027758823594
BRIDGE_DISCOUNT: FAIL

NATIVE_ACTUAL_CREDITS: 4.2959
NATIVE_EXPECTED_NORMAL: 6.41187
NATIVE_EFFECTIVE_RATIO: 0.6699917496767714
NATIVE_DISCOUNT: PASS

ROOT_CAUSE: UNKNOWN_SERVER_SIDE_OR_UNOBSERVED_PROJECT_IDENTITY_CONTEXT
ROOT_CAUSE_CONFIDENCE: LOW
PRODUCTION_CODE_CHANGED: NO
MAGPIE_CHANGED: NO
START_PLAN_CHANGED: NO
HOST_WAKE_CONFLICT: NONE

TESTS: FULL_REGRESSION_PASS_961_TOTAL_959_PASS_2_SKIP; COST_LAB_38_OF_38_PASS; DIFF_CHECK_PASS; STRESS_TESTS_NOT_APPLICABLE
REPORT: docs/reports/cost-lab-full-probe-and-bridge-ab-20261117.md
NEXT_ACTION: STOP_AND_WAIT_FOR_OWNER_DIRECTION
```
