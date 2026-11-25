# Bridge Task Workspace

> Status: AUTHORITATIVE
> Last updated: 2026-11-25（Preview.17 Task Workspace 第二轮减法整改）
> Last verified: 2026-11-25，核对单行计数筛选、最多三行任务列表、合并未观测标签、详情四段顺序、动作前置、逐 Attempt Usage/Effort、Master 与 Worker 分栏、Provider 实际成本未观测状态、Technical details 折叠、完整 Events 分页、真实 SQLite Authority 到 IPC/HTTP/Chromium 的 Console projection、Continue/Rework/Cleanup recovery 能力门、原始 Z 图标字节绑定、Diagnostics 零外部请求、双语、明暗主题与窄屏布局；真实模型、真实 Desktop、真实 Queue Wake 与 Master Usage 不在已验证范围。
> Verified against: `471b1f35`（Preview.17 集成快照；最终候选提交与 CI 结果由交付报告记录）

Task Workspace 是 Executor Control Pipe 的本地可视化 Adapter。它只有一个
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

顶栏固定只包含原始 Z 品牌图标、`Bridge Task Console`、低干扰 `Experimental`
胶囊、Diagnostics、语言和主题。品牌图标直接使用插件 `assets/icon.png` 的
原始字节，不使用文字占位或相似重绘。页面主体只有一个 `Tasks` / `任务` 页面：
桌面端左侧约 40% 是任务列表，右侧约 60% 是同一页面内展开的任务详情。旧
Dashboard、Task inbox/workspace 重复栏目标题、Runtime 和 Cost Lab 主导航页面
均已退役；Runtime 与成本证据能力保留在 Diagnostics。

页面标题下使用一行紧凑的 `Running` / `Needs attention` / `Completed` 计数，
不使用大型统计卡。三个计数同时是筛选入口。

### Task 列表

- `Running`、`Needs attention`、`Completed` 三个计数与可点击筛选；计数行与
  `All tasks` 下拉共用同一 bucket 状态，再点当前计数可清除筛选。
- 搜索框按 Task 名称、Task ID、Workspace 与目标实时过滤；筛选和搜索只改变本地
  投影，不产生 Authority 写操作。
- 列表使用可扫描行而不是宽表格，每项最多三行：第一行是 Task 名称和一个主要
  状态；第二行是 Workspace 简称、Model、Plan、Attempt 和更新时间；第三行只在
  需要处理时显示失败原因或 Attention 摘要。
- 列表不重复显示完整 Workspace 路径、独立 Usage 行、更新时间或状态。完整
  Workspace 路径只在详情中提供。Model 与 Plan 同时未观测时显示一个合并标签，
  避免在主视图中重复 `Not observed`。
- `Needs attention` 行优先排序，并使用轻微背景与左侧标记；具体原因直接显示
  在第三行，而不是藏在最后一列。
- 已完成 Task 额外显示 `Awaiting review` / `Review blocked`，
  区分“Worker 已完成”和“Master 验收仍待处理/受阻”。
- 筛选只改变本地投影；列表读取失败时保留错误信息，不伪造空列表。

### Task 详情

详情固定按“结论 → 动作 → 证据 → 技术明细”顺序显示，并且不再为每个事实创建
独立卡片：

1. **Task header**：Task 名称、Task ID、Attempt、Model / Plan、更新时间与完整
   Workspace。它不是独立 Overview 卡片。
2. **Problem and actions**：合并 Acceptance、Attention 与 Available actions。
   先显示 Worker 报告的 Result issues / Result failed、Completed-not-accepted、
   Attention、Hold、Pending Interaction 和未知 Reply Outcome，再紧接服务端
   capability 允许的 Continue、Create related rework、Recover Cleanup、
   Reply 或 Request cancel。Result issues 与 Result failed 都不是 Master 验收
   结论；界面不会把 Worker completed 写成 Master accepted，也不会仅凭 Worker
   自报问题声称“验收失败”。
3. **Work history**：合并 Attempt timeline 和 Result。默认展开当前 Attempt；
   选择历史 Attempt 后该 Attempt 只读。显示 Result 摘要、变更文件数和测试
   摘要；完整 Result 和文件列表按需展开。Worker Completed、Master Review
   Pending 与 Master Accepted 保持语义区分。
4. **Execution**：默认只显示
   `Model · Plan · Discount · Total tokens` 一行；展开后显示 Input / Output、
   Cache read / write、Reasoning、Effort、Provider 实际成本、Worker Usage 与
   Master Usage。没有观测的数据不显示为 `0`。
5. **Technical details**：Wake、Cleanup、Release 与 Events 合并为一个默认
   折叠区；只有展开 Events 时才按当前 Attempt 加载完整分页。

Wake、Cleanup 与 Release 作为技术证据放在失败原因和下一步动作之后，不再先于
用户动作出现。

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
  详情在有无 token Usage 时都显示这一事实，不推定为 `0` 或估算值。
- Plan、Discount、Model、Effort 使用独立标签。Effort 只来自 Result 的
  effective/requested reasoning level 或 Task 请求，不从模型名推导。
- Worker Usage 与 Master Usage 分栏。Worker 显示 Total/Input/Output、
  Cache read/write、Reasoning 与来源；Master 没有记录时明确显示
  `Not observed`，不退化为 `0`。
- Start Plan 的 Coding Plan discount 为 `not_applicable`，只表示 provider kind
  下该折扣不适用。
- Coding Plan 没有逐 Attempt settlement 证据时 discount 为 `not_observed`；
  不从套餐名称推断“已优惠”或具体金额。
- Master Usage 固定为 `not_observed`，Reason 为
  `bridge_authority_does_not_record_master_usage`。
- 界面只使用四种折扣状态：已应用、未应用、未观测、不适用。标签与金额
  只来自 Authority/Runtime 的已观测字段；缺失数据不显示为 `0`，预计成本
  不冒充 Provider 实际成本。

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
- **Recover Cleanup**：界面只显示这一用户语言入口；后端仍要求 body 为
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
- 成本证据：Environment、History、Verification entry。
- Auto Wake：读取和保存开关；默认开启。关闭后 Worker 完成只记录
  `web_notify` / `auto_wake_disabled`，不调用官方 Queue。

打开页面、打开 Diagnostics、切换语言/主题、展开 Events 或轮询 Task 都不会
请求 Runtime/Billing 外部能力。Runtime/Billing 读取或探针必须由用户显式点击。
Verification entry 只读取确认状态，不自动开始真实验证。

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
- 真实 Provider/Billing 读取和真实 Coding Plan 验证仍必须由用户显式点击
  并确认；本轮 `NOT_RUN`，定向 synthetic Worker 证据不提升为真实账单结论。
