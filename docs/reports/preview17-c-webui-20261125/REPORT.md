# Preview.17-C Single-page Task Console Evidence

> Status: IMPLEMENTED — TARGETED / REAL AUTHORITY + BROWSER, SYNTHETIC WORKER
> Date: 2026-11-25（Asia/Shanghai）
> Baseline: `origin/preview` `6af69b55d7ecb660c2ad2c923888cf7f1e8886c8`
> Implementation/test snapshot: `b9e1e829`

## Scope

本提交把 Operations Console 收敛为一个 loopback 单页 Task Console，并继续通过
Executor Control 读取同一份 SQLite Authority。没有新增公共 MCP 工具或修改公共
schema；Console projection、Continue/Rework 判定和 Cleanup recovery 边界只在内部
Authority、Control 与 HTTP 层增加。

主要实现：

- Task list 与 Task detail 从真实 SQLite projection 读取 Task、Attempt、Result、
  Attention/Hold、Wake、Cleanup、Release 和执行 Usage；HTTP detail 不返回
  `task.context`。列表和详情都显示 Workspace，便于区分同名 Task。
- Recovery Hold 按当前 operation material 折叠，已解决的 `recovery_hold` 不再
  保持 active；`cleanup_reverified` 显示为 Cleanup verified。
- Continue 绑定 durable `released` event 的 sequence，不依赖 Wake 后会变化的
  Operation revision。
- `can_continue` / `can_rework` 在 terminal/released、Cleanup、Hold、Pending
  Interaction、未知 Reply Outcome 和 `submission_unknown` 条件下 fail-closed；
  Cleanup 必须是 verified 而不是仅 released；
  `action_capabilities.blockers` 提供机器可读原因。同一判定由 MCP list 与
  Console usage projection 共用。
- Console usage 始终包含明确的 Provider 实际成本状态；没有可观测金额时为
  `not_observed`、`per_attempt`、`amount:null`，并标记
  `bridge_authority_has_no_provider_settlement`，不因 Token Usage 缺失而隐藏。
- Related rework 创建新 Task，只在 context 中记录来源 Task/Attempt；回执关系为
  `context_only`，不是 Authority parent/child edge。
- Cleanup recovery 使用独立的
  `POST /api/tasks/:id/recover-cleanup`，body 必须为
  `{"release_mode":"zcode_cancel_administrative_release"}`。服务端重新读取
  capability 后委托既有 `cancelTask` / `zcode_cancel` 状态机；不原地清 Hold，
  不直接写 Release，identity/Cleanup 无法验证时失败关闭。
- 单页 UI 提供 Running / Needs attention / Completed 筛选与计数、完整 Attempt
  时间线、历史 Attempt 切换、真实零值 Usage、Events 完整分页、Deep Link、双语、
  明暗主题和窄屏布局。
- 打开 Diagnostics 不读取 Runtime 或 Cost Lab；Runtime inspection/probe 与
  Billing 读取仍需用户显式点击。
- 文档中的 CLI 示例已按实际入口修正为
  `npm run bridge:cli -- executor start` 和
  `npm run bridge:cli -- task console-url <task_id>`。

## Evidence Boundary

浏览器 E2E 使用真实 `IsolatedAdmissionStore`、真实 SQLite Authority、真实
Executor Control Server/IPC、真实 loopback HTTP 和真实 Chromium。测试中的
Worker、Result、Wake 与 Usage 是 **SYNTHETIC WORKER / NOT REAL MODEL**；
不能作为真实模型、真实 Desktop、真实 Queue Wake 或真实 Provider/Billing 证据。

## Result Matrix

| 检查 | 状态 | 证据 |
|---|---|---|
| Console list/detail projection、HTTP context 移除、真实零值 Usage | `PASS — TARGETED` | `test/web-console.test.ts`、Chromium E2E |
| Workspace 显示与 Provider 实际成本 explicit `not_observed` | `PASS — TARGETED` | API 对象与 Chromium E2E，覆盖无 Usage 的 Cleanup Task |
| Continue/Rework capability 与机器可读 blockers | `PASS — TARGETED` | unit + Chromium E2E |
| Cleanup 未 verified 时 Continue/Rework 均不可用 | `PASS — TARGETED` | 浏览器无 Continue/Rework，只剩 `zcode_cancel` administrative Release |
| `submission_unknown` 下 Continue/Rework 均不可用 | `PASS — SYNTHETIC` | `wake_submission_unknown` blocker；浏览器不显示动作按钮 |
| Cleanup recovery 只接受显式 `zcode_cancel_administrative_release` | `PASS — TARGETED` | 409 不可用、400 错误 release mode、200 委托 |
| Cleanup recovery 无法验证 identity 时失败关闭 | `PASS — EXPECTED FAIL-CLOSED` | HTTP 500 `CANCEL_FAILED / worker_identity_unverifiable`；未清 Hold |
| Wake 后 Continue 创建下一 Attempt | `PASS — SYNTHETIC WORKER` | 真实 SQLite + IPC + HTTP + Chromium，Attempt 3 出现 |
| Related rework 新建 Task 且关系为 `context_only` | `PASS — TARGETED` | Chromium POST 回执与 HTTP detail 无 `task.context` |
| 历史 Attempt 切换与真实零 token | `PASS — TARGETED` | Attempt 1 的 Input tokens 保持 `0` |
| Events 超过单页上限后持续分页到完成 | `PASS — TARGETED` | 加载 `>= 245` 个 Event，出现 `All Events loaded` |
| Diagnostics 打开不请求 Runtime/Cost Lab | `PASS — TARGETED` | 页面请求记录无 `/api/runtime`、`/api/cost-lab` |
| 双语、明暗主题、窄屏和 Deep Link 持久化 | `PASS — HEADLESS CHROMIUM` | 语言/主题 localStorage、无横向溢出、刷新保持 Task ID |
| 真实模型 / 真实 ZCode/Codex Desktop | `NOT_RUN` | 本轮没有真实模型或 Desktop |
| 真实 Queue Wake / Desktop visible | `NOT_RUN` | 浏览器 fixture 使用 seeded synthetic Wake |
| Master Usage | `NOT_OBSERVED` | `bridge_authority_does_not_record_master_usage` |
| Coding Plan 逐 Attempt settlement/discount | `NOT_OBSERVED` | 不从 Plan 名称推断；缺失时保持 `not_observed` |
| 完整 CI / Ubuntu / Release Gate | `NOT_RUN` | 只完成开发期定向验证 |

Cleanup recovery 的浏览器用例故意使用无法核验 identity 的 synthetic Worker，
因此验证的是“不能原地强制释放”的失败关闭边界。成功委托路径由 unit fixture
证明调用既有 `cancelTask`；真实状态机上的成功 administrative Release 未在本轮
浏览器 E2E 中运行。

## Commands and Results

最终实现提交 `b9e1e829` 上执行的收口命令：

```text
npm run test:affected -- --development
```

该入口实际串联并通过 `npm run typecheck`、`npm run build`、
`npm run validate:plugin`、`npm run check:generated`、`git diff --check` 和
`npm run build:test`。精确测试结果：

```text
DEVELOPMENT_SAFE_TESTS_PASS count=24
tests 159
pass 158
fail 0
cancelled 0
skipped 1
todo 0
```

- 24 个 development-safe test files 全部通过；1 个 skip 是既有的注入
  ENOTEMPTY 平台用例。
- Web Console unit suite 与 Real Authority + IPC + HTTP + Chromium E2E 均在
  上述最终门禁内通过。
- 门禁输出
  `DEVELOPMENT_SAFE_TESTS_PASS count=24` 与
  `FULL_SUITE_DEFERRED_TO_RELEASE_GATE`。
- 同一门禁内 `check:generated` 报告 14 files fresh；完整 Release Gate 仍为
  `NOT_RUN`。

门禁修正记录：首次宽范围受影响执行得到 772 PASS / 1 FAIL / 1 SKIP。唯一失败是
`test/web-console-browser.test.ts` 已直接导入 SQLite Store，但 impact manifest
未声明 `sqlite-persistence` 域。补齐该 metadata 后，selector 22/22 和最终
development-safe 门禁通过；完整 Release Gate 仍为 `NOT_RUN`。

## Screenshots

以下截图由上述真实 Authority + HTTP + headless Chromium E2E 生成：

- [Tasks, desktop light](screenshots/tasks-desktop-light.png)
- [Tasks, desktop dark](screenshots/tasks-desktop-dark.png)
- [Task detail and attempt timeline, Chinese](screenshots/task-detail-attempts.png)
- [Cleanup-blocked actions](screenshots/cleanup-blocked.png)
- [Diagnostics dialog](screenshots/diagnostics.png)
- [Narrow viewport](screenshots/tasks-narrow.png)

## Modified Areas

- Authority/projection：`src/manager/sqlite-lifecycle-mcp-authority.ts`、
  `src/sqlite-candidate/wp6b2b1/store.mjs`、`lifecycle-port.mjs/.d.ts`、
  `src/store/lifecycle-gate.ts`、`src/task-list.ts`。
- Control/Executor：`src/executor/protocol.ts`、
  `src/executor/control-server.ts`、`src/executor/remote-task-manager.ts`。
- HTTP/UI：`src/web/server.ts`、`src/web/console-ui.ts`、`docs/WEB_CONSOLE.md`。
- Tests：`test/web-console.test.ts`、`test/web-console-browser.test.ts`、
  `test/test-impact-map.json`。
- Generated deliverables：`plugins/codex-zcode-bridge/dist/bridge.mjs`、
  `executor.mjs`、`task-cli.mjs`、`web-console.mjs`，以及本轮 build 同步的
  `wait-task.mjs`、`admin-abandon-held-operation.mjs`。

## NOT_RUN / Remaining Risk

- 没有真实 ZCode/Codex 模型调用、真实 Desktop UI、真实 Queue Wake 或真实
  Desktop 可见性证据。
- 没有真实 Master Usage、逐 Attempt Coding Plan settlement 或 discount 金额。
- 没有完整 Windows/Ubuntu CI、压力矩阵或 Release Gate。
- 截图是 headless Chromium 的视觉证据，不替代人工 UI/UX 或 DPI 验收。
- 实现与测试证据对应 `b9e1e829`；只包含报告与 `Verified against` 元数据的最终
  文档 amend 会改变交付 HEAD，最终 SHA 由交付回执单独记录。
