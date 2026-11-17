# Cost Lab Native Control Capture V3

> Status: RESEARCH
> Date: 2026-11-17
> Branch: `codex/cost-lab-native-control-v3-20261117`
> Base: `f36424945136d332f1c37378df8ac9ebc9aaf026` (`origin/preview` V2 branch HEAD)
> Base tree: `4132a2425be50bb74740a400d6f8fa90666a5030`
> Official source: ZCode `3.18.2`, commit
> `fec975905a2abd4c07e35c40d51fa097a2258ec9`, tree
> `5e90fec80706b8381f94e4eef48cf821b9868916`
> Evidence class: 已安装 Desktop 进程清单、固定官方源码审计、历史 Native SQLite / Model I/O / 日志
> 只读重放、官方 Coding Plan 小时账单、离线测试和 clean-source Runtime 重建
> Security boundary: 未复制、输出或比较 Authorization、Cookie、JWT、Project Token、API Key
> 或凭据密文；不发起模型请求，不修改 Desktop、Bridge、Magpie 或 Start Plan

## 1. 最终结论

| 项目 | 结论 | 证据边界 |
|---|---|---|
| Native 进程发现 | `PASS` | 已安装 Desktop 进程树和 AppServer 角色已核实 |
| Native Capture Control | `PARTIAL` | 官方 Resource Manager Capture 可控制，但只记录元数据 |
| Native HTTP Capture | `PARTIAL` | Model I/O 可提供端点、状态和 SSE Usage；全量保留仍不暴露凭据 Header |
| Native RPC Capture | `BLOCKED` | 安装版无可用 RPC tap；stdio tap 仅开发态可见 |
| Native Identity Capture | `BLOCKED` | Project Token、API Key ID、Request Auth 均不可见 |
| Identity Redaction | `PASS` | 官方诊断和本仓库探针均不输出凭据值 |
| V3 真实 Native 任务 | `NOT RUN` | 零计费门禁未通过，未使用隔离 AppServer 冒充 |
| 历史 Native 账单 | `PASS/AGGREGATE` | `12:00` 桶精确符合非高峰 `0.5 x 0.67` |
| 历史 Native 优惠 | `PASS/SUPPORTED_AGGREGATE` | 有效额外倍率 `0.6699917497` |
| 当前 V3 Native 优惠 | `INCONCLUSIVE` | 无本轮实时 Native 请求 |
| 28,239 Token 残差 | `SUPPORTED_NOT_CONFIRMED` | 唯一未观测模型请求是 `project_memory_extract`，但其 Usage 被脱敏 |
| Native / Bridge 对照 | `PARTIAL` | 可比较端点层次、Runtime 与聚合计费；身份和 Gateway 不可比较 |
| 根因 | `UNKNOWN` | 无法把任一装配差异认定为优惠判定原因 |
| 根因置信度 | `LOW` | 只有相关性，没有单变量证据 |

本轮没有为了得到 PASS 而降级 Native 捕获定义。官方安装版没有找到一个同时满足以下条件的
受支持入口：

```text
Native process
  -> complete request/response headers and body
  -> SSE Usage
  -> OAuth / Project Token / Request Auth
  -> RPC request and response payloads
```

因此没有启动真实 Native 任务。

## 2. 工作区与边界

实验在独立 Worktree 执行：

```text
D:\codex-zcode-bridge\.run\cost-lab-native-control-v3-20261117
```

起始 HEAD 与远程 V2 最终 HEAD 均为：

```text
f36424945136d332f1c37378df8ac9ebc9aaf026
```

本轮未修改：

- Bridge 生产认证、Provider 路由、Worker、Manager 或 SQLite Authority。
- Host Wake、Magpie 或 Start Plan。
- ZCode Desktop 安装目录、登录态、持久 Credential Store 或设备身份。
- 正式 Plugin Bundle。

没有创建 PR、Merge 或 Preview。

## 3. Native 进程发现

采集时间：

```text
2026-11-17T11:24:37Z
2026-11-17 19:24:37 Asia/Shanghai
```

Root PID 为 `572`，共发现 26 个进程：

| Role | Count |
|---|---:|
| `desktop-main` | 1 |
| `crashpad-handler` | 1 |
| `gpu-process` | 1 |
| `network-service` | 1 |
| `renderer` | 2 |
| `node-utility` | 3 |
| `utility-other` | 2 |
| `runtime-host` | 3 |
| `conhost` | 3 |
| `app-server` | 3 |
| `plugin-host` | 6 |

关键进程：

| Role | PID | Parent PID | Depth | Binary |
|---|---:|---:|---:|---|
| Desktop main | 572 | 9736 | 0 | `ZCode.exe` |
| Runtime Host | 22592 | 27592 | 2 | `zcode-runtime-host.exe` |
| Runtime Host | 3008 | 27592 | 2 | `zcode-runtime-host.exe` |
| Runtime Host | 11248 | 27592 | 2 | `zcode-runtime-host.exe` |
| AppServer | 8388 | 22592 | 3 | `ZCode.exe` |
| AppServer | 18188 | 3008 | 3 | `ZCode.exe` |
| AppServer | 12336 | 11248 | 3 | `ZCode.exe` |

初次脚本将三个 stdio AppServer 标成 `other`。本轮新增的离线整理器只依据
`runtime-host -> ZCode.exe` 父子关系把对应子进程重新标记为 `app-server`，未推断命令行内容。
原始清单中的命令行、环境变量等字段被拒绝写入整理结果。

安装身份：

```text
Desktop version/build: 3.18.2.10443
ZCode.exe SHA256:
  e853398ea2023e3e472fd2799389ad02445df5c2bfd36b2ed1f1e3dfe3dc958e
runtime-host SHA256:
  c2c8ff5ff28cbddc4f177c094aa67c322830889612251bd173baaabc89379ab4
app.asar SHA256:
  4c0b8510a1ff7f1142714a1dc37139058254b784ad72b70ba781f09334b0c131
zcode.cjs SHA256:
  08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c
```

AppServer 没有独立可执行文件，运行同一 `ZCode.exe`。历史 Native 日志报告的 App 版本为
`3.18.2`，Runtime Build 为 `3.18.2.10443`。

结论：

```text
NATIVE_PROCESS_DISCOVERY: PASS
```

## 4. 官方 Capture 能力核查

### 4.1 Resource Manager Network Capture

官方 schema 只包含：

```text
timestamp
processType
pid
method
sanitized url
```

证据：

- `packages/shared/src/networkCapture.ts:9`
- `packages/shared/src/networkCapture.ts:38`
- `packages/desktop/src/main/resourceManagerNetwork.ts:107`

URL sanitization 会删除 username、password、fragment，并把 query value 统一替换为
`[redacted]`。该功能没有请求/响应 Header、body、状态码、SSE、Usage、身份或 RPC payload。

它可作为 endpoint/process 弱证据，但不能构成完整 Wire 捕获。

### 4.2 Model I/O 诊断

Model I/O 能提供：

- 模型请求生命周期。
- endpoint host/path。
- 状态和安全 Header 名称。
- SSE finish reason 和 Usage。
- 部分请求结构统计。

官方还提供默认关闭的 `modelIoFullRetentionEnabled` 生产诊断设置：

- 开启后不执行 Model I/O compaction、字段裁剪或文件轮转。
- 完整保存 sanitized model request/response、prompt、tool input/result 和输出。
- 文档明确写明“只改变保留策略，不改变安全脱敏边界”，切换模式不能关闭 Header 与
  Architect request metadata 的凭据脱敏。

证据：

- `docs/model-io-full-retention-setting.md`
- `apps/zcode-cli/packages/adapters/src/model/runner-debug.ts:472`
- `apps/zcode-cli/packages/adapters/src/model/runner-debug-redaction.ts:3`

该设置能提高请求 body 和响应 body 的完整度，但仍不能提供 HTTP method、Authorization、
API Key ID 或请求认证来源。因为它是全局持久偏好，本轮没有为了实验修改共享 `setting.json`；
即使开启也不足以通过 Identity 门禁。

但官方 `runner-network-headers.ts` 对以下值强制执行 `[redacted]`：

```text
authorization
proxy-authorization
cookie
set-cookie
x-api-key
api-key
openai-api-key
x-off-peak-ticket-id
任何名称包含 authorization / api-key / token / secret / cookie 的 Header
```

证据：

- `apps/zcode-cli/packages/adapters/src/model/runner-network-headers.ts:2`
- `apps/zcode-cli/packages/adapters/src/model/runner-network-headers.ts:16`
- `apps/zcode-cli/packages/adapters/src/model/runner-network-headers.ts:28`

因此它不能证明 Native 使用的 Project Token、API Key ID 或 Request Auth 来源。

### 4.3 Agent stdio tap

stdio tap 只在 development Node 环境可见：

```text
isZCodeStdioTapDevVisible()
  = isEffectiveDevelopmentNodeEnv()
```

证据：

- `packages/services/src/zcode-agent/zcodeStdioTapDevConfig.ts:11`
- `packages/services/src/zcode-agent/zcodeStdioTapDevConfig.ts:41`

它记录 Agent RPC stdio 帧，但不观察模型 HTTP，而且凭据相关 RPC payload 会被隐藏。安装版
Desktop 不属于该开发态路径，不能作为 Native V3 RPC 证据。

### 4.4 CLI Debug MITM Proxy

官方 debug server 使用 `http-mitm-proxy`、本地 CA、`ZCODE_HTTP_PROXY` 和
`ZCODE_AGENT_CA_CERT`：

- `apps/zcode-cli/packages/debug/server/network-capture.ts:6`
- `apps/zcode-cli/packages/debug/README.md:23`

该能力即使技术上可捕获 Wire，也明确违反本轮禁止 MITM、系统代理和证书替换的安全边界，
不参与资格判定。

### 4.5 Capture Gate

| Gate | Result | 原因 |
|---|---|---|
| `NATIVE_PROCESS_DISCOVERY` | `PASS` | 已安装进程树可确认 |
| `NATIVE_CAPTURE_CONTROL` | `PARTIAL` | 官方 Capture 只覆盖元数据 |
| `NATIVE_HTTP_CAPTURE` | `PARTIAL` | Model I/O 缺少完整 Header/body/Identity |
| `NATIVE_RPC_CAPTURE` | `BLOCKED` | stdio tap 仅开发态 |
| `NATIVE_IDENTITY_CAPTURE` | `BLOCKED` | 凭据 Header 被强制脱敏 |
| `IDENTITY_REDACTION` | `PASS` | 本仓库未输出任何凭据值 |
| `BILLING_READER` | `PASS` | 官方机器可读 Snapshot 可读取 |
| `REAL_NATIVE_TASK_ALLOWED` | `false` | 完整 Wire/RPC/Identity 门禁未通过 |

新增离线预检：

```text
tools/cost-lab/native-control-evidence.mjs
```

该工具只静态评估已知官方通道，不启动 Desktop、不读取凭据。当前输出：

```text
NATIVE_CAPTURE_CONTROL: PARTIAL
NATIVE_HTTP_CAPTURE: BLOCKED
NATIVE_RPC_CAPTURE: BLOCKED
NATIVE_IDENTITY_CAPTURE: BLOCKED
IDENTITY_REDACTION: PASS
REAL_NATIVE_TASK_ALLOWED: false
```

这里的 `NATIVE_HTTP_CAPTURE: BLOCKED` 表示“不能完成 V3 要求的完整实时 HTTP 捕获”；
报告顶层的历史证据仍可达到 `PARTIAL` 覆盖。

## 5. 历史 Native 请求账本

由于本轮未执行真实 Native 任务，以下数据来自已有
`COSTLAB Native Baseline Verification` 会话的只读重放，不冒充 V3 实时请求。

时间统一为 `Asia/Shanghai`：

| 请求 | 开始 | 完成 | Query Source | Uncached Input | Cached Input | Output | Total | Usage |
|---|---|---|---:|---:|---:|---:|---:|---|
| Main | 12:24:04.200 | 12:24:10.701 | `main_turn` | 27,177 | 0 | 9 | 27,186 | `OBSERVED` |
| Title | 12:24:10.779 | 12:24:12.399 | `session_title` | 248 | 0 | 13 | 261 | `OBSERVED` |
| Memory Extract | 12:24:10.805 | 12:24:16.200 | `project_memory_extract` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `USAGE_MISSING` |

共同字段：

```text
Provider: account:bigmodel-individual-coding-plan
Model: GLM-5.3-Flash
Account scope: personal
Usage scene: CODING_PLAN
Endpoint host/path: open.bigmodel.cn/api/anthropic
HTTP method: UNKNOWN
```

Main 与 Title 状态为 HTTP `200`。Memory Extract 只有模型生命周期日志，HTTP 状态也未知。

本地可确认 Token：

```text
Uncached input: 27,425
Cached input:        0
Output:             22
Total:          27,447
```

证据：

- SQLite `model_usage` 只有 Main 与 Title 两行。
- `model-io-sess_76ea7052-7fdc-413c-a4fa-f6514a1f652c.jsonl` 提供请求级 Usage。
- `zcode-2026-11-17.jsonl` 在同一窗口记录恰好三个模型请求生命周期。

三个请求都没有暴露 Authorization、`x-api-key`、Cookie、Project Token 或 API Key ID。

## 6. 官方账单与 28,239 Token 残差

官方 Snapshot：

```text
Captured at: 2026-11-17T11:23:08.287Z
            2026-11-17 19:23:08 Asia/Shanghai
Provider: account:bigmodel-individual-coding-plan
Model: GLM-5.3-Flash
Granularity: hour
Target bucket: 12:00:00 Asia/Shanghai
```

`12:00` 桶：

```text
Cached input:       0
Uncached input: 55,658
Output:             28
Total:          55,686
Credits:       4.2959
```

本地已观测请求扣除后：

```text
Cached input residual:        0
Uncached input residual: 28,233
Output residual:              6
Total residual:          28,239
```

计算公式：

```text
BASE_CREDITS =
  (55,658 x 2.3 + 28 x 8) / 10,000
  = 12.82374

OFF_PEAK =
  12.82374 x 0.5
  = 6.41187

WITH 0.67 =
  6.41187 x 0.67
  = 4.2959529

ACTUAL =
  4.2959

EFFECTIVE EXTRA RATIO =
  4.2959 / 6.41187
  = 0.6699917496767714
```

因此该小时桶的整体扣费与 `0.67` 高度一致。

残差归因：

```text
RESIDUAL_ATTRIBUTION: SUPPORTED_NOT_CONFIRMED
```

支持归入 `project_memory_extract` 的证据是：

1. 同一 Session/Turn 中存在一个本地模型生命周期请求。
2. 该请求的 Usage 字段被官方日志显式写成 `[Redacted]`。
3. SQLite `model_usage` 缺少对应行。
4. 该窗口本地日志没有发现其他 Native 模型请求。
5. 官方残差可精确拆成一个 28,233 uncached input、6 output 的请求。

但不能升级为 `CONFIRMED`，因为：

1. 官方账单只有小时聚合，不是请求级账本。
2. Memory Extract 的真实 Token 分类不可见。
3. 同一账号的其他客户端在服务端是否并发请求，本地 ZCode 日志不能完全排除。

这修正了此前报告容易造成的误解：

```text
55,686
```

是上一轮官方小时桶聚合值，不是本地已逐请求观测到的 Native 总量。可被本地请求级证据确认的值是
`27,447`。

## 7. Identity、Endpoint 与 Gateway

### 7.1 Identity

本轮没有取得 Native 真实身份链：

```text
NATIVE_IDENTITY_CAPTURE: BLOCKED
PROJECT_TOKEN_PARITY: UNKNOWN
API_KEY_ID_PARITY: UNKNOWN
ACCOUNT_SCOPE_PARITY: MATCH
USAGE_SCENE_PARITY: MATCH
REQUEST_AUTH_PARITY: UNKNOWN
```

不能从 Bridge V2 的 Project Token 指纹推断 Native 使用同一 Token。
`IDENTITY_REDACTION: PASS` 只说明脱敏边界有效，不说明身份可观测。

### 7.2 Endpoint

历史 Native 日志层：

```text
open.bigmodel.cn/api/anthropic
```

Bridge V2 Wire：

```text
zcode.z.ai/api/v1/ultra/anthropic/v1/messages
```

因此：

```text
ENDPOINT_PARITY: DIFFERENT_LITERAL_SURFACE
GATEWAY_PARITY: UNKNOWN
```

官方 `3.18.2` 的 Coding Plan gateway 可能把部分 Anthropic 基础 endpoint 映射到 Ultra Gateway。
现有证据不能证明 Native 与 Bridge 的最终上游 Gateway 不同或相同。

## 8. Native / Bridge 差异矩阵

| 维度 | Native 历史证据 | Bridge V2 B | 结论 |
|---|---|---|---|
| Provider | `account:bigmodel-individual-coding-plan` | 同左 | `MATCH` |
| Model | `GLM-5.3-Flash` | 同左 | `MATCH` |
| Account scope | personal | personal | `MATCH` |
| Usage scene | `CODING_PLAN` | `CODING_PLAN` | `MATCH` |
| Main query source | `main_turn` | `main_turn` | `MATCH` |
| Main transport | SSE | SSE | `MATCH` |
| Runtime assembly | Desktop full Host services | Isolated official AppServer | `DIFFERENT` |
| Literal endpoint layer | `open.bigmodel.cn/api/anthropic` | Ultra Gateway URL | `DIFFERENT` |
| Final Gateway | `UNKNOWN` | `UNKNOWN_UPSTREAM` | `UNKNOWN` |
| Project Token | `UNKNOWN` | V2 已观测并本地指纹化 | `UNKNOWN` |
| API Key ID | `UNKNOWN` | V2 内部一致 | `UNKNOWN` |
| Request Auth | `UNKNOWN` | Project Token in Both Headers | `UNKNOWN` |
| Main messages | 5 | 2 | `DIFFERENT` |
| Main tools | 58 | 21 | `DIFFERENT` |
| RPC coverage | 历史生命周期摘要 | 隔离实验完整摘要 | `COVERAGE_DIFFERENT` |
| Auxiliary Usage | Title observed; Memory Extract missing | Title missing | `PARTIAL` |
| Official bucket Tokens | 55,686 | 13,925 | `NOT_DIRECTLY_COMPARABLE` |
| Official Credits | 4.2959 | 1.6072 | `NOT_DIRECTLY_COMPARABLE` |
| Effective extra ratio | 0.6699917497 | 1.0000087109 | `DIFFERENT` |

该表不是受控 A/B。请求大小、上下文、Runtime、工具集和辅助请求均不同，不能从中推导
单一组件导致优惠差异。

## 9. 根因判断

已确认：

1. Bridge V2 的干净窗口 B 请求没有取得额外 `0.67`。
2. Native 历史小时桶整体符合 `0.5 x 0.67`。
3. Native 与 Bridge 的可观测 endpoint 层、Runtime Assembly、请求结构和辅助请求都不同。
4. Native 的实时身份、完整 Header、RPC 和请求级权益字段仍不可见。

未确认：

1. Native 与 Bridge 是否使用相同 Project Token。
2. 两者最终 Gateway 是否相同。
3. 哪个 Runtime、请求结构或服务端权益上下文触发 `0.67`。
4. Memory Extract 是否精确构成全部 28,239 Token 残差。

因此：

```text
ROOT_CAUSE: UNKNOWN
ROOT_CAUSE_CONFIDENCE: LOW
```

本轮不修改 Bridge 认证、Header、User-Agent、设备信息或 Provider 配置。

## 10. 实现与测试

新增：

- `tools/cost-lab/native-control-evidence.mjs`
- `tools/cost-lab/test/native-control-evidence.test.mjs`
- `tools/cost-lab/README.md` 中的 Native Control Boundary 说明

预检工具固化三项 fail-closed 规则：

1. Resource Manager 元数据不能升级为完整 Wire。
2. Model I/O 的 `[redacted]` Header 不能升级为 Identity。
3. development-only stdio tap 和 prohibited MITM proxy 不能参与生产门禁。

测试结果：

| 验证 | 结果 |
|---|---|
| 新增预检测试 | `PASS 7/7` |
| Cost Lab 全体定向测试 | `PASS 79/79` |
| `npm run typecheck` | `PASS` |
| `npm run build` | `PASS` |
| `npm run validate:plugin` | `PASS` |
| `npm run check:generated` | `PASS` |
| clean-source Billing Runtime 重建 | `PASS`，与 tracked 文件 byte-identical |
| Vendor SHA256 | `4414B243...D9129E62`，与 provenance 一致 |
| `git diff --check` | `PASS` |
| Stress | `STRESS_TESTS_NOT_APPLICABLE` |

`npm run test:affected -- --base origin/preview`：

```text
selected mode: FULL_SUITE
tests:         995
pass:          992
fail:            1
skipped:         2
```

唯一失败为无关测试的 teardown：

```text
root-exited decision trace threw
EBUSY: resource busy or locked, rmdir
...\bridge-app-server-test-OrEFV6
```

失败发生在 Windows 临时目录删除阶段，不是 Native Capture 或 Cost Lab 断言。失败后夹具最终
释放，没有发现仍引用该目录的进程。精确重跑该测试一次通过；随后连续重跑三次也全部通过：

```text
TARGETED_RERUN: PASS 4/4
TEST_AFFECTED: FULL_SUITE_ONE_TEARDOWN_EBUSY
```

该结果仍保留为一次失败，不把全量回归写成无条件 PASS。

资源检查：

- Worktree 缺少本地 `node_modules` 时，临时建立指向主仓库依赖目录的 Junction。
- typecheck、affected 和 clean-source build 完成后，验证 LinkType/Target 后只删除 Junction。
- 主仓库 `node_modules` 仍存在。
- 没有遗留 `cost-lab-billing-build-*` worktree 或构建目录。
- 构建没有改变 12 个 tracked generated artifacts。

## 11. 证据文件

本地忽略目录：

```text
.run/v3-process-manifest.normalized.json
.run/v3-native-control-preflight.json
.run/v3-native-history/
  probe-result.json
  request-usage.json
  requests.jsonl
.run/v3-billing-access.json
.run/v3-rebuilt-official-billing-runtime.mjs
.run/v3-test-affected.log
.run/v3-flaky-repro-1.log
.run/v3-flaky-repro-2.log
.run/v3-flaky-repro-3.log
```

SHA256：

```text
9F8EB233A4D6007B8F4D860FFF0E8D7846CF97A146D1206460A480D70591F123
  v3-native-control-preflight.json
38BD57679F4532C0A4E2837845D27999AE6D0A3DAE904A7C522357D20A99F938
  v3-process-manifest.normalized.json
22667CCC01959A497F1496C634533B6EC97CE21D46787F8C83C9901514D2433B
  v3-billing-access.json
88C1363D8474DFCCB2E41D446285479FD94AA7598F07A4E3F28FE2B2706C93C8
  v3-native-history/probe-result.json
D5B887B7F48D2A37147CC79DFAF6C81C7D7CE5F88ECDEC71F0E74B005E963B07
  v3-native-history/request-usage.json
9F311DF2ED008FAF9693EAECEA4C0FD20FA33A84E66B5C9A3684DA6587E8603D
  v3-test-affected.log
```

`.run/v3-billing-access.json` 含账户身份 ID 和小时账单明细，只能保留在本地忽略目录，不提交。

## 12. 剩余问题与下一步

本轮没有找到安装版 Desktop 的受支持完整 Native Wire/Identity 入口。继续测试需要 Owner 单独决定
是否接受以下某一类新增风险：

1. 官方新增或开放一个 production-safe Native capture 接口。
2. 在未签名开发构建中研究 stdio/RPC 与 Model I/O 的关联，但仍不能代表安装版。
3. 由 Owner 明确授权的 MITM 实验；当前边界明确禁止，因此本轮未采用。

在这些条件变化前，不应：

- 使用隔离 AppServer 冒充 Native。
- 复制或伪造凭据。
- 为寻找优惠随机修改 Header 或客户端身份。
- 根据单次 endpoint 或 Runtime 差异实施 Bridge 修复。

## 13. 最终状态

```yaml
GOAL: COST_LAB_NATIVE_CONTROL_CAPTURE_V3

NATIVE_PROCESS_DISCOVERY: PASS
NATIVE_CAPTURE_CONTROL: PARTIAL
NATIVE_HTTP_CAPTURE: PARTIAL
NATIVE_RPC_CAPTURE: BLOCKED
IDENTITY_REDACTION: PASS

NATIVE_REAL_TASKS: 0
NATIVE_MODEL_HTTP_REQUESTS: 0
NATIVE_AUXILIARY_REQUESTS: 0

NATIVE_IDENTITY_CAPTURE: BLOCKED
PROJECT_TOKEN_PARITY: UNKNOWN
API_KEY_ID_PARITY: UNKNOWN
ENDPOINT_PARITY: DIFFERENT_LITERAL_SURFACE
GATEWAY_PARITY: UNKNOWN

NATIVE_TOTAL_TOKENS: 27447_LOCAL_OBSERVED; 55686_OFFICIAL_HOUR_BUCKET
NATIVE_ACTUAL_CREDITS: 4.2959_OFFICIAL_HOUR_BUCKET
NATIVE_DISCOUNT: INCONCLUSIVE_CURRENT; PASS_SUPPORTED_HISTORICAL_AGGREGATE

BILLING_RECONCILIATION: PARTIAL_SUPPORTED_RESIDUAL_NOT_CONFIRMED
NATIVE_BRIDGE_COMPARISON: PARTIAL
ROOT_CAUSE: UNKNOWN
ROOT_CAUSE_CONFIDENCE: LOW

BRIDGE_REAL_REQUESTS: 0
PRODUCTION_CODE_CHANGED: NO
MAGPIE_CHANGED: NO
HOST_WAKE_CHANGED: NO
START_PLAN_CHANGED: NO

TESTS: TARGETED_PASS_79; TYPECHECK_PASS; FULL_SUITE_992_PASS_2_SKIP_1_TEARDOWN_EBUSY; TARGETED_RERUN_PASS_4_OF_4; STRESS_TESTS_NOT_APPLICABLE
REPRODUCIBLE_BUILD: PASS_BYTE_IDENTICAL
RESOURCE_CLEANUP: PASS

LOCAL_COMMIT: THIS_DELIVERY_COMMIT_REPORTED_IN_FINAL_HANDOFF
REMOTE_PUSH: SAME_COMMIT_VERIFIED_IN_FINAL_HANDOFF

NEXT_ACTION: STOP; REQUIRE_NEW_OWNER_AUTHORIZATION_FOR_ANY_PRODUCTION_SAFE_NATIVE_CAPTURE_OR_MITM_PATH
```
