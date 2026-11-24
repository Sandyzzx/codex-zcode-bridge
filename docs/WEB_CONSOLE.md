# Bridge Operations Console

> Status: AUTHORITATIVE
> Last updated: 2026-11-24（Auto Wake Settings 与 receipt Console link）
> Last verified: 2026-11-24，核对 unified Console、Cost Lab same-origin 挂载、i18n/theme、Deep Link、Runtime Auto-Learn、Auto Wake 默认开启/CSRF Settings、`console_link` receipt、真实 Chromium 定向路径与真实 Host Completion Wake E2E（Master 在回复中输出可点击的 Task Deep Link）；真实 Desktop 全退与真实 Provider 不在已验证范围。
> Verified against: `codex/preview16-async-handoff-20261124`（基于 `origin/preview@fa44b901fe3bb7b403905e7fead791733c69fa60`）

Operations Console 是 Executor Control Pipe 的本地可视化 Adapter。它只使用
一个 loopback Origin 和一个 HTTP Server，不创建 Task、Manager、Worker 或
第二套 SQLite Authority。Task、Event、Result、Attention、Wake 和 Executor
状态都经同一 `ExecutorControlClient` 读取；Cancel 与 Interaction Reply 是
显式转发动作。

## 启动与发现

先确保独立 Executor 已启动，然后在插件安装目录执行：

```powershell
node dist/task-cli.mjs executor start
node dist/task-cli.mjs task console-url <task_id>
```

`zcode_task` / `zcode_continue` 的 receipt 也会返回经同一验证的
`console_link`；链接失败只记 `available=false` 与 `reason_code`，不会撤销
已受理 Task。CLI 的 `task console-url` 仍会验证 Task、live `/api/session`、Executor Lease 和
Authority Root discovery。若 Console 尚未运行，它会启动 `dist/web-console.mjs`；
已有安全 Owner 时复用同一实际端口。返回值示例：

```json
{
  "task_id": "task-id",
  "web_url": "http://127.0.0.1:43127/?task_id=task-id",
  "console_reused": true
}
```

URL 只携带 Task ID，不携带 CSRF、凭据或设备身份。启动、发现或 session
校验失败时命令必须失败，不拼接猜测地址。

也可以直接启动 Console：

```powershell
node dist/web-console.mjs --data-root <absolute-state-dir>
```

实际端口由运行时分配。同一 Authority Root 的发现记录为
`task-console.json`，只含 lifecycle metadata，不是 Task/Result Authority。

## 页面

- **Dashboard**：Executor 状态、Task 计数、Wake banner 和最近任务。
- **Tasks**：Task list、状态筛选、Attempt、Wake、Hold、Queue blocker、
  Pending Interaction、Events 与 Result。支持 Task Deep Link。
- **Cost Lab**：same-origin `/api/cost-lab/*`，复用既有 Coding Plan、
  Start Plan、Usage、History、导出和显式验证实现。
- **Runtime**：当前安装、安全状态、Fingerprint、Manifest、资产变化、
  Capability Matrix、证据历史、授权缺项和 Candidate Report。
- **Settings**：`zh-CN`/`en` 语言、Light/Dark/System 主题偏好，以及 Auto Wake
  开关（默认开启；关闭后 Worker 完成只记录 `web_notify` / `auto_wake_disabled`，
  不调用官方 Queue）。

Task Status、Events 和 Result 独立读取。未完成 Task 的
`TASK_NOT_FINISHED` Result 只显示 pending/inconclusive，不掩盖有效 Status
或 Events；其他读取错误单独显示。选中 Task 随现有轮询周期刷新，手动选择
同步更新 URL，页面刷新和前进/后退保留选择。

## 零费用加载

打开页面、切换语言、切换主题、读取历史、打开 Task Deep Link、轮询状态和
导出本地历史不发送模型请求，也不自动调用官方 Billing API。Runtime 页面
首次读取/显式检查只做静态安装检查；协议探针和真实 Provider 操作都必须由
用户显式触发，并受 ADR-042 的精确指纹授权约束。

Cost Lab 的官方余额刷新和真实验证仍需现有确认流程。页面不会因为语言、
主题或导航切换重新请求 Billing、Runtime 或模型。

## HTTP 与安全边界

- 只绑定 `127.0.0.1`，不提供公网或局域网监听开关。
- 校验精确 Host；变更请求要求同源 Origin、会话 CSRF 和 same-site。
- JSON body 上限 64 KiB；Task ID、Result/Event 查询与 Interaction Reply
  使用现有 strict schema。
- 提供 no-store、CSP、frame deny、same-origin resource policy。
- 不提供任意 Shell、文件读写、SQLite、模型设置或 Executor Shutdown API。
- 完整 Result 的 Web 响应上限为 2 MiB；超限要求 Task CLI 使用绝对路径
  输出，不做静默截断。

HTTP 连接断开、浏览器关闭或 Console 进程结束不等于 Task Cancel。只有用户
显式调用 Cancel/Reply 或原 Executor API 才改变 Task 生命周期。

## Runtime Auto-Learn

Runtime 证据存储在：

```text
<Authority Root>/.run/bridge-console/runtime-compatibility.json
```

它按 exact installation fingerprint 记录静态、授权零模型、真实 Provider
和 Billing 证据。证据去重、最多保留 200 条；不同 fingerprint 不继承结论。
Candidate Report 只生成待 Owner 审核的建议，不修改生产 Manifest。

完整规则见 [ADR-053](decisions/ADR-053-runtime-auto-learn-compatibility.md)。

## 已知边界

- 真实 Desktop 全退、严格 C/D 和真实 Queue Wake 仍需要隔离 Host 验收。
- 未授权的 Official Runtime 真实 Provider 执行保持
  `BLOCKED_BY_AUTHORIZATION`。
- 当前真实 Chromium / synthetic Worker E2E 证明 Web 与 Executor 生命周期
  独立；不是真实模型或真实 Desktop 证据。
