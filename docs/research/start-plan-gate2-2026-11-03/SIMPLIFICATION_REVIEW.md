# Gate 2 架构简化复核

> Status: RESEARCH
> Date: 2026-11-03
> Baseline: 67dd8c67275c4afeb81dd9795ee03e258083c54d
> Result: PARTIAL — 等待 Owner 的 Gate 2 最终批准；现有 POC 未通过

## 结论

使用原生 `interaction/requestProviderRuntimeHeaders` 是最小模型认证接入点。历史真实 Bridge E2E 曾通过该回调向原生 AppServer 提供 JWT；当前 SQLite Worker 尚未接入此能力。原生回调不能自动跨越 Manager 与独立 Worker 进程边界。

首选 **A + B**：复用原生 Runtime Auth，在现有 Worker 中处理回调；如 JWT 由 Manager 持有，通过专用父子继承通道一次性交付。优先复用现有 ChildProcess/Claim 身份与进程生命周期证据；本威胁模型下不预设 Native Helper 必须存在。若通过已支持授权方式由 Worker 进程自己获得 JWT，则理论上不需要额外 IPC，但用户交互和实时权益组合尚未实现或验证。

## Magpie 与历史证据

历史固定源码研究：Magpie 插件 `1f015f1b1e393db2aff494b0d57de47b2df93625`、`packages/zcode/index.mjs` 0.1.33，`authorize()` 发起浏览器 OAuth 并轮询获得站点 token 和 ZCode JWT；其 Start Plan 路径由插件自身直接发送模型 HTTP，并不把 JWT 送入原生 AppServer。不能把 Magpie 描述为使用原生 Runtime Auth。参考历史 `MAGPIE_ZCODE_AUTH_RESEARCH.md`；未复制代理、解密或客户端模拟。

历史 Bridge 报告记录 `requestProviderRuntimeHeaders` 注入成功及完整 Worker 结果；该次为旧 JSON 路径。原始 turn-correlation 记录 send accepted 为 16:19:25.269Z，turn.started 为 16:19:25.524Z；未保存能够确定 runtime-header 回调相对 turn.started 时序的证据。历史失败中有 Billing HTTP 400/code 3001；具体分别由哪些参数造成无法从记录单独证明。先前管道 POC 的 PID 不存在失败根因也为 UNKNOWN，不能推断 Node 管道不可靠或必须使用 HANDLE。

## 当前 Master 调用链

`worker-main.ts:114-171` 读取 bootstrap 并完成 Claim，`:220-224,294-315` 在独立 Worker 进程构造 Adapter。`zcode-app-server-adapter.ts:524-566` 同步账户并创建 Session；`:616-627` 设置模型；`:740-747` 订阅后发送 Turn。`:1451-1460` 在 Worker 内响应 runtime-header，当前 `account-provider.ts:114-139` 仅支持 individual Coding Plan，并返回 `{headersApplied:true,requestAuth:{apiKey}}`。历史 Bridge 证明该形状曾携带 Start Plan JWT，但当前版本还需重新验证。

`turn.started` 到达后才在 Adapter `:1539-1543` 记录 Turn；不能从源码证明首次 runtime-header 一定在该事件之前或之后。Session 在 session/create 后可知；如果回调没有可信 Turn，按合同 fail closed，或在独立协议验证后设计与单次 send-boundary 关联的安全方案。不得伪造 Turn。

Bridge 可以作为认证权威，但若权威位于 Manager，当前没有直接回调通道连接到它。JWT 不一定必须长期由 Worker 持有：也可由 Manager 保留并仅在 Worker 转发回调时返回一次认证材料；但结果仍必须穿越进程边界，且返回后实际运行时/Worker 内会短暂存在 JWT。当前 interaction 通道会持久化交互内容，不能直接承载 JWT；FD3 是已关闭的 bootstrap，FD5 是严格 Claim 决议，FD6 是结果，FD7–9 是交互流。

## A/B/C/D 比较

| 方案 | 结论 |
| --- | --- |
| A 原生 Runtime Auth | 模型认证接入首选；本身不解决跨进程凭据来源。Worker 内独立安全授权可避免额外 IPC，但尚未验证。 |
| B 专用继承管道 | Manager 持有 JWT 时的首选候选；由指定 ChildProcess 创建、与现有 Claim/attempt 绑定，单次消费，关闭/取消/退出 fail closed。需实测句柄继承和泄漏边界。 |
| C Named Pipe | 可行候选，但需名称、ACL、连接归属及清理；本场景比 B 增加复杂度。 |
| D Native Helper + HANDLE | 可提供更强的进程代持有证明；目前尚未证明在单用户可信进程模型下不可或缺，不作为默认前提。 |

## 最小合同与威胁模型

防止不同 Worker 或 attempt 意外取错 JWT、PID 换代造成误绑定、重复消费、取消后继续使用和秘密误落盘。信任本机同用户 Manager 与已验证的 Worker 二进制；不承诺防已控制同用户进程、管理员调试或内存转储。现有精确 PID/创建时间和 Claim 加指定 ChildProcess 的继承通道是待验证方案；若测试不能覆盖退出/换代窗口，再评估 HANDLE。JavaScript 字符串不能保证物理擦除。

实时 entitlement 必须由可信认证后查询获得，并绑定 account/provider/model 与此次 attempt；不得接受调用方布尔值或过期缓存。租约还绑定 task/attempt，收到真实 Session/Turn 后严格绑定；一次消费、短期有效、取消/Worker 崩溃失效、无自动重试或身份切换。JWT 不进入 SQLite、Task、Event、Result、普通日志、argv 或环境变量。写入开始后取消不能收回已发送字节；Worker 必须在每次使用前再次验证 lease。Coding Plan 默认路径维持原样。

设备身份继续按历史报告标记：Desktop/CLI 同 data root 复用 telemetry-state；历史 Billing 与隔离 Worker 来自不同来源，其与风控的因果 UNCONFIRMED。不得为测试或恢复访问随机改变身份。

## 独立 Reviewer 裁决

Reviewer 独立核查了以上源码行、FD 分配和历史 POC：支持 A+B 的简化方向；认为上版将 HANDLE 作为唯一生产前提证据不足。当前不能放行：真实继承通道测试两次失败且没有完整退出码与探针时序；Turn 与首个 runtime-header 的顺序未证实；POC 的帧解析、取消和真实身份绑定尚未完成。建议保留原失败并在离线环境记录 child exit、精确时间与错误分类，修复后独立复审。

本轮仅源码与历史证据复核，未执行 OAuth、Billing 或模型请求，也未修改生产代码。原 Gate 2 POC 的 21 PASS / 1 FAIL 仍为历史测试结果，本轮未声称通过。
