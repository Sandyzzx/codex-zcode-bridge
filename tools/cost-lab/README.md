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
- `~/.zcode/cli/log/zcode-*.jsonl` 的 `model.request.completed`

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
只保留允许的 Header 名称集合、明确列出的非秘密 Header 值、消息/工具数量。

已知覆盖边界：

- `model_usage` 提供官方逻辑模型请求和 Token。
- `model_io` 提供网络 attempt、请求 Header 元数据与 finish reason。
- 运行日志可发现未写入 `model_usage` / `model_io` 的辅助 HTTP 请求。日志中的 Usage 被官方
  脱敏时，记录保留为 `USAGE_MISSING`，不推断 Token 为零。
- Account/OAuth/Project/Token 等非模型 HTTP、RPC 生命周期及 HTTP 状态未完整观测。
- 缺失 Usage 必须保留 `USAGE_MISSING`，不能记成零。

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

当前代码将工作日 `14:00-17:59`（`Asia/Shanghai`）视为高峰，其余时间为非高峰。
如果官方规则、模型系数或活动发生变化，必须先更新并复核证据，不能沿用历史结论。

## Vendor Provenance

`vendor/official-billing-runtime.mjs` 是固定官方源码的 Cost Lab 打包产物。
当前来源树并非 clean build，因此可复现性只能是 `PARTIAL`。完整来源、
Bundle Hash、固定官方 Commit/Tree、Keyring 版本和本地只读 Guard 记录在
`vendor/BUILD_PROVENANCE.json`。

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
跨日志唯一关联、辅助请求、Usage Missing、Vendor Hash 和不支持平台拒绝。

仓库 `npm run test:affected` 仍是正式 T0 门禁。若本机磁盘不足导致该门禁无法执行，
必须报告 `BLOCKED` 或 `NOT RUN`，不能用 Cost Lab 定向测试代替 TypeScript/build/
plugin validation 的 PASS。
