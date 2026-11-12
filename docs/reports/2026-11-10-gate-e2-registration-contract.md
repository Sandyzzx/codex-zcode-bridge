# Gate E2 Provider Registration Contract Repair

> Status: RESEARCH
> Date: 2026-11-10
> Base commit: `064d23ce2d46aa7cda4519cc495f849e4fb60f22`
> Official runtime observed: ZCode AppServer 0.17.1

## 结论

正式 Gate E2 在 `provider/updateAccountConfig` 阶段失败的 Bridge 侧根因已确认：
任务级 Account Snapshot 对未选中 account Provider 省略了 `current`，而官方
AppServer 0.17.1 要求 Snapshot 中每个 account Provider 都带布尔 `current`。

原始 Gate E2 没有保留 AppServer RPC 错误正文，因此原始运行的 RPC code 与
`data.code` 仍标记为 `NOT_OBSERVABLE_IN_ORIGINAL_RUN`。本轮没有把 Bridge 公共错误码
`provider_config_invalid` 冒充为原始 RPC 错误码。

使用隔离数据目录、合成 Provider 状态和实际安装的 AppServer 0.17.1 复现后得到：

```yaml
current_bridge_payload_before_fix:
  registration: FAIL
  rpc_code: -32603
  message_class: ACCOUNT_STATE_MISSING_CURRENT
  missing_provider: account:bigmodel-individual-coding-plan
```

## 官方合同观察

单变量离线矩阵确认：

1. Start Plan 与 Coding Plan 可同时存在于 Snapshot，二者均可为 `entitled: true`。
2. 任务只能有一个 account Provider 为 `current: true`。
3. 任一 account Provider 缺少布尔 `current` 会使注册 RPC 失败；删除非选中
   Coding Plan 的 `current` 会得到上述 `-32603`。
4. 即使注册 RPC 接受，若整组 account Provider 没有稳定布尔执行状态，模型目录可能为空。
5. `basedOnZCodeBuiltinRevision` 与官方 Built-in 来源不一致时，0.17.1 的注册 RPC
   仍可能返回成功，但后续模型目录为空。因此“RPC 成功”不能单独证明 Built-in
   Revision 合同正确。
6. Bridge 使用实际 Built-in 文件路径哈希生成的 revision 后，完整 Snapshot 可被接受，
   `session/create` 会广告 Start Plan 的三个模型。

第 5 条是本轮新增的 Observed 行为，不扩展为跨版本官方合同。

## 最小修复

`src/runtime/account-provider.ts`：

- 任务级 Snapshot 中，所有 account Provider 都发布布尔 `current`。
- 仅任务选中的 Provider 为 `true`，其余为 `false`。
- 其他权益、JWT、Device ID、Billing、Private Lease、HANDLE 和生命周期逻辑未改。

`src/adapters/zcode-app-server-adapter.ts`：

- 复用 ADR-011 的私有 `FactsCandidate` 和 `FailureFactsV1` 管道。
- 注册 RPC 拒绝仍保留公共错误码 `provider_config_invalid`。
- 安全诊断仅保留受控枚举和注册表字段：
  `failure_stage`、`failure_kind`、`rpc_method`、`rpc_error_code`、`rpc_data_code`。
- 不把 AppServer 原始 message、凭据、Device ID、账户身份或请求正文写入 Result、
  Event 或 FailureFacts。

## 原生 AppServer 验证

隔离证据：

`D:\codex-zcode-bridge\.run\gate-e2-registration-contract-repair-20261109\.run\native-registration-source-selection\transcript.json`

最终结果：

```yaml
official_app_server: 0.17.1
missing_current_negative: RPC_REJECTED (-32603)
bad_builtin_revision: RPC_ACCEPTED_BUT_MODEL_CATALOG_EMPTY
source_snapshot_registration: PASS
source_snapshot_start_plan_models: 3
session_create: PASS
session_set_model: PASS
session_close: PASS
session_send: NOT_CALLED
app_server_exit_code: 0
real_billing_requests: 0
real_model_requests: 0
```

模型选择使用 `session/create` 返回的官方
`settings.model.available[].reasoning.defaultLevel`，没有猜测 reasoning 参数。

## 测试与门禁

定向测试覆盖：

- 任务选中 Start Plan 时，Coding Plan 与其他 account Provider 均为 `current: false`。
- 任务选中 Coding Plan 时，Start Plan 与其他 account Provider 均为 `current: false`。
- 所有 account Provider 状态都有布尔 `current`，且恰好一个为 `true`。
- 注册 RPC 拒绝保留 `-32603` 和已登记 `data.code`。
- AppServer 异常退出与 RPC 拒绝分类不同。
- 上游敏感文字不进入公共 Result、Event、FailureFacts。
- Start Plan 注册失败不创建 Session、不发送 `session/send`。
- Coding Plan 注册失败后的既有行为不变。

门禁结果：

```yaml
targeted_tests: 93 PASS
typecheck: PASS
build: PASS
plugin_validation: PASS
diff_check: PASS
```

同一组测试在并行交叉运行时曾出现 2 次既有 Windows cleanup 竞争：
预期的 Provider 公共错误被 `cleanup_failed` 覆盖。两次失败均未修改断言；单测复跑
以及 `--test-concurrency=1` 的 52/52 复跑均通过。该现象与本轮注册合同修复无因果关系，
保留为既有 Windows 清理残余风险。

## 未执行与边界

- 没有重新执行正式 Gate E2。
- 没有发送真实 Billing、OAuth、Claim、CAPTCHA 或模型请求。
- 没有读取、复制或输出真实凭据、JWT、Cookie、Device ID 或账户身份。
- 没有修改生产 SQLite、Hold、官方 `.zcode` 配置或 Device ID。
- 本轮不证明账户侧风控、3012 或真实模型响应成功；这些问题仍需独立授权后的真实 E2E。
