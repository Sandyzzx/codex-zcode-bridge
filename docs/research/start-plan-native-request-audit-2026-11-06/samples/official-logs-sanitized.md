# Sanitized Request Samples（官方日志原样行）

> 来源：`~/.zcode/cli/log/zcode-2026-11-*.jsonl`（官方客户端本地日志）。
> 日志由官方 producer 脱敏（`set-cookie`、usage 已为 `[Redacted]`）；经核验不含 JWT。

## Sample A — Bridge 面 Start Plan 模型请求被 405 + 3012 拦截（2026-11-01）

```json
{"timestamp":"2026-11-01T02:56:43.848Z","level":"error","event":"turn.failed","module":"core.runtime","message":"Turn failed","sessionId":"session_70bc9f2142eea420f81defb03fc14d71","turnId":"turn_5651d012-a174-4e24-bc50-9d974e2fcd78","status":"failed","context":{"queryId":"01a19509-af57-7720-af83-15cae577216a","turnNumber":30,"turnPhase":"processing_input"},"error":{"name":"Error","message":"Turn execution failed","code":"UNKNOWN_ERROR","cause":{"name":"AiSdkModelAdapterError","message":"request has been blocked due to unusual activity.","code":"model_request_failed","context":{"attempt":1,"maxAttempts":11,"modelId":"GLM-5.3-Flash","errorPhase":"stream","exceptionKind":"provider_business","providerCode":"3012","providerId":"account:bigmodel-start-plan","providerKind":"anthropic","responseBodySummary":{"type":"error","error":{"code":"PROVIDER_BUSINESS_ERROR","isProviderBusinessError":true,"providerCode":3012,"providerId":"account:bigmodel-start-plan","providerKind":"anthropic","providerMessage":"request has been blocked due to unusual activity.","responseBodySummary":{"keys":["code","msg","logid"],"code":3012,"msg":"request has been blocked due to unusual activity."},"responseHeaders":{"connection":"keep-alive","content-type":"application/json; charset=utf-8","eagleid":"6f06e79317935018044963802e","server":"ESA","set-cookie":"[Redacted]","via":"ens-cache11.l2nm125-7[54,0,DP], ens-cache13.cn9532[71,0,DP], ens-cache13.cn9532[72,0]","x-content-type-options":"nosniff","x-request-id":"20261101025644cf74873f4fed4319546c","x-site-cache-status":"DYNAMIC"},"responseStatus":405}},"responseStatus":405,"providerId":"account:bigmodel-start-plan","requestId":"c48573e6-46fe-495a-b604-103ae40569f6","statusCode":405,"transport":"sse"}}}}
```

workspace 归属：`D:\codex-zcode-bridge\.run\admin-abandoned-20261101\...`（面归属：Bridge 侧执行目录）。

## Sample B — Start Plan 端点连通性检查 405（2026-11-06，面归属 UNKNOWN）

```json
{"timestamp":"2026-11-05T16:55:04.939Z","level":"warn","event":"model.request.failed","module":"adapters.model","message":"Model request attempt failed","sessionId":"sess_f901dc3a-4377-45e4-90ad-75f154af9bca","durationMs":304,"status":"failed","context":{"attempt":1,"baseURL":"https://zcode.z.ai/api/v1/zcode-plan/anthropic","maxAttempts":11,"maxRetries":10,"modelId":"GLM-5.3-Flash","providerId":"account:bigmodel-start-plan","providerKind":"anthropic","querySource":"provider_settings_connectivity","requestId":"a7d46605-6053-43ac-966f-ab39432b36b9","transport":"sse","reason":"unknown","retryable":false,"statusCode":405,"statusMessage":"Model request failed."}}
```

## Sample C — 成功对照：individual-coding-plan（非 Start Plan 端点，2026-11-05）

```json
{"timestamp":"2026-11-05T15:59:56.268Z","level":"info","event":"model.network.completed","module":"core.runtime","message":"Model network request completed","sessionId":"sess_d081fbc1-b2a5-4c2c-90f4-7471a2ccb4e5","turnId":"turn_112ef96b-085b-4805-9bb5-0dca4e89663d","durationMs":3032,"status":"completed","context":{"queryId":"query_c5bc43cf-21fe-47d7-a407-41ffc85cdf38","turnNumber":0,"providerId":"account:bigmodel-individual-coding-plan","modelId":"GLM-5.3-Flash","iteration":8,"querySource":"main_turn","attempt":1,"baseURL":"https://open.bigmodel.cn/api/anthropic","maxAttempts":11,"providerKind":"anthropic","requestId":"658b5741-5cb0-498e-9daf-eccba72eafc1","transport":"sse","finishReason":"tool-calls"}}
```

## Sample D — deviceMid 状态文件结构（值部分脱敏）

```json
{"deviceMid":"d10352ec-87e5-4106-9101-****redacted****","lastDailyActiveDate":"2026-09-06"}
```

完整值仅存于 `~/.zcode/v2/telemetry-state.json`（本机）。

## Sample E — 2026-10-31 归档 E2E 成功元数据（Bridge 面，摘自归档报告）

```text
2026-10-31 00:19:30 +08:00  首个模型响应成功
  request  dcda6e7d-b20b-40ad-b601-a44a8df42f5a
  x-request-id 202610301619274db7dea8b0c91912d446
  x-log-id    20261031001927a169a2e6e1494103
2026-10-31 00:27:52 +08:00  tool-loop 后续响应成功
  x-request-id 202610301627464dc3c2ee12fda3259066
  x-log-id    20261031002746f4b69a306a744338
```
