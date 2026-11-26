# ADR-066：官方运行期 Registry、Task 续作与 Session 恢复分离、RPC 失败诊断

> Status: DECISION
> Date: 2026-11-26
> Decision: Accepted（Owner 在 Preview.20 任务中明确批准）
> Baseline: `origin/preview` `f77a6176508f20bad73b8605b44a04703bacf231`（Preview.19）
> Related: ADR-021（路径发现）、ADR-026（Result 合同）、ADR-065（动态模型发现）
> Supersedes（仅限）: `docs/INTERFACES.md` 中“公开事件和诊断不转发原始 RPC error”的绝对表述；
> ADR-011 `FailureFactsV1` 与公开错误 message 合同本身不变。

## Context

真实任务 `CAD2BIM_RM12_P1_GLM54_20261126` 两次 Attempt 均在模型执行前失败，根因已闭环：

1. **Registry 来源错误。** Bridge 把 AppServer 的 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 与
   Account Overlay 都固定到安装目录的静态 Built-in 配置（Observed：revision 44），而安装版
   Desktop 实际加载的是运行期 Registry（Observed：revision 48）。静态 revision 不含任务指定的
   模型，`session/setModel` 返回 `-32603 / model_not_found`。Overlay 逐条复制
   `builtinModelIds`，构成模型发现的间接闸门。
2. **Continue 把 Task 续作等同于 Session 恢复。** 只要 `previous_result.session_id` 非空就
   无条件 `session/resume`。上一次 Attempt 仅完成初始化、没有真实 Turn，Session 没有可恢复的
   持久化行，`session/resume` 返回 `-32603 / project.session-lineage-invalid`；失败 Result 继续
   携带同一 ID，再次 Continue 会重复失败。
3. **RPC 失败证据丢失。** Adapter 只保留 method 与数值 code 并重写 message，原始 `message`、
   `data.name`、`data.code`、`stack` 未持久化，事后只能靠复现推断。

零模型探测（安装版 `zcode.cjs` 0.18.0，sha256 `0de95ddd…`）已确认：

- 运行期 Registry（revision 48）下 Coding Plan 目录为 3 个模型，`GLM-5.4 / max` 可设置并精确
  回读；安装目录 Registry（revision 44）下只有 2 个模型。
- Overlay 复制 `builtinModelIds` 与完全省略该字段，`provider/updateAccountConfig` 与目录结果
  一致（Observed：overlay schema 中 `builtinModelIds` 可省略，省略即继承 Registry 成员；官方
  standalone 账户源从不携带该字段）。
- AppServer env 与 Overlay 的 Registry revision 不一致时目录为空。

## Decision

### 1. 官方运行期 Built-in Registry

Bridge 与安装版 Desktop 使用同源的官方 Built-in Registry。以下路径与选择规则是对 Observed
（ZCode Desktop 4.0.0.10870，`zcode.cjs` 0.18.0）行为的独立镜像，不是官方合同；官方行为变化时
以实测为准。

**路径。** `<dataBaseDir>/.zcode/v2/runtime/provider/<platform>/<appVersion>/endpoint-<hash>/zcode-builtin.json`

- `dataBaseDir`：personal provider 配置所在的 `<base>/.zcode/v2` 的 `<base>`，即 Bridge 已校验
  并传给 AppServer 的 `ZCODE_DATA_BASE_DIR`；`ZCODE_HOME` 已含 `.zcode` 时取其父目录。
- `platform`：`win32` 记为 `windows`，其余取 `process.platform`；架构 `arm64` 记为
  `aarch64`、`x64` 记为 `x86_64`。
- `appVersion`：安装版 `app.asar` 的 `out/metadata/build-meta.json` 的 `appVersion`，即 Bridge
  既有的 `buildZCodeAppServerLaunch` 来源；无法取得时不做运行期发现。
- `hash`：Endpoint origin 的 SHA-256 前 32 位十六进制。origin 取 `ZCODE_BASE_URL` →
  `ZCODE_ENDPOINT_ORIGIN` → 测试环境 `ZCODE_TEST_BASE_URL` / 生产环境
  `ZCODE_PRODUCTION_BASE_URL` → 官方默认值，并按 `new URL(...).origin` 规范化。

**选择。**

1. 不跨 Endpoint、Desktop 版本或数据根搜索，不选择“最新”目录；只定位上述唯一路径。
2. 运行期文件缺失、不是普通文件（含符号链接）、不是合法 JSON，或不满足
   `schemaVersion === 1`、`revision` 为非负安全整数、`config.providerConfigRules` 与
   `config.modelConfigRules` 均存在时，回退官方安装目录的 Built-in 配置。
3. 两者均有效时：revision 相同而内容不同，取安装目录；否则取 revision 较高者，并列取安装目录。
4. 每次解析运行时配置（即每次 AppServer 启动）都重新选择，Bridge 不缓存、不下载、不更新、
   不改写任何官方文件。
5. 显式 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 等于同一安装的 Built-in 文件时视为默认值而非
   固定（这是旧安装器遗留的派生路径，Preview.19 及之前的生产配置即为此值，仅拼写不同的同一
   文件同样视为默认）；指向其他文件时是显式固定，跳过运行期发现。需要固定 Built-in 配置时，
   使用安装目录之外的文件副本。

   生效范围的变化如实记录：基础 `NodeRuntimeResolver` 一直尊重显式固定；但
   `OfficialAppServerRuntimeResolver.resolve()` 自 `20da3ca6` 起把 Built-in 文件无条件改写为该安装
   的 bundled 文件，生产链路此前并不尊重固定。本次两个 Resolver 改用同一判定函数，生产链路
   自此尊重显式固定。

**同源。** AppServer 子进程 env、Account Overlay 与 Model Catalog 共用同一个已解析的
`providerBuiltinConfigFile`。Adapter 在 AppServer 启动后、注册 Overlay 前复核该文件的 Registry
身份，与 Overlay 所依据的身份不一致时以 `provider_config_invalid` 失败，不重试，不发送模型请求。
Detached Worker 继承 Endpoint 相关的非秘密环境键，保证 Worker 与 Executor 定位同一 Registry。

**安装身份不变。** `OfficialAppServerRuntimeDescriptor` 的 `builtin_provider_config_*`、安装指纹
与 Manifest 比对继续绑定安装目录的静态文件；新增 `active_builtin_provider_config_path`、
`active_builtin_provider_config_source`（`runtime` | `bundled`）与
`active_builtin_provider_config_revision` 描述实际生效的 Registry。

### 2. Account Overlay 继承官方模型成员

Overlay 不再输出 `builtinModelIds`。Coding Plan 与 Start Plan 的账户模型成员都由 AppServer 实际
加载的官方 Registry 决定；`access`、`states`、`basedOnZCodeBuiltinRevision` 合同不变。

### 3. `configure-runtime.ps1` 持久化规则

仅当 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 是显式且不等于同安装 Built-in 文件的路径时才写入
`runtime-config.json`；默认派生路径写入 `null`，以清除旧安装器留下的静态路径。脚本仍校验安装目录
Built-in 文件，因为它是运行期 Registry 不可用时的回退。

### 4. Task 续作与 Session 恢复分离

- Task 续作：同一 Task 新建 Attempt，规则不变（completed / failed / waiting_for_master 且已
  Release）。
- Session 恢复：只在“有效历史执行上下文”存在时进行。有效历史执行上下文指与
  `previous_result.session_id` 相同 Session 的历史 Result 中，任一具有非空 `model.turn_id`、
  报告了 token usage，或状态为 `completed` / `waiting_for_master`。
- Manager 在派发前用既有 Task Console 投影对同一 Session 做有界回溯（最多 32 个 Attempt，遇到
  不同 `session_id` 即停止），把 `{session_id, resumable, reason, evidence_attempt,
  scanned_attempts}` 作为可选键 `session_history` 放入既有执行 envelope。不新增 SQLite Schema、
  状态机、恢复服务或全局门禁。
- Worker 只在 `resumable === true` 时 `session/resume`；否则新建 Session，Continue prompt 不声明
  `PERSISTED SESSION`。
- 有效历史 Session 的 `session/resume` 被拒绝时，Attempt 以 `session_not_resumable` 明确失败，
  不回退新建 Session，不发送模型请求；Result 保留该 `session_id` 作为执行证据。
- 最新同 Session Result 的 `error_code` 为 `session_not_resumable` 时，后续 Continue 不再把该 ID
  当作续作句柄，改为新建 Session。
- 不使用 `session/read` 判断 Session 是否存在。

### 5. Continue 的模型校验

Continue 使用 Task 持久化的 Provider / Model / Reasoning，不改写、不切换套餐。`continueTask`
在幂等 replay 之后、创建新 Attempt 的 CAS 之前，用实时 AppServer 目录精确校验该选择：Provider +
Model 必须存在，显式 Reasoning 必须在该条目可用；不满足时以 `provider_config_invalid` 失败，
不创建 Attempt。Task 未指定模型时不校验。

### 6. RPC 失败诊断

失败的 Result 可携带可选字段 `rpc_diagnostics`（`status === "failed"` 专用）：最多 4 条，按
method + code + data_code 去重，总大小不超过 8 KiB。每条包含：

| 字段 | 界限 |
|---|---|
| `method` | 官方 RPC method 形状，≤128 字符 |
| `code` | JSON-RPC 整数 code 或 `null` |
| `message` | 脱敏后 ≤500 字符 |
| `data_name` | ≤64 字符 token 或 `null` |
| `data_code` | ≤128 字符 token 或 `null` |
| `stack`（可选） | 仅函数名与 `basename:line:col`，去掉全部目录；≤12 帧、≤1200 字符 |

统一脱敏 Bearer、JWT、API Key、`key/token/secret` 赋值形态与长十六进制串，去除控制字符。不保留
请求或响应 payload、params、headers。超时与取消不携带诊断。

`zcode_result(view: "summary")` 任何情况下都不返回 stack：小结果原样返回但去掉 stack；进入投影的
结果保留紧凑诊断（message ≤240 字符）并在 `omitted_fields` 标记 `rpc_diagnostics.stack`。完整
诊断通过 `view: "full"` 读取。该字段为 additive 可选字段；携带它的 Result 不能被不认识该字段的
旧版本读取，与既往 `usage` / `model` / `timing` 的加性字段风险相同。

## Non-Changes

- 不硬编码 revision、模型 ID、版本目录、Endpoint hash 或用户路径。
- 不建立 Bridge 自己的 Registry 下载、更新或缓存服务。
- 不修改账户权益、用户指定的 Provider / Model / Reasoning，不自动切换套餐。
- 不改 SQLite Schema 与 Authority、Executor / WebUI 架构、任务状态语义、Wake、Cleanup、Release。
- 不改变 ADR-065 的实时模型发现、Start Plan 后缀与套餐选择合同。
- 不新增日志系统；Runtime Events 的类型集合不变。

## Verification

决策依据：安装版 AppServer 零模型探测（Overlay 复制与省略 `builtinModelIds` 对照）、安装目录与
运行期 Registry 的 revision 与模型成员比对、AppServer 日志中的 Registry 身份。候选实现的测试、
真实 Coding Plan `GLM-5.4 / low` E2E、CI 与发布证据由 Preview.20 交付报告记录。真实 Start Plan
权益目录在本账户不可测，保持 `NOT_RUN`。
