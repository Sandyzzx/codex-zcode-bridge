# ADR-053：Runtime Auto-Learn 兼容性证据

> Status: DECISION
> Date: 2026-11-23
> Decision: Accepted for the next Preview candidate
> Related architecture: [BRIDGE_ASYNC_EXECUTION_V1.md](../architecture/BRIDGE_ASYNC_EXECUTION_V1.md)
> Related decisions: [ADR-042](ADR-042-unknown-runtime-experimental-authorization.md)、[ADR-050](ADR-050-local-task-web-console.md)、[ADR-054](ADR-054-safe-installed-runtime-without-static-version-gate.md)

## 决定

Operations Console 的 Runtime 页面复用现有
`OfficialAppServerRuntimeResolver`、安装安全检查、精确指纹授权和
Cost Lab 的只读协议 Smoke。它把已观察到的安装与兼容性事实保存为本地
证据，不用版本号推断兼容性，也不修改官方 Runtime 或生产兼容性 Manifest。

证据记录是兼容性观察材料，不是 Task Authority。默认存储位置为：

```text
<Authority Root>/.run/bridge-console/runtime-compatibility.json
```

该文件只保存安装身份、资产摘要、探针类型/范围、结果、Provider/Model
归属、来源、Digest、限制和错误分类；不保存凭据、Cookie、Authorization、
设备 MID 或私有认证材料。文件写入不是第二套任务状态机、恢复引擎或 Worker
执行路径。

## 证据分层

### Level A：自动静态检查

Runtime 页面首次打开或用户显式执行检查时，读取当前安装并记录：

- Desktop/AppVersion/BuildCommitId、Node 版本和精确安装指纹；
- 安装安全结论、Manifest 状态和实验授权状态；
- AppServer bundle、builtin Provider config、Runtime Host、Desktop
  executable/archive 的大小与 SHA-256；
- 与最近一次证据相比的变化资产。

静态检查不创建模型 Session、不读取凭据内容、不调用 Billing API，也不发送
模型请求。安装不安全时始终 hard block。

### Level B：显式零模型协议探针

安装安全通过后，用户可以显式启动既有 AppServer 协议 Smoke。探针只检查
启动、Protocol Initialization 和只读 `runtime/capabilities`，并要求
bounded Cleanup；不创建 Session，不发送模型请求。Manifest 命中、精确指纹
授权和签名状态不是额外执行门槛，只作为观察证据记录。

用户必须显式触发探针。安装不安全、不支持的平台或实际进程/协议失败均
fail closed；页面加载、环境变量或 UI 默认值不得隐式触发探针。

### Level C：真实 Provider E2E

真实模型执行、Billing 读取和折扣核对只能在当前精确指纹、Provider、模型
和预算获得独立授权后记录。Coding Plan、Start Plan 和其他 Provider 分别
验证，不互相提升。`Protocol PASS` 不等于模型执行 PASS；模型执行 PASS
不等于 Billing `VERIFIED`；`EXPERIMENTAL` 不等于生产 `VERIFIED`。

本轮开发授权不包含新的付费请求。未授权的真实 Provider 证据保持
`NOT_RUN / BLOCKED_BY_AUTHORIZATION`。

## 去重、比较和候选报告

- 证据以 exact installation fingerprint 为核心身份；改变指纹不继承旧版本的
  Provider、Billing 或 Cleanup 结论。
- 相同 fingerprint 与相同语义证据去重；不同指纹的历史保留用于比较。
- 最新快照分开报告 `RUNTIME_CHANGED`、变化资产、当前指纹证据和 Provider
  能力矩阵。
- Candidate Report 只生成待审查的 Manifest/证据摘要，固定声明
  `production_manifest_modified: false`、`experimental_promoted: false`、
  `provider_authorization_granted: false`，并要求 Owner 评审。
- 损坏、缺字段、Digest 不符或超出本地大小上限的证据文件 fail closed。

## UI 与安全边界

Runtime 页面显示 Current Installation、Safety、Manifest、Capability
Matrix、Evidence History、Detected Changes 和授权缺项。Run Static Check
和 Run Authorized Protocol Probe 是显式动作；页面自动加载与主题/语言切换
不触发 Billing、协议探针或模型请求。

所有 HTTP 入口仍只绑定 loopback，沿用 Operations Console 的 Host、Origin、
CSRF、same-site 和 bounded JSON 校验。真实 Provider 操作不得由页面加载、
历史读取或 Runtime Candidate Export 隐式触发。

## 验证边界

当前定向测试覆盖静态证据指纹绑定与去重、安全安装上的显式零模型协议探针、
Fingerprint 切换、Provider scope 隔离、Billing INCONCLUSIVE、损坏证据
fail closed、Manifest 不变和浏览器零模型/零 Billing 页面加载。真实 Desktop
更新后的 Provider、Billing 和折扣证据仍需独立授权；这些测试不能写成真实
Runtime E2E。
