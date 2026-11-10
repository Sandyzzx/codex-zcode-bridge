> Status: RESEARCH
> Last updated: 2026-11-10
> Last verified: 2026-11-10（安装包合同、实现候选、定向回归、完整隔离回归与 Astra 审查）
> Verified against: Bridge `61c78b7c637432d3d39768c48030609d6dbf253a` + 本文所述实现候选

# ZCode Desktop Host Startup Compatibility

## 结论

已实现 Owner 批准的最小 Host 启动兼容改造：

- AppServer 启动参数增加且只增加一次 `--surface desktop`。
- 从已安装官方 ZCode Desktop 的 ASAR 元数据动态读取应用版本与构建提交。
- 将 `ZCODE_APP_VERSION` 与 `ZCODE_BUILD_COMMIT_ID` 注入 AppServer 子进程。
- 任务 Adapter 和模型目录探测共用同一个启动边界。
- Start Plan 与 Coding Plan 使用同一 Host 兼容输入，没有按套餐分叉。

本次没有改写 HTTP Header、Request Body、System Prompt、Tool、Session/Query 身份、Runtime Auth、Billing、Provider 注册或 SQLite 生命周期。

该改动消除了已确认的 Desktop Host 启动输入差异，但**不证明历史 HTTP 405 已修复**。

## 官方合同核验

### 安装运行时

| 项目 | 观测值 |
|---|---|
| ZCode Desktop | `3.17.2.9661` |
| Desktop executable SHA-256 | `7ACA3AEAB3D3B775A39CF9CBE048B30A80278D3527B6FBCFD0E7B00F79A2C326` |
| AppServer | `0.17.1` |
| AppServer bundle | `resources/glm/zcode.cjs` |
| AppServer bundle SHA-256 | `D9AFD58D694F98A5279BF548CDC7646413C125762E86730605A6071F9E0346D6` |
| Desktop ASAR | `resources/app.asar` |
| Desktop ASAR SHA-256 | `B11A6BC5BB957AF5B735701D94452EC6C3119A5D957FB772EB40A3CC94BCB24C` |

从实际安装 ASAR 读取到：

```yaml
PACKAGE_VERSION: 3.17.2
BUILD_META_APP_VERSION: 3.17.2
BUILD_META_COMMIT: a2d1ba73
```

### Surface

- 安装的 Desktop Host bundle 在 `presentationSurface === "desktop"` 时移除已有的 `--surface`，并追加 `--surface desktop`。
- 安装的 AppServer CLI 明确定义 `--surface <surface>`，并规范化为 `zcode_desktop`。
- 因此最终启动参数为：

```text
app-server --stdio --surface desktop
```

### 环境变量

- 官方名称：`ZCODE_APP_VERSION`、`ZCODE_BUILD_COMMIT_ID`。
- Desktop Host 从编译期应用版本和构建元数据提供这两个值。
- AppServer 从 `ZCODE_APP_VERSION` 构造 `User-Agent` 与 `X-ZCode-App-Version`；`ZCODE_BUILD_COMMIT_ID` 进入构建身份/Telemetry。

安装 ASAR 的源码与本机官方只读源码
`.run/zcode-official-source-20261110`（HEAD `a9fe401e`）在这些合同上相互一致。

## 实现

### 元数据解析

新增 `src/runtime/desktop-host-launch.ts`：

- 从 AppServer 入口旁定位 `resources/app.asar`。
- 读取 ASAR 根 `package.json` 与 `out/metadata/build-meta.json`。
- 官方 ASAR 文件表的 `offset` 为十进制字符串、`size` 为数字；解析器同时接受两者的安全整数或十进制字符串形式并校验范围。
- `package.json.version` 与 `build-meta.appVersion` 必须一致。
- 构建提交必须为 8 位小写十六进制。

失败语义：

| 状态 | 行为 |
|---|---|
| 元数据有效 | 注入动态版本与构建提交 |
| ASAR 或构建元数据缺失 | 保留官方 surface，不注入 Desktop 身份，AppServer 使用原 CLI 身份 |
| JSON/字段/格式损坏 | `provider_config_invalid` fail-closed |
| 两个来源的版本冲突 | `provider_config_invalid` fail-closed |

### 启动接线

两个实际 Spawn 边界均使用同一最终 argv/env：

- `src/adapters/zcode-app-server-adapter.ts`
- `src/runtime/model-settings.ts`

Start Plan、Coding Plan 和模型目录探测都不含按套餐选择 Host 身份的分支。

生成物已由源码重建：

- `plugins/codex-zcode-bridge/dist/bridge.mjs`
- `plugins/codex-zcode-bridge/worker/worker-main.mjs`

## 测试

### 新增契约测试

`test/desktop-host-launch.test.ts` 使用合成 ASAR 与实际子进程检查最终 argv/env：

- surface 恰好出现一次。
- 动态版本传播。
- 动态构建提交传播。
- 元数据缺失。
- 元数据格式错误。
- 不支持的版本格式。
- 安装元数据版本冲突。
- 既有环境保留。

### 回归结果

| 范围 | 结果 |
|---|---|
| Desktop Host 启动契约 | 5 / 5 PASS |
| AppServer Adapter（含 Start Plan / Coding Plan） | 35 / 35 PASS |
| Account Provider + Start Plan Credential/Auth | 30 / 30 PASS |
| Adapter → Worker → SQLite → Start Plan 合成链路 | 45 / 45 PASS |
| Test Impact 选择 | `FULL_SUITE`（合法，因为映射本身发生变更） |
| 完整隔离回归 | 877 total / 876 PASS / 1 SKIP / 0 FAIL |
| 完整回归耗时 | 1,248,936 ms（约 20 分 49 秒） |

完整门禁同时执行并通过：

- Typecheck
- Build
- Plugin Validation
- `git diff --check`

### 实际安装元数据只读验证

在当前源码构建后，使用实际安装入口：

```text
C:\Users\Sandy\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs
```

`buildZCodeAppServerLaunch()` 只读返回：

```yaml
ARGS: ["app-server", "--stdio", "--surface", "desktop"]
ZCODE_APP_VERSION: 3.17.2
ZCODE_BUILD_COMMIT_ID: a2d1ba73
```

该验证没有启动真实 Bridge 会话，也没有发送 OAuth、Billing、Provider、Claim 或模型请求。

## 独立审查

独立审查覆盖：

- 官方合同与启动参数正确性。
- 安装元数据发现与 ASAR 字符串偏移处理。
- 最终 argv/env 传播。
- 缺失、损坏、冲突元数据行为。
- Start Plan / Coding Plan 回归。
- 生成 Bundle 范围与无关复杂度。

未发现实质性阻断问题。

## 未运行与边界

- 没有发送真实 Start Plan Billing 或模型请求。
- 没有 OAuth 登录、Device ID 修改或凭据写入。
- 没有修改生产 SQLite、Hold、Workspace 或认证状态。
- 没有提交、Push、Merge、Tag 或 Release。
- HTTP 405 的根因仍为 `UNCONFIRMED`。

## 最终状态

```yaml
OFFICIAL_SURFACE_CONTRACT: VERIFIED
APP_VERSION_SOURCE: VERIFIED
BUILD_COMMIT_SOURCE: VERIFIED

DESKTOP_SURFACE_ARGUMENT: PASS
APP_VERSION_PROPAGATION: PASS
BUILD_COMMIT_PROPAGATION: PASS

STARTPLAN_REGRESSION: PASS
CODING_PLAN_REGRESSION: PASS
TYPECHECK: PASS
BUILD: PASS
PLUGIN_VALIDATION: PASS

ASTRA_REVIEW: APPROVED

REAL_MODEL_REQUESTS: 0
BILLING_REQUESTS: 0
OAUTH_LOGIN: NO
DEVICE_ID_MODIFIED: NO

PRODUCTION_SQLITE_MODIFIED: NO
UNRELATED_WIP_MODIFIED: NO

V4_RPC_MIGRATION: DEFERRED
FINAL_VERDICT: PASS
```
