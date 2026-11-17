# Bridge Cost Lab

> Status: INTERNAL DEVELOPMENT TOOL
> Last updated: 2026-11-17
> Scope: 官方 Coding Plan 账单读取、原生 ZCode 请求观测、Native/Bridge 计费对照

Cost Lab 是仓库内部的计费实验工具，不属于生产 Worker、Manager、Adapter、
SQLite Authority 或插件运行时，也不会进入生产 Bundle。它不建立第二套认证、
不修改官方安装文件，也不通过 Computer Use、代理拦截或请求改写获取积分。

## 支持范围

- Windows x64
- Node.js `24.16.0`
- ZCode Desktop `3.18.2.10443`
- `account:bigmodel-individual-coding-plan`
- `account:zai-individual-coding-plan`
- `Asia/Shanghai` 小时账单

真实证据统一写入仓库 `.run/`，不提交账户数据、原始 Model I/O、Cookie、
Authorization、Token、JWT、API Key 或完整消息内容。

## Billing Reader

读取当前账户的官方 Coding Plan 小时账单：

```powershell
node tools/cost-lab/coding-plan-billing.mjs snapshot --json
```

默认数据根按 `src/runtime/paths.ts` 的公开设置规则发现：

1. 从 `HOME` / `USERPROFILE` 定位 `~/.zcode/v2/setting.json`。
2. 若其中存在绝对路径 `dataBaseDir`，使用该目录。
3. 否则使用用户主目录。

可用 `--data-root` 显式覆盖：

```powershell
node tools/cost-lab/coding-plan-billing.mjs snapshot --data-root "D:\Program Files" --json
```

Reader 使用已固定的官方 Runtime facade，并限制：

- 只允许 `https://bigmodel.cn`、`https://zcode.z.ai`、`https://api.z.ai`。
- 只允许 GET。
- 唯一写例外是官方短期 Project Token 的 access-token POST。
- 重定向策略固定为 `error`。
- Project location cache 为只读包装。
- 官方读取可能短暂获取并释放共享 Keyring Lock，但不修改持久凭据。

获取 before / after 后对账：

```powershell
node tools/cost-lab/coding-plan-billing.mjs reconcile `
  --before before.json `
  --after after.json `
  --usage request-usage.json `
  --model GLM-5.3-Flash `
  --hour 12 `
  --json
```

小时桶是聚合数据。只有 Token 分类与请求 Usage 一致，且实验窗口无并行请求时，
才能把积分差分归因给单个请求。单一积分比例不能证明优惠资格。

## Native Request Probe

探针只读以下官方本地证据：

- `~/.zcode/cli/db/db.sqlite` 的 `model_usage`
- `~/.zcode/cli/rollout/model-io-*.jsonl`
- `~/.zcode/cli/debug/model-io-*.jsonl`
- `~/.zcode/cli/log/zcode-*.jsonl` 的模型生命周期和
  `zcode_protocol.*` 生命周期摘要

启动被动观测，再执行原生 ZCode 任务：

```powershell
node tools/cost-lab/native-request-probe.mjs watch `
  --experiment-id native-20261117-01 `
  --out .run/native-baseline/native-20261117-01 `
  --client-version 3.18.2 `
  --runtime-version 3.18.2.10443 `
  --duration-ms 300000 `
  --stop-file .run/native-baseline/native-20261117-01.stop
```

任务和自然辅助请求结束后创建 stop file。除非有明确证据需要，不调整时长来扩大样本。

对已结束的真实窗口做只读重放：

```powershell
node tools/cost-lab/native-request-probe.mjs rescan `
  --experiment-id native-20261117-01 `
  --out .run/native-baseline/native-20261117-01 `
  --started-at 2026-11-17T04:21:44.353Z `
  --ended-at 2026-11-17T04:25:00.772Z
```

`rescan` 不发起模型请求，只重新读取指定时间窗内的官方本地证据。

输出：

```text
probe-heartbeat.json
probe-result.json
requests.jsonl
request-usage.json
```

探针按以下证据合并逻辑请求与 HTTP attempt：

- 首选共同 Request ID / Trace ID。
- 缺少共同 ID 时，只有
  `session + turn + query source + attempt + 3 秒内开始时间`
  唯一命中才标记 `SUPPORTED_SESSION_TURN_QUERY_SOURCE_TIME`。
- 多个候选不强行匹配，保留两条记录。
- 不同文件中的同一 `network_request_id` 去重。

Model I/O 的 messages、system、tools、Cookie、Authorization 和响应头值均不保存。
只保留允许的 Header 名称集合、明确列出的非秘密请求/响应 Header 值、
HTTP endpoint host/path、状态码、transport、provider kind、消息/工具数量及
Provider response ID。

模型生命周期按 `requestId` 合并以下事件：

- `ttft.model.request_started`
- `ttft.model.response_headers`
- `model.request.completed`
- `model.network.completed`
- `model.sdk.stream.completed`
- `model.sdk.generate.completed`
- `model.request.failed` / `model.network.failed`

`probe-result.json` 另外输出 `HTTP_ENDPOINT_COVERAGE`、
`HTTP_STATUS_COVERAGE`、`RPC_COVERAGE` 和 `NON_MODEL_HTTP_COVERAGE`。
RPC 仅保存事件类型和 started/completed/failed 计数，不保存 payload。

已知覆盖边界：

- `model_usage` 提供官方逻辑模型请求和 Token。
- `model_io` 提供网络 attempt、请求 Header 元数据与 finish reason。
- 运行日志可发现未写入 `model_usage` / `model_io` 的辅助 HTTP 请求。日志中的 Usage 被官方
  脱敏时，记录保留为 `USAGE_MISSING`，不推断 Token 为零。
- Account/OAuth/Project/Token 等非模型 HTTP 仍未观测；RPC 目前只覆盖生命周期摘要，
  不包含请求 payload。
- Endpoint 与 HTTP 状态来自模型生命周期日志，不是 TLS 拦截或通用网络抓包。
- HTTP method 在现有日志中通常不可见，仍标记为 `UNKNOWN`。
- 缺失 Usage 必须保留 `USAGE_MISSING`，不能记成零。

以上边界适用于历史 Native 被动重放。实时 Bridge 实验使用下一节的网络探针，
不会再依赖 `model_io` 或日志推断辅助 HTTP。

## Live Network And Identity Probe

`official-assembly-live-probe.mjs` 在独立目录中启动固定官方 Host/AppServer，
并通过 `NODE_OPTIONS --require` 和 Harness 自重启同时观测：

- Bridge/Harness 主进程及官方 AppServer。
- `global fetch`、bundled Undici、`node:http`、`node:https`。
- SSE、失败、超时、重定向、请求状态和响应 Metadata。
- 官方 `process/networkCapture` 的独立请求清单。
- AppServer 双向 RPC、`session/send` 与模型 HTTP 的时间关联。

零计费协议门禁：

```powershell
node tools/cost-lab/official-assembly-live-probe.mjs `
  --protocol-smoke `
  --run-root .run/protocol-smoke
```

该模式创建 Session 和订阅，但不发送模型 Prompt。输出
`.run/protocol-smoke/live-probe/smoke-evidence.json` 以及
`network-evidence.json`。

身份证据只保存本地 SHA-256 指纹和长度：

- Host `requestAuth.apiKey` 与实际模型请求 `Authorization` / `x-api-key` 对照。
- Project Token 获取路径中的 Organization、Project、API Key ID 会被替换为
  `{organization_id}`、`{project_id}`、`{api_key_id}`，参数原件不落盘。
- `apiKeyId` 属于官方路由 Metadata，不是模型请求 Header；因此
  `api_key_id_transport: PROJECT_PATH` 表示已核对 Host 值与 Project Token
  请求路径指纹，而不是声称它是模型 Header。
- `accountScope` 只记录本地指纹，不保存 JWT、OAuth、Project Token 或 API Key。

Coverage 采用 fail-closed：

- Harness 与官方 AppServer 都必须初始化 preload。
- 官方 Capture Control 必须生效，完成态 AppServer 请求必须与官方 Capture
  交叉匹配。仅在 Capture 停止后终止的失败请求可以保留为 preload-only，
  但必须有完整 Header、请求体、终态和结束时间，且至少一个完成态请求已由官方
  Capture 独立确认；未解释的 preload-only 记录仍会降为 `PARTIAL`。
- 所有记录必须有已知 process role、HTTP method、Header Matrix、终态和状态。
- POST/PUT/PATCH 必须有请求结构摘要。
- 所有 RPC 必须有 request/response shape，模型 HTTP 必须能关联到
  `session/send`。
- 模型端点同时识别官方直接 `/anthropic` 路径和 Ultra Gateway
  `/api/v1/ultra/anthropic/v1/messages`；后者不能因路径不含 `/api/anthropic`
  被误记为 `other`。
- Host API Key、Wire API Key 和 Project API Key ID 指纹必须一致，且必须观察到
  `accountScope`，`IDENTITY_OBSERVABILITY` 才为 `COMPLETE`。

浏览器、语音 WebSocket 和未执行的 MCP 路径不属于隔离 B 任务的实际请求集；
它们被列入静态入口清单并标记为 `NOT_APPLICABLE`，不能据此宣称已运行时覆盖。

静态入口与绕过扫描：

```powershell
node tools/cost-lab/official-assembly-probe.mjs
```

输出 `network_entrypoints` 和 `network_bypass_scan`，覆盖 Undici Fetch、
Node HTTP(S)、官方 Capture Channel、Bridge fd IPC，并检查目标源码是否存在
直接 HTTP/2、`tls.connect` 或 `net.connect/createConnection`。

## Native Control Boundary

`native-control-evidence.mjs` 固化 ZCode Desktop `3.18.2.10443` 的 Native 实时观测边界：

```powershell
node tools/cost-lab/native-control-evidence.mjs preflight --json
node tools/cost-lab/native-control-evidence.mjs processes `
  --manifest .run/v3-process-manifest.json --json
```

`preflight` 不启动 Desktop、不读取凭据，也不发送模型请求。当前安装版支持边界如下：

- 官方 Resource Manager Capture 可以启停并记录 method、sanitized URL、process type 和 pid，
  但没有 Header、body、SSE、Usage、身份链或 RPC payload。
- 官方 Model I/O 诊断包含模型生命周期、安全 Header 名称和 SSE Usage，但将
  Authorization、API Key、Cookie、Token 和 Secret 强制写成 `[redacted]`。
- 官方 `modelIoFullRetentionEnabled` 是受支持的生产诊断设置，可关闭 compaction 并保留完整
  的已脱敏模型请求/响应；它不能关闭 Header 凭据脱敏，也不提供 HTTP method 或完整身份链。
  启用该设置会改变共享持久偏好，本轮没有为捕获而修改它。
- 官方 Agent stdio tap 只对 development Node 环境可见，且对凭据相关 RPC payload 脱敏；
  它不捕获模型 HTTP。
- 官方 debug MITM proxy 依赖本地 CA 和代理拦截，实验策略明确禁止。

因此完整 Native Wire/RPC/Identity 门禁必须 fail closed。预检结果为
`NATIVE_HTTP_CAPTURE: BLOCKED`、`NATIVE_IDENTITY_CAPTURE: BLOCKED` 和
`REAL_NATIVE_TASK_ALLOWED: false` 时，不得使用隔离 AppServer、MITM 或伪造身份替代
Native Desktop 测试。

`processes` 只用于离线整理已有非秘密进程清单。它会把
`runtime-host -> ZCode.exe` 子进程标记为 `app-server`，并拒绝输出输入中的
`command_line`、`commandLine`、`environment` 或 `env` 字段。

## Isolated Billing Probe

先取得 fresh before Snapshot：

```powershell
node tools/cost-lab/coding-plan-billing.mjs snapshot `
  --data-root "D:\Program Files" `
  --json > .run/fresh-before.json
```

在同一个新 Run Root 完成协议门禁后执行：

```powershell
node tools/cost-lab/official-assembly-live-probe.mjs `
  --protocol-smoke `
  --run-root .run/official-b-v2

node tools/cost-lab/official-assembly-live-probe.mjs `
  --billing `
  --run-root .run/official-b-v2 `
  --before-snapshot .run/fresh-before.json
```

`billing-started.json` 一旦存在，代码会拒绝第二次真实请求。Billing 模式只有在
协议 smoke、共享状态不变、Cleanup、Host Wake、同一账单小时和完整 Coverage
全部通过时，`billing-evidence.json.status` 才为 `PASS`。

取得 after Snapshot 后：

```powershell
node tools/cost-lab/official-assembly-live-probe.mjs `
  --analyze `
  --before-snapshot .run/fresh-before.json `
  --after-snapshot .run/fresh-after.json `
  --billing-evidence .run/official-b-v2/live-probe/billing-evidence.json
```

缺少其他账户活动证据时，小时桶差分仍保持 `INCONCLUSIVE`。

## 积分公式

```text
BASE_CREDITS =
  (uncached_input * 2.3
   + cached_input * 0.56
   + output * 8) / 10000

EXPECTED_NORMAL =
  BASE_CREDITS * time_multiplier

EXPECTED_WITH_0_67 =
  EXPECTED_NORMAL * 0.67

EFFECTIVE_EXTRA_RATIO =
  ACTUAL_CREDITS / EXPECTED_NORMAL
```

当前代码将工作日 `14:00-17:59`（`Asia/Shanghai`）视为高峰，其余时间为非高峰；
高峰按非高峰的两倍时间倍率计算。
如果官方规则、模型系数或活动发生变化，必须先更新并复核证据，不能沿用历史结论。

## Vendor Provenance

`vendor/official-billing-runtime.mjs` 是固定官方源码的 Cost Lab 打包产物。
构建脚本只接受 clean ZCode `3.18.2` 源码，在临时 detached worktree 中应用
`vendor/patches/cost-lab-billing-runtime.patch` 后打包，并在退出前反向应用补丁、
删除临时 worktree。Patch 只包含 Cost Lab billing facade、最小只读 Credential
选项和 Runtime entry，不携带生产 OAuth/Transport 改动。

重建：

```powershell
node tools/cost-lab/build-official-billing-runtime.mjs `
  --source "<clean-fec97590-worktree>"
```

完整来源、依赖锁、Patch/Bundle Hash、固定官方 Commit/Tree、Keyring 版本、
只读 Guard 和两次字节一致构建结果记录在 `vendor/BUILD_PROVENANCE.json`。

`@napi-rs/keyring` 的 JS loader 位于 Cost Lab 的 vendor 路径，native binary
复用仓库已跟踪的 Official Host 文件。`vendor-loader.mjs` 在导入 Runtime 前校验
Runtime 与 native 文件 SHA256，并通过 `NAPI_RS_NATIVE_LIBRARY_PATH` 加载，
不提交第二份约 1.9 MB 的 native binary。

## 测试

Cost Lab 测试是独立的 Node ESM 测试：

```powershell
node --test tools/cost-lab/test/*.test.mjs
```

测试覆盖路径发现、脱敏、API Guard、账单归一化、对账、Native Usage 归一化、
模型生命周期关联、endpoint/status/transport、RPC 摘要、跨日志唯一关联、
辅助请求、Usage Missing、Vendor/Patch Hash、确定性构建来源和不支持平台拒绝。

仓库 `npm run test:affected` 仍是正式 T0 门禁。若本机磁盘不足导致该门禁无法执行，
必须报告 `BLOCKED` 或 `NOT RUN`，不能用 Cost Lab 定向测试代替 TypeScript/build/
plugin validation 的 PASS。
