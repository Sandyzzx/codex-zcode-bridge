# ADR-050：本地 Task Web Console

> Status: DECISION
> Date: 2026-11-22
> Decision: Accepted for the Async Executor Preview candidate
> Baseline: `origin/preview` `c941f578ec00834ab0e93f235134d24bf14a827a`
> C1 evidence implementation: `02a9e81198cffc5b90077eaba00b5abbfd40f640`
> Related architecture: [BRIDGE_ASYNC_EXECUTION_V1.md](../architecture/BRIDGE_ASYNC_EXECUTION_V1.md)

## 决定

Task Web Console 是 Executor Control Pipe 的本地可视化 Adapter。它只绑定
`127.0.0.1`，复用 `ExecutorControlClient` 与 `RemoteTaskManager`，不打开
SQLite，不创建 Manager/Worker/Official Runtime，也不调度或创建 Task。

首版 HTTP 面：

```text
GET  /
GET  /api/session
GET  /api/tasks
GET  /api/tasks/:task_id/status
GET  /api/tasks/:task_id/summary
GET  /api/tasks/:task_id/events
GET  /api/tasks/:task_id/result?view=summary|full
GET  /api/tasks/:task_id/attention
POST /api/tasks/:task_id/cancel
POST /api/tasks/:task_id/reply
```

页面加载只读取 Executor 状态和 Task 投影，不产生模型请求。浏览器刷新、
HTTP 连接断开或 Console 进程结束只影响本地观察 Adapter，不取消已受理 Task。
取消与 Interaction Reply 是调用方显式动作，发送到原 Executor 合同。
Task list 同时展示同一 SQLite v14 `executor_wake` Event 的最新只读摘要
（计数、banner 和行内 badge）；它不是新的通知权威，也不轮询 Queue。

`/api/session` 只返回非秘密 Console 身份、Authority Root digest 和实际 loopback
URL。Console 启动后在该 Authority Root 写入 `task-console.json` 作为**生命周期
发现元数据**，不保存 Task、Result、Event、Wake 或任何第二套状态。发现记录必须
通过 Console PID + start fingerprint、Authority digest、精确 loopback URL/port
和记录 digest 校验；同 Root 已有安全存活 Owner 时复用同一 URL，已有未知/
异常 Owner 时 fail closed，不启动第二个可视化 Authority。记录以跨进程
`wx` 创建并用 `console_id + record_digest` CAS 删除；它不是 Queue、Executor
Lease 或 SQLite 的替代品。

Task Deep Link 固定使用实际运行时端口：

```text
http://127.0.0.1:<actual-port>/?task_id=<task-id>
```

页面按 `task_id` 自动选择 Task，手动选择同步更新 URL，刷新/前进后退保留选择。
当 Task 不在 `/api/tasks` 第一页时，页面通过有界分页 `/summary` 取回 Task
详情。URL 不含 CSRF 或凭据。Task Status、Events、Result 和 Attention 独立
读取；`TASK_NOT_FINISHED` 只显示 Result pending，不掩盖有效 Status/Events。
选中 Task 随既有轮询刷新，不新增 WebSocket、SSE 或事件服务。

## 安全边界

- 服务固定绑定 IPv4 loopback，不提供可配置公网/局域网监听。
- 校验精确 Host；所有变更请求还要求同源 `Origin`、会话 CSRF 头与
  `Sec-Fetch-Site`（若存在）为 same-origin/none。
- JSON body 上限 64 KiB；Task ID、Event/Result 查询参数和 Interaction
  Reply 通过现有 strict schema 校验。
- 不提供任意 Shell、文件读写、SQLite、模型设置或 Executor Shutdown API。
- 响应设置 no-store、CSP、frame deny、same-origin resource policy 等本地
  页面保护。
- 默认返回 ADR-047 摘要；Web 的完整 Result 响应上限为 2 MiB，超限要求使用
  Task CLI 的绝对路径输出，不做静默截断。

## 分发与验证

插件分发 `dist/web-console.mjs`；源码入口为 `src/web/main.ts`。静态测试锁定
Web 层不导入 Manager/Store/Worker/Adapter/Host，生成物校验锁定它只经
Executor Control Client 组合。

定向验证覆盖 loopback Host/Origin/CSRF 拒绝、只读列表与证据读取、
Cancel/Reply 转发、body 上限、页面关闭不影响独立 Executor。真实多用户
隔离、浏览器长期运行和 Desktop 关闭仍不在本 ADR 内自动通过。

当前 Web 定向证据：动态入口和发现文件、同 Root 二进程复用、Deep Link
跨页解析、Result 未完成独立显示、Attention 投影、loopback/Origin/CSRF
回归均通过。最终 C1 E2E 另以真实 Web Console、真实 Chromium、真实 MCP
Host 和 synthetic Worker 验证：Host 退出前后浏览器持续观察同一 Task，
Executor/Console 保持 active，最终 Result/Cleanup/Release 各一次。该结论
固定为 `PASS — REAL PROCESS / SYNTHETIC WORKER`，不得写成真实 Desktop、
Queue Wake 或 Official Runtime 的 `PASS — REAL`。
