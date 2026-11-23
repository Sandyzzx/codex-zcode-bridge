# ADR-054：安全安装版 Runtime 不以静态版本或指纹作为执行门槛

> Status: DECISION
> Date: 2026-11-23
> Decision: Accepted for the Preview 4.0 runtime-integration candidate
> Related decisions: [ADR-040](ADR-040-installed-official-appserver-runtime.md)、[ADR-042](ADR-042-unknown-runtime-experimental-authorization.md)、[ADR-053](ADR-053-runtime-auto-learn-compatibility.md)

## 背景

Bridge 原先把兼容性 Manifest、Authenticode、精确 SHA-256、安装指纹和
实验授权同时用作 Runtime 启动门槛。该设计可以避免未知版本自动获得支持
声明，但也会在官方 Desktop 正常升级后，仅因 Bridge 尚未发布新的静态
Manifest 条目而阻断本地执行。

ZCode Desktop 是按用户环境独立更新的产品。版本、文件摘要、签名主体、
签名 thumbprint 和安装指纹适合作为诊断与证据身份，不足以单独证明
AppServer 进程能否启动或协议是否兼容；反过来，静态值完全匹配也不能证明
Session、Provider、Billing 或模型请求一定可用。

## 决定

### 1. 安装安全与执行准入

官方安装版 Runtime 只有在以下本机事实成立时才允许尝试启动：

- Windows x64；
- 安装根为绝对路径、canonical 普通目录；
- AppServer bundle、builtin Provider config、runtime-host、Desktop
  executable 和 Desktop archive 均位于同一安装根，且为普通文件；
- 路径解析不逃逸安装根、不经过不安全重解析；
- Desktop executable 和 runtime-host 为 x64 PE；
- 配置的 Node 可执行文件可以运行并返回可解析的 Node 版本；
- 启动后的实际进程身份、Protocol Initialization 和后续运行时检查仍按
  现有合同执行。

缺少文件、混合安装根、symlink/reparse escape、非 x64 PE、无法执行的 Node、
不支持的平台或实际进程/协议失败仍 fail closed。

### 2. 静态身份只作诊断

Desktop 版本、AppVersion、BuildCommitId、文件大小、SHA-256、Authenticode
状态、签名主体、签名 thumbprint 和安装指纹继续被观察、显示和记录，但不
再单独阻断安全安装启动。

`OFFICIAL_RUNTIME_UNVERIFIED` 保留为内部描述符状态，含义收敛为
“当前安装不在已审查的 Manifest 中”，不再表示“禁止执行”。`manifest`
仍为 `null`，不得把未知版本提升为生产兼容或 Provider 验证通过。

不静默回退到 Bridge 打包的 AppServer。实际启动失败时，错误应指向所发现
安装版的真实进程或协议失败，而不是先被静态版本门禁改写。

### 3. Provider 能力独立验证

Coding Plan 折扣、Start Plan 静态兼容、账户授权、Live Entitlement、
Private Credential Lease、Provider registry、模型注册和官方 Provider
错误继续独立验证。Manifest 中的 `coding_plan_discount_verified` 或
`start_plan_static_compatibility` 仅作为诊断字段，不再作为对应
Provider 的执行前静态阻断。

本决定不改变：

- 真实账户授权和 Start Plan Live Entitlement；
- Private Lease、HANDLE/ACK、Secret Redaction；
- Provider Authentication、Model Routing 或 Billing 所有权；
- SQLite v14、Task/Attempt/Operation/Result、AgentReport、Wake、
  Cleanup/Release/Recovery 和公共 MCP Schema。

### 4. 零模型探针与 Auto-Learn

安装安全通过后，用户显式触发的零模型 Protocol Smoke 不再要求 Manifest
命中或实验授权。探针只执行 AppServer 启动、Protocol Initialization、
只读 `runtime/capabilities` 和 bounded Cleanup；不创建 Session，不发送
模型请求。

探针成功后，以当前精确安装指纹记录 `PROTOCOL_PASS` 证据。该证据只说明
当次安装上的启动、初始化和能力读取成功，不提升 Model、Provider、Billing、
Cleanup 或生产支持等级。

### 5. 与 ADR-042 的关系

ADR-042 的“安装安全与 Manifest 兼容分离”继续有效；其“安全未知安装必须
先获得精确指纹实验授权才能执行”的门槛由本决定替代。

旧授权文件可以继续读取，但仅作为历史诊断证据，不再是启动或零模型探针的
前置条件。本决定不删除旧授权文件，不将旧授权自动改写为 Manifest 兼容。

## 结果

- 官方 Desktop 更新后，Bridge 可以先安全启动并观察真实兼容性。
- 静态审查继续保留，但不会把尚未发布 Manifest 的正常升级误判为不可执行。
- Provider、Billing 和真实模型成功仍需各自证据；静态观察不能冒充真实验证。
- 启动失败更接近真实原因，Cleanup 仍只接受可证明的进程与资源事实。

## 验证要求

- 已知安全安装继续正常启动；
- 未知但安全的安装可启动，并保留 `manifest: null`；
- 签名、摘要、版本或指纹变化只改变诊断/证据身份，不单独阻断启动；
- 混合根、非普通文件、逃逸路径、非 x64 PE、不可执行 Node 和不支持平台仍
  fail closed；
- 零模型探针在安全安装上无需实验授权即可显式运行；
- 探针 PASS 不提升 Provider/Billing/生产兼容；
- 真实模型与真实 Cache 收益没有独立 A/B 时保持 `NOT_RUN` /
  `NOT_MEASURED`。
