# CLI Native Alignment Audit — Gate 2 WIP

> Status: RESEARCH
> Date: 2026-11-06
> Worktree: `D:\codex-zcode-bridge\.run\start-plan-master-20261103`
> Branch: `codex/start-plan-master-20261103`，Baseline `67dd8c67`
> Scope: 只读审计。未修改任何现有 WIP 或生产代码；未发送网络请求；未触碰 SQLite。

## 最终状态

```yaml
STATUS: PARTIAL
RUNTIME_AUTH_CONTRACT: PASS（WIP 为官方合同子集，fail-closed）
APPSERVER_ENVIRONMENT: PASS（ZCODE_APP_VERSION 注入 UNKNOWN）
NATIVE_REQUEST_OWNERSHIP: PASS（Bridge 零 HTTP 实现）
CAPTCHA_ERROR_RETRY: PASS（HTML WAF 识别 UNKNOWN）
DECISION_COMPATIBILITY: DIFFERENT（基线落后 master 52 提交，ADR-024 未入基线）
```

证据分层约定：**[master]** = 远程 master 已发布实现（aabbb0a9，v1.6.0）；
**[WIP]** = 本地未提交 Gate 2 改动；**[CLI]** = 官方 zcode.cjs 0.17.1 / app.asar 0.21.1 观测；
**[推测]** = 未经验证的风控假设（本报告不将其作为结论）。

## 1. Runtime Auth

### interaction/requestProviderRuntimeHeaders 合同 [CLI]

- 请求参数：`sessionId`、`turnId`、`modelSelection`（含 `providerId`/`modelId`）。
- 返回为 discriminated union：`{headersApplied:true, requestAuth:{apiKey?, apiKeyId?,
  accountScope?(64-hex), headers?}}` 或 `{headersApplied:false, errorMessage?}`。
- 官方消费：`requestAuth.apiKey` 进入 `X-Coding-Plan-Api-Key` 头（模型请求不用
  `Authorization` Bearer）。

### WIP 实现 [WIP]

| 检查项 | 判定 | 说明 |
| --- | --- | --- |
| 合同形状 | PASS | 回复 `{headersApplied, requestAuth:{apiKey}}`，是官方 union 的合法子集 |
| apiKeyId/accountScope/headers | NOT APPLICABLE | WIP 不提供；官方 schema 允许。差异为能力子集，非违约 |
| 请求绑定校验 | PASS | provider 必须是 `account:bigmodel-start-plan` 且 WIP 启用；`params.providerId` 冲突、`!acceptingTurn`、`turnId/sessionId` 与当前 Turn 不符、selectedModel 不符、已 abort 全部立即拒绝（`zcode-app-server-adapter.ts` WIP 块） |
| JWT 严格绑定 | PASS（交付与使用层） | 租约绑定 12 字段（account/provider/model/task/attempt/operation/generation/claim/session/turn/pid/creation）两侧 exactKeys 校验；Manager 侧逐字段复核 + probe 精确身份存活；adapter 侧每次回调再校验 scope/有效期/isValid。JWT token 内部 claims 内容 UNKNOWN（未解析 token） |
| 单次交付 | PASS | lease 状态机 active→checking→delivering→consumed/revoked；ACK 丢失/EOF/部分帧写入均 terminal，不重发（16 个专项测试覆盖：wrong-turn/wrong-claim/account-switch、双 Worker 抢租约、旧 Attempt 续租拒绝、lifetime EOF、ACK 丢弃等） |
| Provider 注册失败即停 | PASS | `headersApplied:false` 时 CLI 抛 "Provider request auth was not returned before model request attempt."；无 Bridge 侧重试 |

### 其他凭据回退路径 [master]

`runtimeAuthReply`（`account-provider.ts`，master 已发布）：对
`individual-coding-plan` 模式的 account provider，从真实 data root 的
`config.json` + `coding-plan-cache.json` 读取本地凭据回复 `requestAuth`；
对 Start Plan 一律返回 unavailable（fail-closed）。WIP 未改动该路径，
Start Plan 分支优先于它。Start Plan 自身无第二交付路径（单租约、不重发）。

**缺口（如实记录）**：生产环境的 `startPlanPrivateAuth` issuer（实时权益检查 +
真实凭据来源）未实现；当前仅有测试 fixture 的合成 issuer。即 [WIP] 只完成了
交付管道与消费合同，不具备生产可用性。`ARCHITECTURE_GATE_2.md` 要求的
HANDLE 持有身份门禁，WIP 用 probe（精确 fingerprint + alive）替代，
未持有进程 HANDLE——与门禁文档要求存在差距（文档自身标注
`Gate: PARTIAL / NOT APPROVED FOR IMPLEMENTATION`，而
`GATE2_EXECUTIVE_STATUS.md` 记录同日终审 APPROVED；两份文档状态需 Owner 裁决统一）。

## 2. AppServer Environment

| 检查项 | 判定 | 说明 |
| --- | --- | --- |
| 启动参数 | PASS | `node zcode.cjs app-server --stdio`，cwd=workspace，符合 ADR-001 |
| 协议握手 | PASS | 无 JSON-RPC initialize；会话经 `session/create|resume|setMode|setModel|subscribe|send|events` 建立 |
| `ZCODE_APP_SERVER_AUTH_MODE` | NOT APPLICABLE | CLI bundle 与 Bridge 全仓均无此变量；不得从其他项目照搬 |
| `ZCODE_APP_VERSION` Desktop 注入 | UNKNOWN | app.asar 定义常量但仅 1 处出现；未观测到 spawn 传参或子进程值。日志中 agent 版本始终 0.17.x |
| 环境变量白名单 | PASS | `createMinimalOsEnv` OS 白名单 + 显式 Bridge 键；[WIP] 对 Start Plan 直接附加一个官方键 `ZCODE_MODEL_RETRY_MAX_RETRIES="0"`（有注释、有条件、单键，未扩大继承面） |

## 3. Native Request Ownership

| 请求细节 | 判定 | 说明 |
| --- | --- | --- |
| System Prompt | PASS | CLI 原生构造；10-31 E2E 确认 `body.system` 三段；Bridge 无实现 |
| X-Device-Mid | PASS | CLI 读取 data root telemetry-state；Bridge 无生成/轮换代码 |
| App Version / User-Agent | PASS | CLI header builder 原生；Bridge 未硬编码 |
| Coding Plan request signature | PASS | Bridge 无签名实现（`x-client-sig`/`x-client-pow` 仅存在于 CLI） |
| X-Coding-Plan-Api-Key | PASS | 仅 CLI 消费 requestAuth 并安装该头；Bridge 只传递 apiKey 字符串 |
| SSE | PASS | CLI 原生 transport；Bridge 仅转发 session 事件 |
| Captcha verify param 消费 | PASS | CLI 原生消费 `X-Aliyun-Captcha-Verify-Param`；Bridge 无绕过、无伪造、无空凭据发送 |

`rg "fetch(|https://(zcode|open.bigmodel|bigmodel)" src` 在 Bridge 源码零命中。
禁止重实现 HTTP 细节的约束当前满足。

## 4. Captcha / Error / Retry

| 场景 | 判定 | 官方 CLI 行为 [CLI] | Bridge/WIP 行为 |
| --- | --- | --- | --- |
| 3007 captcha rejection | PASS | `CaptchaRequestRetry` 最多一次额外尝试（scope `captcha-retry`），需 Desktop 交互提供 verify param | 无 Desktop host，无法提供 param → 被挑战即失败，fail-closed，无绕过 |
| 3012 unusual activity | PASS | ProviderBusinessError，`retryable:false`（11-01 日志实证），不重试 | 同左；WIP 将 Start Plan 重试预算设为 0 |
| 405 JSON 响应 | PASS | 405 不在 AI SDK 重试集（408/409/429/>=500）→ 不重试；JSON body 进 provider 错误分类 | 11 月日志 maxRetries 10 但 `retryable:false` 实证一致 |
| 405 HTML WAF rejection | UNKNOWN | bundle 未发现 HTML 响应专项识别；实际进入哪种错误分类未验证 | 同左；不发送新请求验证 |
| 429 / 5xx / 网络失败 | PASS | 默认 maxAttempts 11（`ZCODE_MODEL_RETRY_*` 可调），backoff 2s→60s（factor 2 + jitter），尊重 `x-should-retry`/`Retry-After`；`abortSignal.aborted` 即停 | [WIP] Start Plan 场景 `maxRetries=0`：单次尝试，取消即止 |

取消行为：CLI 重试门 `B4e` 检查 `abortSignal`；Manager 侧取消先 abort 私有管道
（撤销未交付/已缓存租约）再走身份验证进程树终止 → scan clean → Release，
与 ADR-019/024 证据链一致。

## 5. Project Decision Compatibility

| 文档 | 判定 | 说明 |
| --- | --- | --- |
| ARCHITECTURE_GATE_2.md（本 worktree） | DIFFERENT（文档内不一致） | 方案选型（继承管道、FD10-13、单帧+ACK、EOF 撤销）与 WIP 实现一致；但文档要求 HANDLE 持有身份门禁，WIP 用 probe 替代；文档 Gate 标注与 EXECUTIVE_STATUS 的 APPROVED 相互矛盾，需 Owner 裁决 |
| ADR-001（app-server 生产路径） | PASS | WIP 全部经 ZCodeAppServerAdapter，未引入 legacy CLI 路径 |
| ADR-007（浏览器宿主） | PASS | 正交；sanitize 钩子不触碰 browser RPC |
| ADR-024（scoped hold，master 2026-11-04） | DIFFERENT | **不在 WIP 基线内**。master 自基线前进 52 提交（含 ADR-024/025、v1.6.0、hold 简化报告）。WIP 修改了 `sqlite-candidate-cancelled-worker-tree-v1` 证据 schema（新增 `worker_termination_signal`、允许 exitCode=null+signal），与 ADR-024 的 recovery 闭合条件相交，rebase 后需按 ADR-024 重新裁决；master 同期也修改了 lifecycle-gate/worker-main/adapter 与 `mvp-real-adapter.test.ts`（+58/-21），预期合并冲突 |
| sqlite-hold-simplification-2026-11-04.md（master REPORT） | DIFFERENT | 同上：基线不含。该报告明确"429/5xx/网络错误不自动重发"——WIP 的 maxRetries=0 与该精神一致，但 WIP 基于 ADR-024 之前的 cancellation 代码，需对照集成 |

与 SQLite Authority/Worker 生命周期/派发合同的核心结论：WIP 未绕过
Claim/Capacity/Release 所有权，private auth 全部挂在既有 Claim 之后
（claim_committed 后才建管道、发 envelope）；未发现与 Authority 的直接冲突，
但证据 schema 变更 + 基线落后使其**不能**直接进入生产集成，必须先
rebase 到 master 并按 ADR-024 复核取消/释放证据。

## 6. 禁止事项遵守声明

未修改现有 WIP 与生产代码（本审计仅新增本文档）；未生成/轮换 Device ID；
未刷新 OAuth；未领取 Token；未发送模型请求；未启用 Model I/O retention；
未修改 SQLite；未 push/merge/tag/release。审计过程曾误用 `rg -rn`
（`--replace` 显示标志），仅影响终端显示，未写入任何文件。
