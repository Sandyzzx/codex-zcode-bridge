# ADR-050：本地 Task Web Console

> Status: DECISION
> Date: 2026-11-22
> Decision: Accepted for the Async Executor Preview candidate
> Baseline: `origin/preview` `1bf039fda2ccfd17a992458a871bddd7b48b38c1`
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
GET  /api/tasks/:task_id/events
GET  /api/tasks/:task_id/result?view=summary|full
POST /api/tasks/:task_id/cancel
POST /api/tasks/:task_id/reply
```

页面加载只读取 Executor 状态和 Task 投影，不产生模型请求。浏览器刷新、
HTTP 连接断开或 Console 进程结束只影响本地观察 Adapter，不取消已受理 Task。
取消与 Interaction Reply 是调用方显式动作，发送到原 Executor 合同。

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
