# Cost Lab Foundation and Native Discount Control

> Status: RESEARCH
> Date: 2026-11-17
> Branch: `codex/cost-lab-native-control-20261117`
> Base: `02cf2fa92c8235370fe7a883d4c5b30d93a8ab33` (`origin/preview`)
> Implementation commit: `35c8214e`
> Evidence class: Cost Lab 实现与离线测试、一次真实 Native ZCode Desktop 任务、官方机器可读
> Coding Plan 小时账单、ZCode SQLite / Model I/O / 运行日志和既有 Bridge A/B 报告
> Security boundary: 未复制、输出或比较 Authorization、Cookie、JWT、Project Token 或凭据密文

## 1. 最终结论

| 项目 | 结论 | 证据边界 |
|---|---|---|
| Cost Lab 长期组件 | `PASS` | Billing Reader、Native Probe、Reconcile 和证据规范进入 `tools/cost-lab/` |
| 独立 Billing Reader 纳入 | `PASS` | 复用已有验证实现的官方 service accessor，未使用 Computer Use 读取账单 |
| 官方服务复用 | `PASS` | Credential、OAuth、Project Token、Request Auth 和 Usage Stats 均走固定官方 Runtime |
| 生产 Bundle 排除 | `PASS` | 定向测试确认 `tools/cost-lab/` 不在 package/plugin 构建入口 |
| Native Probe | `PARTIAL` | 三个模型 HTTP 请求全部发现；非模型 Auth/RPC 与 HTTP 状态未观测 |
| Native 真实任务 | `PASS` | 仅启动一次，返回 `COSTLAB_NATIVE_BASELINE_OK`，无重试、无工具调用 |
| Native 官方账单对账 | `PASS` | 12:00 桶 Token 精确匹配，实际倍率 `0.66999175` |
| Native 当前 `0.67` 优惠 | `PASS` | 本账户、本模型、本次非高峰窗口可靠成立 |
| Native / Bridge 渠道差异 | `FAIL` | Native 本窗口享受 0.67；干净窗口 B 路径为 1.0 倍 |
| 差异根因 | `UNKNOWN` | 官方未提供请求级账单或权益触发字段，不能从单次结构差异归因 |

本次最重要的新增事实是：Native Current Baseline 在官方账单中再次取得 `0.67`。这不能直接证明
Bridge 的某个 Header、Token 或客户端字段可以修复优惠，也不能把 Native 与 B 的请求结构差异提升为
因果结论。

## 2. 工作区与执行边界

本任务在独立 Worktree 执行：

```text
D:\codex-zcode-bridge\.run\cost-lab-native-control-20261117
codex/cost-lab-native-control-20261117
```

未修改生产 Bridge 认证、Worker、Manager、Adapter、SQLite Authority、Start Plan、Host Wake 或
Magpie。未使用 Start Plan，未操作其他 Agent 的 Worktree，未 push、merge、rebase、创建 PR 或发布
Preview。

本轮 Owner 只授权一次新的 Native ZCode 真实任务，不授权新的 Bridge 模型请求。实际新增 Native
任务为 `1`，Bridge 真实任务为 `0`。

## 3. Cost Lab 工程化

### 3.1 组件边界

新增内容全部位于 `tools/cost-lab/`：

```text
coding-plan-billing.mjs
native-request-probe.mjs
path-discovery.mjs
vendor-loader.mjs
README.md
vendor/official-billing-runtime.mjs
vendor/BUILD_PROVENANCE.json
test/*.test.mjs
```

Cost Lab 不进入生产 Worker、Manager、Adapter、SQLite 或插件 Bundle。Vendor test 还断言：

```text
PRODUCTION_BUNDLE_EXCLUDED: PASS
```

### 3.2 Billing Reader

Billing Reader 复用以下官方能力：

- 官方 Credential Service；
- 官方 OAuth Repository；
- 官方 Project Token Client；
- 官方 Request Auth Service；
- 官方 `usageStatsService.getCodingPlanUsageSnapshot`；
- 瞬时官方 Keyring Lock 生命周期；
- 官方短期 Project Token issuance 路径。

读取边界固定为：

- API host 仅允许 `bigmodel.cn`、`zcode.z.ai`、`api.z.ai`；
- 除官方短期 access-token POST 外只允许 GET；
- 重定向策略固定为 `error`；
- Project location cache 使用只读包装；
- 原始 Snapshot 中识别到的秘密字段统一脱敏。

账单读取没有使用 Computer Use、DevTools 人工复制或截图 OCR。

### 3.3 路径与依赖

账单数据根不再硬编码 Owner 本地路径，而是：

1. 先读取 `~/.zcode/v2/setting.json` 的绝对 `dataBaseDir`；
2. 无法发现时回退用户主目录；
3. 支持显式 `--data-root` 覆盖；
4. 在初始化官方 Runtime 前校验数据根存在。

官方 Billing Runtime 的固定来源为 ZCode `3.18.2`、commit
`fec975905a2abd4c07e35c40d51fa097a2258ec9`、tree
`5e90fec80706b8381f94e4eef48cf821b9868916`。当前来源树并非 clean build，因此
`BUILD_PROVENANCE` 的可复现等级只能是 `PARTIAL`。

Cost Lab 只提交 `@napi-rs/keyring` 的 JS loader、License 和 metadata；native binary 复用仓库已跟踪
Official Host 文件：

```text
bytes:  1,912,832
sha256: 52B16658275B7848F8081A6542FEE3448F1B1C5D3A36487107AE0E7CEC95AC6F
loader: NAPI_RS_NATIVE_LIBRARY_PATH
```

本次提交的 Cost Lab 文件总量为 `2,064,395 bytes`（`1.969 MiB`），没有重复提交上述 native binary。

### 3.4 Native Probe 修复

第一次真实任务中，Probe 只从 `model_usage` 和 `model-io` 得到两个请求，漏掉了官方自动
`project_memory_extract`。该请求存在于官方运行日志中，但 Usage 被脱敏且没有 SQLite Usage 行。

已将 Probe 扩展为只读解析 `~/.zcode/cli/log/zcode-*.jsonl`：

- 发现 `model.request.completed`；
- 按 Request ID 与 SQLite / Model I/O 去重；
- 日志-only 请求保留真实 Request ID、Session、Turn、Provider、Model、时间和 endpoint；
- Usage 保留为 `USAGE_MISSING`，绝不写成零；
- 新增 `rescan`，可对已结束窗口做不发起模型请求的确定性重放。

修复后的覆盖为：

```text
PROBE_COVERAGE: PARTIAL
MODEL_REQUEST_COVERAGE: SQLITE_MODEL_IO_AND_LOG
AUTH_METADATA_COVERAGE: NOT_OBSERVED
AUXILIARY_REQUEST_COVERAGE: MODEL_AUXILIARY_HTTP_AND_LOG
```

仍未观测：

- Account / OAuth / Project / Token 等非模型 HTTP；
- Native RPC 生命周期；
- Model I/O 的完整 endpoint URL 与 HTTP status；
- `project_memory_extract` 的原始请求级 Usage。

## 4. 唯一一次 Native 真实任务

执行方式为真实安装版 ZCode Desktop 的正常会话，不是 Bridge AppServer，也不是实验 B AppServer。

```text
Provider:   account:bigmodel-individual-coding-plan
Model:      GLM-5.3-Flash
Reasoning:  low
Client:     ZCode Desktop 3.18.2
Runtime:    3.18.2.10443
Workspace:  D:\Program Files\.zcode\workspace\draft-2d920a3a-d589-4621-b314-0cfb7d31603e
Prompt:     Reply exactly COSTLAB_NATIVE_BASELINE_OK. Do not call tools, read files, or make network requests.
Response:   COSTLAB_NATIVE_BASELINE_OK
```

Session / Turn：

```text
session: sess_76ea7052-7fdc-413c-a4fa-f6514a1f652c
turn:    turn_a0e18493-939f-48b0-a9b6-593d8af84d13
trace:   664afdd7-7448-459d-ac64-993cb2a8c7d2
```

SQLite `turn_usage`、`model_usage` 和 Model I/O 均显示主 Turn `completed`，模型请求 `1`、重试
`0`、工具调用 `0`。探针结束后通过日志重放补出同一 Turn 自动产生的两个辅助模型请求。

## 5. 请求级时间线

统一时区为 `Asia/Shanghai`。

| 请求 | Query Source | 开始 / 完成 | Input | Cached | Uncached | Output | Total | 证据 |
|---|---|---|---:|---:|---:|---:|---:|---|
| `33c73b56-5b37-43af-9be6-909f88d3e91b` | `main_turn` | 12:24:04.200 / 12:24:10.701 | 27,177 | 0 | 27,177 | 9 | 27,186 | SQLite + Model I/O |
| `f09af1b7-01a7-4a74-b1e9-ae1d3769f2f3` | `session_title` | 12:24:10.779 / 12:24:12.399 | 248 | 0 | 248 | 13 | 261 | SQLite + Model I/O |
| `54a70c98-c359-4624-9d6f-6a780a05e6d2` | `project_memory_extract` | 12:24:10.805 / 12:24:16.200 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | 官方运行日志；`USAGE_MISSING` |

已持久化 Usage 合计：

```text
cached input:         0
uncached input:  27,425
output:              22
total:           27,447
```

模型 HTTP 请求数：

```text
NATIVE_MAIN_REQUESTS:        1
NATIVE_AUXILIARY_REQUESTS:   2
NATIVE_HTTP_REQUESTS:        3
NATIVE_RETRY_ATTEMPTS:       0
```

## 6. 官方账单窗口

### 6.1 Before / Early After / Final After

```text
before:  2026-11-17T04:21:07.280Z = 12:21:07 Asia/Shanghai
probe:   2026-11-17T04:21:44.353Z - 04:25:00.772Z
after-1: 2026-11-17T04:26:06.587Z = 12:26:06 Asia/Shanghai
final:   2026-11-17T04:35:25.513Z = 12:35:25 Asia/Shanghai
```

Before 的 12:00 小时桶全零。12:26 首次 after 仍全零，说明官方结算尚未落入小时桶。12:35 final
after 出现：

```text
cached input:       0
uncached input: 55,658
output:             28
total tokens:   55,686

cached credits:       0
uncached credits: 4.2884
output credits:   0.0075
total credits:    4.2959
```

### 6.2 窗口清洁度

将只读窗口从 Before 延伸到 Final After 重放后，官方日志中只有上述三个模型请求。Before 到 Probe
启动之间没有 `model.request.completed`，12:00 桶也没有其他可归因模型行。

```text
CLEAN_BILLING_WINDOW: PASS
UNATTRIBUTED_MODEL_REQUESTS: 0
OFFICIAL_SETTLEMENT_STATUS: DELTA_OBSERVED
```

这表示本地可见模型请求没有污染；官方 API 仍是小时聚合，不是服务端 request-level 账单。

### 6.3 Memory Extract 残差

已持久化两个请求合计 `27,447 Token`。官方桶减去该值：

```text
uncached input residual: 55,658 - 27,425 = 28,233
output residual:             28 -     22 =      6
total residual:                       = 28,239
```

运行日志确认唯一未持久化 Usage 的请求是同一 Session / Turn 的
`project_memory_extract`。因此残差可以归属该辅助请求，但其精确 Usage 精度仍是：

```text
AGGREGATE_RESIDUAL_NOT_REQUEST_PERSISTED
```

不能把残差写成官方持久化的请求字段。

## 7. 积分对账

实验发生在工作日非高峰，时段倍率为 `0.5`。

官方桶基础积分：

```text
(55,658 x 2.3 + 28 x 8) / 10,000
= 12.82374
```

无活动优惠：

```text
12.82374 x 0.5 = 6.41187
```

带 `0.67`：

```text
6.41187 x 0.67 = 4.2959529
```

官方实际：

```text
4.2959 credits
```

有效倍率：

```text
4.2959 / 6.41187 = 0.6699917496767714
```

Cost Lab 自带对账器结果：

```text
token_match:             true
credit_class:            EXTRA_0_67
billing_reconciliation:  PASS
```

因此本 Native Baseline：

```text
NATIVE_DISCOUNT: PASS
CONFIDENCE: HIGH_FOR_WINDOW_AGGREGATE
```

该 PASS 只适用于本次 Native ZCode、个人 Coding Plan、`GLM-5.3-Flash` 和该非高峰窗口。它证明实际
扣分倍率，不证明服务端内部权益触发字段。

## 8. Native / Bridge 对比

使用既有干净窗口 B 报告作为对照：

| 项目 | Native 本轮 | Bridge / Official Assembly B |
|---|---|---|
| Provider | `account:bigmodel-individual-coding-plan` | 同左 |
| Model | `GLM-5.3-Flash` | 同左 |
| Query Source | `main_turn` | `main_turn` |
| Reasoning | `low` | `low` |
| Account Scope | personal | personal |
| Usage Scene | `CODING_PLAN` | `CODING_PLAN` |
| Runtime 边界 | Native Desktop Full Host Services | Isolated Official AppServer B assembly |
| 主请求 Token | 27,186 | 13,402 总请求 |
| 模型 HTTP 请求 | 3，含自动 Memory Extract | 主请求 200；Title attempt Usage Missing |
| 实际积分 | 4.2959 | 1.5491 |
| 无优惠理论 | 6.41187 | 1.549057 |
| 有效倍率 | 0.66999 | 1.00003 |
| 优惠结果 | `PASS` | `FAIL` |

### 8.1 身份与结构

```text
PROJECT_IDENTITY_PARITY: SUPPORTED_IDENTICAL
```

该结论只覆盖账户配置与官方账单可观察身份，不能升级为请求级 `CONFIRMED`。本次请求级证据仍未暴露
官方 Project Token scope 或 billing identity：

```text
API_KEY_ID_PARITY: UNKNOWN
ACCOUNT_SCOPE_PARITY: MATCH
USAGE_SCENE_PARITY: MATCH
QUERY_SOURCE_PARITY: MATCH
```

请求结构并不相同：

```text
Native main:        5 messages / 56 tools
Bridge clean B main: 7 messages / 21 tools
```

辅助请求序列也不同。不能只用 Token、Header 或单次 0.67 比例推定某个组件是根因。

### 8.2 当前解释

当前证据支持：

1. Native 当前仍能取得 0.67；
2. Bridge 生产历史样本和干净窗口 B 样本均未取得 0.67；
3. 可见 Provider、Model、Query Source、Account Scope 与 Usage Scene 对齐；
4. Runtime 边界、请求结构、辅助请求序列和未观测的服务端权益上下文仍不同。

```text
ROOT_CAUSE_CONFIDENCE: LOW
```

本轮不修改认证、路由、Header、User-Agent、设备信息或 Provider 配置，也不把 `0.67` 硬编码进
Bridge。

## 9. 验证

| 验证 | 结果 |
|---|---|
| `node --test tools/cost-lab/test/*.test.mjs` | PASS，33/33 |
| `node --check tools/cost-lab/*.mjs` | PASS |
| `npm run typecheck` | PASS |
| `npm run test:affected -- --base origin/preview` | `FULL_SUITE` selected；T0 typecheck PASS；build 因 `ENOSPC` 阻断，功能测试未开始 |
| `git diff --check` | PASS |
| Stress gate | `STRESS_TESTS_NOT_APPLICABLE` |

`test:affected` 首次因 Worktree 没有自身 `node_modules`，在
`playwright-core/browsers.json` 处失败。随后临时建立指向主仓库现有依赖目录的 Junction，按
LinkType/Target 核对后移除；再次执行时 `typecheck` 通过，但 D 盘在 build 阶段耗尽空间并报
`ENOSPC`。因此：

```text
TEST_AFFECTED: BLOCKED_ENOSPC
FULL_SUITE: NOT_RUN
TARGETED_TESTS: PASS_33_OF_33
```

构建产生的三个 tracked 生成物已恢复到 HEAD，没有把失败构建或本地 junction 写入提交。

## 10. 证据

证据保存在 Worktree 忽略目录：

```text
.run/native-baseline/native-glm53-20261117-01/
  experiment.json
  requests.jsonl
  request-usage.json
  probe-result.json
  billing-before.json
  billing-after-01.json
  billing-after.json
  official-reconciliation.json
  reconciliation-input.json
  reconciliation.json
  comparison.json
  window-audit/
  test-affected.log
```

关键 SHA-256：

```text
billing-before.json
  9BDE679625411999C582D189F7084C3ADFB6EE85C3994CC20B658DE07BC68335
billing-after-01.json
  0AC91708C9D1DFD86B609ED5914E59FE2E14A7D4DE8FEDCE49AF4EBF5AD6B307
billing-after.json
  9EC5CBD34B5C7D737B46E6E122D170A3773381DD71936523C56B3310F29C0E26
official-reconciliation.json
  D05C8D0A5E1B222B85A2586AF7DFBAE10D249B3214BF3EA7C30FF44BB4406F57
experiment.json
  CBBF63B388F8F2812CDBCF3B3D526272809D34E04D7E97812D73DE3FF953602B
reconciliation.json
  11BE817FD27281B0E5CDA35FCEEE1CD21043652D16B6158020C446B33CEE128F
comparison.json
  A2DD5699EF87478A9A56E5276B57EC3D1F4EF611A68A7A73A78D9F637CDD3BFA
```

## 11. 下一步

Native Baseline 已可作为后续 Bridge A/B 的对照。下一轮若获 Owner 单独授权，只应执行一次新的 B
请求，并使用本轮的日志感知 Probe 记录主请求、Session Title、Project Memory Extract、重试和
`USAGE_MISSING`。实验前仍需独立 before snapshot 与目标小时桶清洁度检查。

不得从一次请求结构差异直接实施认证修复。优先补齐非秘密的 Project / Key / Org 与 request-level
权益边界证据，再决定是否需要更完整的官方 Host composition。

## 12. 最终状态

```yaml
GOAL: COST_LAB_FOUNDATION_AND_NATIVE_DISCOUNT_CONTROL

COST_LAB_FOUNDATION: PASS
BILLING_READER_INTEGRATED: PASS
OFFICIAL_SERVICE_REUSE: PASS
INDEPENDENT_OF_COMPUTER_USE: PASS
VENDOR_REUSE: PASS
VENDOR_SIZE_DELTA: 2,064,395_BYTES_COMMITTED; 1,912,832_BYTE_NATIVE_REUSED
BUILD_PROVENANCE: PARTIAL
PRODUCTION_BUNDLE_EXCLUDED: PASS

PROBE_COVERAGE: PARTIAL
MODEL_REQUEST_COVERAGE: SQLITE_MODEL_IO_AND_LOG
AUTH_METADATA_COVERAGE: NOT_OBSERVED
AUXILIARY_REQUEST_COVERAGE: MODEL_AUXILIARY_HTTP_AND_LOG
UNOBSERVED_BOUNDARIES: NON_MODEL_AUTH_HTTP; NATIVE_RPC_LIFECYCLE; MODEL_IO_ENDPOINT_AND_HTTP_STATUS; PROJECT_MEMORY_EXTRACT_USAGE

NATIVE_REAL_TASKS: 1
NATIVE_HTTP_REQUESTS: 3
NATIVE_MAIN_REQUESTS: 1
NATIVE_AUXILIARY_REQUESTS: 2
NATIVE_RETRY_ATTEMPTS: 0
NATIVE_TOTAL_TOKENS: 55686
NATIVE_CACHED_INPUT: 0
NATIVE_UNCACHED_INPUT: 55658
NATIVE_OUTPUT: 28

CLEAN_BILLING_WINDOW: PASS
OFFICIAL_SETTLEMENT_STATUS: DELTA_OBSERVED
BILLING_RECONCILIATION: PASS
NATIVE_ACTUAL_CREDITS: 4.2959
NATIVE_EXPECTED_NORMAL: 6.41187
NATIVE_EXPECTED_WITH_0_67: 4.2959529
NATIVE_EFFECTIVE_RATIO: 0.6699917496767714
NATIVE_DISCOUNT: PASS

PROJECT_IDENTITY_PARITY: SUPPORTED_IDENTICAL
API_KEY_ID_PARITY: UNKNOWN
ACCOUNT_SCOPE_PARITY: MATCH
USAGE_SCENE_PARITY: MATCH
ROOT_CAUSE_CONFIDENCE: LOW
NATIVE_BASELINE_READY: PASS
NEXT_BRIDGE_AB_PLAN: ONE_LOG_AWARE_B_REQUEST_AFTER_FRESH_BEFORE_AND_CLEAN_WINDOW_GATE

BRIDGE_REAL_TASKS: 0
PRODUCTION_CODE_CHANGED: NO
MAGPIE_CHANGED: NO
START_PLAN_CHANGED: NO
HOST_WAKE_CONFLICT: NONE
RESOURCE_CLEANUP: PASS

TESTS: TARGETED_PASS_33; TYPECHECK_PASS; TEST_AFFECTED_BLOCKED_ENOSPC; FULL_SUITE_NOT_RUN; STRESS_TESTS_NOT_APPLICABLE
COMMITS: 35c8214e_IMPLEMENTATION; REPORT_COMMIT_IN_DELIVERY
TREE: DELIVERY_HEAD_TREE
REPORT: docs/reports/cost-lab-foundation-and-native-control-20261117.md
NEXT_ACTION: STOP_AND_WAIT_FOR_OWNER_TO_AUTHORIZE_THE_NEXT_SINGLE_BRIDGE_AB
```
