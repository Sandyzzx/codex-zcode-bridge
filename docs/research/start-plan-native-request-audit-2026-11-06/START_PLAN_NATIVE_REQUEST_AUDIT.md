# Start Plan Native Request Fingerprint Audit

> Status: RESEARCH
> Date: 2026-11-06
> Worktree: `D:\codex-zcode-bridge\.run\start-plan-master-20261103`
> Branch: `codex/start-plan-master-20261103`（含未提交 Gate 2 WIP，本审计未修改任何代码）
> Scope: P0 只读审计。未发送新的模型请求、OAuth、Billing、claim 或验证码操作；未生成或轮换设备身份。

## 最终状态

```yaml
STATUS: PARTIAL
OFFICIAL_DESKTOP_START_PLAN_SUCCESS_SAMPLE: MISSING
BRIDGE_START_PLAN_SUCCESS_SAMPLE: PRESENT（2026-10-31 归档 E2E，仅元数据）
BRIDGE_START_PLAN_FAILURE_SAMPLE: PRESENT（2026-11-01，HTTP 405 + providerCode 3012）
REQUEST_BODY_LEVEL_COMPARISON: NOT POSSIBLE（modelIoFullRetentionEnabled=false，无 model_io 落盘）
ROOT_CAUSE_OF_3012: UNCONFIRMED
```

PARTIAL 的原因：本机存在 405/3012 失败样本与 2026-10-31 成功元数据，但没有
官方 Desktop 对 Start Plan 端点的成功模型请求样本，也没有任何一面的完整请求体，
因此请求差异表在 body 级字段（metadata、cache control、thinking 参数）上只能给
UNKNOWN，不能给出字节级 MATCH 结论。

## 证据来源与版本观测

| 来源 | 观测版本 | 说明 |
| --- | --- | --- |
| 官方 Desktop 安装 `app.asar` | 包版本 `0.21.1` | Electron 主进程代码，只读检索 |
| 官方 CLI bundle `resources/glm/zcode.cjs` | 自报 `0.17.1`（2026-11-02 更新） | AppServer/agent 代码，模型请求的实际构造方 |
| `~/.zcode/cli/log/zcode-2026-11-0{1..6}.jsonl` | mcp client `0.17.0`（11-01）、`0.17.1`（11-05/06） | 官方客户端本地日志，无 JWT/明文凭据（已核验 0 处 JWT 形态字符串） |
| `~/.zcode/v2/telemetry-state.json` | `lastDailyActiveDate=2026-09-06` | deviceMid 持久化状态文件 |
| 归档研究报告（2026-10-31，`research/start-plan-native-20261028` worktree 产物） | Desktop `3.16.3.8992`、CLI `0.17.0` | `START_PLAN_BAN_ROOT_CAUSE.md`、`START_PLAN_DEVICE_ID_ROOT_CAUSE.md` |
| Gate 2 WIP 代码（本 worktree 未提交改动） | 基线 `67dd8c67` | Bridge 侧 runtime headers 应答实现 |

Observed：以上均为本机安装/日志观测，不构成官方合同。

## 一、Device Identity（X-Device-Mid）

### 官方来源与生命周期（源码确认，Observed `zcode.cjs` 0.17.1）

1. 来源：`~/.zcode/v2/telemetry-state.json` 的 `deviceMid` 字段；data root 可被
   `ZCODE_TELEMETRY_*` / data-dir 参数重定向后变为 `<data root>/.zcode/v2/telemetry-state.json`。
2. 生成：首次需要时 `randomUUID()` 生成一次，经 `*.tmp` 写入 + `rename` 原子替换落盘，
   并使用 `telemetry-state.lock` 文件做进程间协调。
3. 持久化：跨进程、跨 AppServer 重启持久复用；仅当文件缺失、内容损坏或字段非法
   （非可见 ASCII）时重新生成。
4. OAuth 重新登录：源码中未发现登录成功后轮换 `deviceMid` 的路径；轮换逻辑
   `UNKNOWN`（未逐路径穷尽，但未观测到任何 rotation 调用）。
5. 本机观测值：`d10352ec-87e5-4106-9101-f6c9ec35832d`（设备标识符，非 JWT/Cookie/验证码凭据，
   不在脱敏禁写清单内），`lastDailyActiveDate=2026-09-06`。

### Bridge 当前状态（源码确认）

1. Bridge 源码中没有任何 deviceMid 生成、存储或轮换代码（`rg deviceMid|deviceId|device_id src` 零命中）。
2. Bridge AppServer 子进程环境由 `#buildChildEnv`（`zcode-app-server-adapter.ts:2107`）构造：
   `ZCODE_DATA_BASE_DIR = zcodeDataBaseDir(providerPersonalConfigFile)`，即解析出的真实
   `~/.zcode/v2` 的上两级。生产路径（默认 `homeDir=homedir()`）下 AppServer 与官方 Desktop
   读取**同一个** `~/.zcode/v2/telemetry-state.json` → 复用同一 deviceMid。
3. 测试/Gate 2 路径显式使用隔离 scratch root（`mvp-real-adapter.test.ts`），会生成全新 UUID。
   归档 E2E（2026-10-31）同样使用隔离 data root，Billing 侧甚至每 run 进程生成一次性
   `DEVICE_MID`（`run-real-e2e.mjs:43-59`，归档报告已记录）。

### 能否直接复用官方设备身份

**能，且生产路径已经是复用**：只要 Bridge 的 provider 配置解析自真实 `~/.zcode/v2`，
AppServer 自动复用官方 deviceMid，无需 Bridge 参与生成。风险在于：任何使用隔离
data root 的执行路径都会得到与 Desktop 不同的全新设备身份。禁止生成随机替代值或
轮换现有身份——本审计未做任何此类操作。

## 二、App Version（X-ZCode-App-Version / User-Agent）

1. 版本来源（源码确认，`zcode.cjs` 0.17.1）：
   - CLI/agent 自身版本常量 `0.17.1`；
   - 环境变量 `ZCODE_APP_VERSION` 可覆盖（`ZCODE_APP_VERSION_ENV` 引用）；
   - `User-Agent: ZCode/<appVersion>`、`X-ZCode-App-Version: <appVersion>`、
     `X-Title: Z Code@<sourceTitle>`（agent 默认 `sourceTitle="cli"`）在同一个 header
     builder 中生成；Billing/Entitlement 侧另有 `HTTP-Referer`、`X-Platform`、
     `X-Release-Channel`、`X-Client-Language/Timezone`、`X-Os-Category/Version`、
     `X-Device-Mid` 与 query 参数 `mid`/`app_version`。
2. Desktop 主进程（`app.asar` 0.21.1）自身 API 调用使用 `sourceTitle:"electron"`；
   字面量 `ZCODE_APP_VERSION` 在 app.asar 中仅出现 1 次（常量定义），**是否在 spawn
   agent 子进程时注入该环境变量 UNCONFIRMED**。
3. AppServer 能否自动提供真实版本：能，自动使用自身 bundle 版本 0.17.1；
   本机日志观测：11-01 mcp client `0.17.0`，11-05/06 `0.17.1`，10-30 billing query
   `app_version=0.17.0`。未观测到 0.21.1 出现在 agent 日志。
4. 协议语义：服务端看到的 UA/版本是 **agent（CLI）版本**，不是 Desktop UI 版本
   （0.21.1 vs 0.17.1 的差异是否被 `ZCODE_APP_VERSION` 抹平 UNKNOWN）。
5. 禁止硬编码或伪造：Bridge 当前不设置 `ZCODE_APP_VERSION`，保持官方默认值。

## 三、Captcha

1. Bridge 中的验证码相关代码（源码确认）：仅两处**拒绝性**提示——
   `src/runtime/doctor.ts:166`（"Start Plan requires a Desktop captcha session"）与
   `src/runtime/account-provider.ts:113-120`（headless bridge 无法提供，直接报错）。
   未发现取消、禁用或跳过验证码处理的代码；Gate 2 WIP 未新增验证码处理。
2. 官方验证码体系（源码确认，`zcode.cjs` 0.17.1 + `app.asar` 0.21.1）：
   - 阿里云 Captcha；拒绝码 `3007`（`isCaptchaRejection`），与 `3012`（unusual activity）
     是不同错误；
   - 重试 scope：`["model-request", "captcha-retry"]`，`CaptchaRequestRetry` 最多一次重试；
   - 请求头：`X-Aliyun-Captcha-Verify-Param`、`X-Aliyun-Captcha-Verify-Region`；
   - Desktop 在主进程 webContents 内加载 `AliyunCaptcha.js` 完成交互式验证
     （`installCaptchaNetworkDiagnostics` 等），之后把 verify param 交给请求层。
3. `claimManualPlan`（Desktop 确认存在）：`POST /api/v1/zcode-plan/billing/claim`，
   `Authorization: Bearer <JWT>`（来自 Desktop credentialService）+ 上述验证码头。
   模型请求侧验证码同样走 interaction 配置（`coding_plan_security_verification_required`）。
4. 原生 AppServer 是否支持官方交互式流程：CLI/AppServer 具备**消费** verify param
   与重试的代码，但交互式 UI 在 Desktop 主进程；CLI 无 UI。Bridge 无法提供
   verify param（无 Desktop captcha host），Bridge 侧支持情况 = **不支持**。
5. 本审计未执行任何领取操作、未绕过或伪造验证码、未发送空验证凭据。

## 四、真实请求捕获

1. `modelIoFullRetentionEnabled`：本机 Desktop 设置为 **false**（`~/.zcode/v2/setting.json`）；
   bundle 内默认值同为 false；`~/.zcode` 下未发现任何 `model_io` 目录。
   → 完整请求体（system prompt 内容哈希、metadata、cache control、thinking 参数）
   **本地不可得**。
2. 官方 Desktop Start Plan 成功样本：**缺失**。11 月日志中 Start Plan 端点
   （`https://zcode.z.ai/api/v1/zcode-plan/anthropic`）只有 `querySource=provider_settings_connectivity`
   的 405 失败（11-01 37 次、11-02 3 次、11-06 9 次），无成功样本。
3. Bridge Start Plan 样本：
   - 失败：2026-11-01 02:56:43（北京时间），POST 模型请求，`providerId=account:bigmodel-start-plan`，
     `providerCode=3012`，`responseStatus=405`，"request has been blocked due to unusual activity."，
     响应头含 `x-request-id`、`eagleid`，body keys 含 `logid`（见 `samples/`）。
   - 成功：2026-10-31 00:19:30（归档 E2E），首个模型响应成功，`x-request-id=202610301619274db7dea8b0c91912d446`，
     `x-log-id=20261031001927a169a2e6e1494103`；后续 tool-loop 请求同样成功。
4. 对照组：11-04/05 有大量 **成功** 的 `account:bigmodel-individual-coding-plan` 请求，
   但 baseURL 是 `https://open.bigmodel.cn/api/anthropic`（个人版 API，非 Start Plan 端点），
   不能作为 Start Plan 成功样本。
5. 日志面归属：11 月日志 workspace 为 `D:\codex-zcode-bridge` / `D:\LumeCAE`、
   `entrypoint=zcode_protocol`，具体是 Desktop 内嵌 agent 还是独立 CLI **UNKNOWN**；
   11-01 的 3012 样本 workspace 在 `codex-zcode-bridge\.run\admin-abandoned-20261101\...`。
6. 按约束：未发起任何新的网络请求；缺失项如实报告如上。

## 五、逐字段差异表

判定基准：MATCH = 两面一致（至少代码级）；DIFFERENT = 存在已确认差异；UNKNOWN = 证据不足；
NOT APPLICABLE = 该面不适用。"协议要求"指官方代码中的合同；"官方客户端行为"指 Desktop 实际发送；
"风控推测"明确标注。

| 字段 | 判定 | 依据与说明 |
| --- | --- | --- |
| URL / Method / Host | MATCH（代码级） | 两面共用同一 `zcode.cjs`：`POST {origin}/api/v1/zcode-plan/anthropic`；字节级样本缺失 |
| X-Device-Mid | UNKNOWN（生产）/ DIFFERENT（隔离测试） | 生产默认复用 `~/.zcode/v2/telemetry-state.json`（代码确认）；测试 scratch root 必然新 UUID；运行时实际取值未采样 |
| X-ZCode-App-Version | UNKNOWN（倾向 MATCH） | 两面同 bundle 0.17.1；Desktop 是否经 `ZCODE_APP_VERSION` 注入 0.21.1 UNCONFIRMED |
| User-Agent | UNKNOWN（倾向 MATCH） | `ZCode/<appVersion>`，同上 |
| X-Title | UNKNOWN（潜在 DIFFERENT） | `Z Code@<sourceTitle>`；agent 默认 `cli`，Desktop 自身调用用 `electron`；agent 面实际值未采样 |
| Authorization 方式 | DIFFERENT（合同级，代码确认） | 模型请求均用 `X-Coding-Plan-Api-Key`；Desktop `requestAuth` 可含 `apiKeyId`/`accountScope`/附加 headers，Bridge Gate 2 WIP 只回 `{apiKey}` |
| System Prompt 三段结构与内容哈希 | MATCH（结构，代码+10-31 E2E）/ 哈希 UNKNOWN | 同一 builder；10-31 E2E 确认 `body.system` 三块；内容哈希因无 body 样本不可得 |
| Model ID | MATCH（样本级） | 两面 Start Plan 样本均为 `GLM-5.3-Flash` |
| Thinking 参数 | UNKNOWN | 无请求体样本；agent 支持 `reasoningLevel` |
| Streaming / SSE | MATCH | 两面观测 `transport:"sse"` |
| Metadata | UNKNOWN | 无请求体样本 |
| Cache Control | UNKNOWN | 无请求体样本；11-05 成功响应含 cacheRead/cacheWrite（已脱敏） |
| Captcha Header | DIFFERENT（能力级，代码确认） | Desktop 支持交互式验证码 + `captcha-retry`；Bridge 无 Desktop captcha host，无法提供 verify param |
| Response Status | DIFFERENT（样本不同源） | Bridge：405+3012（11-01）；Desktop Start Plan：405（连通性检查，11 月）；无任一面 200 的 Start Plan 样本 |
| Provider Error Code | 一致出现于失败样本 | 3012=unusual activity；3007=captcha rejection；3001=billing parameter error（归档） |
| LogID | MATCH（存在性） | 成功响应带 `x-log-id`/`x-request-id`；405 响应带 `eagleid`/`x-request-id`，body 含 `logid` |

## 六、修复建议与风险评估

1. **设备身份**：保持并固化"生产路径复用真实 `~/.zcode` data root"的行为；任何 Start Plan
   执行路径不得落入隔离 scratch root。风险：该建议与 3012 的因果关系 UNCONFIRMED，
   仅消除一个已确认的身份差异面，不能承诺解封。
2. **版本号**：不硬编码。可后续验证 Desktop→agent 的 `ZCODE_APP_VERSION` 传递
   （需运行时观测，本审计未做）；在此之前保持官方默认。
3. **验证码**：Bridge 无法自建 Desktop captcha host。若要支持 Start Plan claim/被挑战的
   模型请求，需要正式 DECISION：由 Desktop 宿主通过 interaction 通道提供 verify param，
   或明确不支持并保持 fail-closed（现状）。这是合同变更，必须先有 DECISION 记录。
4. **requestAuth 合同**：Bridge 只回 `{apiKey}`，官方 Desktop 侧合同允许
   `apiKeyId`/`accountScope`。是否需要补齐属合同决策，建议在下次授权的集成任务中核对
   服务端对 `accountScope` 的校验强度（当前无证据表明缺失会导致 3012）。
5. **样本缺失**：如需 body 级对比，唯一合规途径是由 Owner 在 Desktop 设置中临时开启
   `modelIoFullRetentionEnabled` 并在授权窗口内采集；本审计未开启、未采集。
6. **3012 风险声明**：405+3012 自 2026-11-01 起持续出现（含 Desktop 侧连通性检查），
   最可能为账号级/组合式风控（归档报告类别 D，UNCONFIRMED）。在获得 Owner 授权与
   服务端反馈前，任何"已找到根因"的表述都不成立。

## 七、禁止事项遵守声明

- 未修改生产代码（本 worktree 的既有 WIP 保持原样，本审计仅新增本文档与 samples）。
- 未生成/轮换 Device ID，未刷新或重新申请 OAuth，未发送新模型请求，未领取 Token，
  未重复测试 3012，未 push/merge/release。
- 报告与样本不含 JWT、Cookie、验证码凭据；日志经官方脱敏字段（`[Redacted]`）原样引用。

## 附：脱敏样本

见同目录 `samples/official-logs-sanitized.md`（官方日志原样行，producer 已脱敏 set-cookie/usage）。
