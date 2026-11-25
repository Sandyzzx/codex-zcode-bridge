# Bridge Operations Console

> Status: AUTHORITATIVE
> Last updated: 2026-11-25（Preview.17 单页 Task Console）
> Last verified: 2026-11-25，核对单页列表/详情的 Workspace、逐 Attempt Usage 与 Provider 实际成本未观测状态、真实 SQLite Authority 到 IPC/HTTP/Chromium 的 Console projection、Attempt 切换、完整 Events 分页、Continue/Rework 的 Cleanup/Worker/Interaction/Wake 能力门、Cleanup recovery 的 `zcode_cancel` 边界、Diagnostics 零外部请求、双语与明暗主题；真实模型、真实 Desktop、真实 Queue Wake 和 Master Usage 不在已验证范围。
> Verified against: `b9e1e829`

Operations Console 是 Executor Control Pipe 的本地可视化 Adapter。它只有一个
loopback Origin、一个 HTTP Server 和一个单页界面，不创建 Task、Manager、
Worker 或第二套 SQLite Authority。任务、Attempt、Event、Result、Attention、
Wake、Cleanup、Release 和执行 Usage 都来自 Executor 持有的同一份 Authority。

## 启动与发现

先确保独立 Executor 已启动，然后在插件安装目录执行：

```powershell
npm run bridge:cli -- executor start
npm run bridge:cli -- task console-url <task_id>
```

`zcode_task` / `zcode_continue` receipt 中的 `console_link` 使用同一条验证路径；
链接失败只记录 `available=false` 和 `reason_code`，不会撤销已受理 Task。CLI 会
验证 Task、live `/api/session`、Executor Lease 和 Authority Root discovery。若
Console 尚未运行，它会启动 `dist/web-console.mjs`；已有安全 Owner 时复用同一
端口和 Discovery 记录。

```json
{
  "task_id": "task-id",
  "web_url": "http://127.0.0.1:43127/?task_id=task-id",
  "console_reused": true
}
```

URL 只携带 Task ID，不携带 CSRF、凭据或设备身份。也可以直接启动：

```powershell
node dist/web-console.mjs --data-root <absolute-state-dir>
```

## 单页界面

顶栏固定只包含品牌、Executor 状态、Diagnostics、语言和主题。页面主体是
Task 列表与当前 Task 详情；标题使用 `Task details` / `任务详情`，顶部以低
强调提示标明任务状态与恢复操作仍属实验性。旧 Dashboard、Runtime 和 Cost Lab
主导航页面均已退役，Runtime 与 Cost Lab 能力移入 Diagnostics。

### Task 列表

- `Running`、`Needs attention`、`Completed` 三个计数与可点击筛选。
- 每行显示 Task 名称/目标、Workspace、状态、当前 Attempt、Model、Plan、
  执行 Usage、更新时间和 Attention 摘要。列表中的 Workspace 保留末段路径并
  提供完整路径提示；详情显示完整 Workspace。
- Usage 单元同时显示 Discount 状态和 `Provider actual cost: Not observed`，
  不把 Provider 成本省略成空白。
- 筛选只改变本地投影；列表读取失败时保留错误信息，不伪造空列表。

### Task 详情

详情固定按以下顺序显示：

1. 当前状态、Executor 动作和阻塞原因。
2. Attempt timeline；选择历史 Attempt 后该 Attempt 只读。
3. 当前选中 Attempt 的 Result。
4. Attention and Hold。
5. Wake。
6. Cleanup。
7. Release。
8. Execution Usage 与 Master Usage。
9. Events。

Task 和 Attempt 的当前/历史信息均来自 Console projection，不从 Workspace、
Task 名称、模型名或 UI 缓存推断。Deep Link `?task_id=` 在列表加载后解析，
用户切换 Task 或 Attempt 后 URL 使用 `history.replaceState` 同步；刷新和浏览器
前进/后退保留选择。`bridge.ui.theme` 与 `bridge.ui.language` 保存在本地
localStorage，支持 `light` / `dark` / `system` 和 `en` / `zh-CN`。

### Usage、Plan 与 Discount

- Result 中真实存在的零 token 值保持为 `0`，不会显示成“未观测”。
- 缺少整套 Usage 时显示 `not_observed`；不根据文本、时长或模型名推算。
- 每个 Attempt 的 Usage projection 都包含 `provider_cost`。Bridge Authority
  没有逐 Attempt Provider settlement 时，状态固定为 `not_observed`，金额与
  币种为 `null`，Reason 为 `bridge_authority_has_no_provider_settlement`；
  UI 在有无 token Usage 时都显示这一事实，不推定为 `0` 或估算值。
- Start Plan 的 Coding Plan discount 为 `not_applicable`，只表示 provider kind
  下该折扣不适用。
- Coding Plan 没有逐 Attempt settlement 证据时 discount 为 `not_observed`；
  不从套餐名称推断“已优惠”或具体金额。
- Master Usage 固定为 `not_observed`，Reason 为
  `bridge_authority_does_not_record_master_usage`。

### Events

展开 Events 后，页面按当前选中 Attempt 读取
`limit=200&include_attempt=true&view=summary&max_bytes=33554432`，持续跟随
`next_seq` 直到 `has_more=false`。界面显示加载中、错误、当前 Attempt 的
Event 数和 `All Events loaded`；不会把第一页误报为完整历史。

## 动作边界

所有生命周期写操作都要求同源 Origin、会话 CSRF 和 same-site。按钮只转发到
既有 Executor 方法，不直接写 SQLite，也不新增“Accept”或“强制完成”语义。

- **Continue**：仅当 Attempt terminal、Operation 与 Release 都是
  `released`、Cleanup 已验证、无 active Hold、无 Pending Interaction、无未知
  Reply Outcome，且 Wake 不是 `submission_unknown` 时可用。调用
  `POST /api/tasks/:id/continue` 创建下一 Attempt。
- **Create related rework**：仅当 Task terminal、Operation 与 Release 都是
  `released`、Cleanup 已验证、无 active Hold/Pending/未知 Reply Outcome，且
  Wake 不是 `submission_unknown` 时可用。调用
  `POST /api/tasks/:id/rework` 创建一个新 Task；来源 Task/Attempt 只写入新
  Task 的 context，关系返回 `context_only`，不是 Authority parent/child
  edge。对 cancelled Task 的 rework 也只是新 Task，不恢复旧 Attempt。
- **Request cancel**：仅 queued/running Attempt 显示，调用
  `POST /api/tasks/:id/cancel`。取消请求不在地清除 Hold，也不直接写 Release。
- **Interaction Reply**：仅 pending permission request 显示，调用
  `POST /api/tasks/:id/reply`。未知 Reply Outcome 只展示警告，不自动重发。
- **zcode_cancel administrative Release**：Cleanup/release recovery 入口明确
  要求 body 为
  `{"release_mode":"zcode_cancel_administrative_release"}`，并通过
  `POST /api/tasks/:id/recover-cleanup` 进入既有 `zcode_cancel` Recovery 状态机。
  它不会原地清除 Hold。若 Recovery 不能验证 Worker identity/Cleanup，操作
  fail-closed；只有状态机自身满足条件时才可能记录
  `cleanup_verified=false` 的 user-authorized administrative Release。

服务端会重新读取 Console capability，不依赖浏览器按钮状态。不可用动作返回
HTTP 409，并且 Console projection 的 `action_capabilities.blockers` 给出
机器可读原因；界面显示对应可读阻塞项，常包括 `cleanup_unverified`、
`wake_submission_unknown`、`pending_interaction`、`worker_active`、active
Hold 和未完成 Release。

## Diagnostics

Diagnostics 是显式操作的 `<dialog>`。原独立 Runtime/Cost Lab 主导航页面已
退役，能力在这里保留：

- Runtime：静态 Inspect、Static check、授权零模型 Protocol probe、Candidate
  Report 导出。
- Cost Lab：Environment、History、Verification entry。
- Auto Wake：读取和保存开关；默认开启。关闭后 Worker 完成只记录
  `web_notify` / `auto_wake_disabled`，不调用官方 Queue。

打开页面、打开 Diagnostics、切换语言/主题、展开 Events 或轮询 Task 都不会
请求 Runtime/Billing 外部能力。Runtime/Billing 读取或探针必须由用户显式点击。
Cost Lab Verification entry 只读取确认状态，不自动开始真实验证。

## HTTP 与安全边界

- 只绑定 `127.0.0.1`，没有公网或局域网监听开关。
- 校验精确 Host；变更请求要求同源 Origin、会话 CSRF 和 same-site。
- JSON body 上限 64 KiB；Task ID、Event/Result 查询和 Interaction Reply 使用
  strict schema。
- 返回 no-store、CSP、frame deny 和 same-origin resource policy。
- 不提供任意 Shell、文件读写、SQLite 写接口、模型设置或 Executor Shutdown
  API。
- HTTP Console 不返回 `task.context`；related rework 在 Executor 内部读取
  projection，并只把来源 context 复制进新 Task。

HTTP 连接断开、浏览器关闭或 Console 进程结束都不等于 Task Cancel。只有显式
Cancel/Reply/Continue/Rework/Cleanup recovery 或原 Executor API 才改变生命
周期。

## Runtime Auto-Learn

Runtime 证据存储在：

```text
<Authority Root>/.run/bridge-console/runtime-compatibility.json
```

它按 exact installation fingerprint 记录静态、授权零模型、真实 Provider 和
Billing 证据。证据去重并最多保留 200 条；不同 fingerprint 不继承结论。
Candidate Report 只生成待 Owner 审核的建议，不修改生产 Manifest。

完整规则见 [ADR-053](decisions/ADR-053-runtime-auto-learn-compatibility.md)。

## 已知边界

- 当前 Chromium E2E 使用真实 SQLite Authority、Executor IPC、HTTP 和
  Chromium，但 Worker/Result 是 synthetic fixture；不是真实模型证据。
- 真实 Desktop 全退、真实 Queue Wake、Master Usage、逐 Attempt Coding Plan
  settlement/discount 和完整 CI 仍需要后续验收。
- 未授权的 Official Runtime 真实 Provider 执行保持
  `BLOCKED_BY_AUTHORIZATION`。
