# Async Handoff 与 Wake 恢复

> Status: AUTHORITATIVE
> Last updated: 2026-11-22
> Last verified: 2026-11-22，核对 ADR-045、ADR-051、ADR-052 与确定性 Skill 合同测试；真实模型遵循率、真实 Queue 和 Desktop 关闭 E2E 均 NOT RUN。
> Verified against: `codex/async-executor-pr6-20261122` candidate

本文件只在入口已确认 Bridge 授权后使用。它不决定交付范围：
`whole_task`、`staged` 和只读 `auto` 仍由
[delegation-policy.md](delegation-policy.md) 决定。Handoff Mechanism 只决定
当前 Master Turn 是否结束：

- `async_wake`：Task 已可靠受理后记录绑定，简洁报告并结束 Turn，停止轮询；
- `foreground`：在当前 Turn 使用既有的有界事件/Attention 跟进。

这两个机制都不是 MCP 字段、TaskPackage 字段、Task 状态或额外持久化权威。

## 采用条件

采用 `async_wake` 前必须同时满足：

1. 当前目标仍受用户明确 Bridge 授权覆盖，写入、审批、取消和外部操作权限没有扩大；
2. `zcode_task` 返回可归属的受理回执和原 `task_id`，状态不是未知、冲突或失败；
3. 能核实 Executor Authority；当前 Codex Thread ID 和一次性 Wake 授权可核实，
   或用户已知道本次只能依赖 Web Notify/下一次 Turn；
4. 当前 Attempt 无已知 Pending Interaction、执行启动错误或未决清理事实；
5. 用户要求的是已授权交付，不把 Async Handoff 变成无人值守审批或无限取消权限。

任一条件不成立时使用 `foreground`，或保持未决并报告具体缺项。不要在缺少
Authority、Thread、模型/effort 或预算确认时自行执行 `codex queue`、附加
`--resume`、修改 Wake 策略或伪造一次性授权。

## 受理与交接

1. 完成 Ready Gate 后提交原 `task_id`。
2. 核对回执属于该 Task，并做一次有界启动检查，记录可核实的 Task、Attempt、
   Authority Root、Codex Thread、接入方式和当前执行事实。
3. 若 Task Console 可用，取得经 `task console-url`/Executor 验证的原
   `task_id` 当前链接；只报告真实可访问的 `web_url`，不得拼接、猜测或伪造
   地址。链接只携带 `task_id`，不得包含 CSRF 或凭据；Console 不可用时报告
   原因和安全的状态查询替代方式。
4. 向用户简洁报告：目标、Task Scope、Handoff Mechanism、`task_id`、已知
   Attempt/路径、受理状态、可验证的 Task Console 链接，以及 Result 将经
   Queue 或 Web Notify 返回。未观察到的字段省略或写 `UNKNOWN`，不复制
   Prompt、完整日志或凭据。
5. 结束时给出当前 Turn 的最终答复。不要继续 `wait_for`、Thin Waiter、空闲轮询
   或为保持连接而阻塞。
6. Turn 结束、Host 断开、MCP Stop 或工具调用超时都不等于 Task 取消。不得因此
   调用 `zcode_cancel`；只有用户明确授权具体取消时才走原取消合同。

## 回执未知

`SUBMISSION_UNKNOWN`、MCP/IPC timeout、连接在响应前关闭或输出无法归属时，
先按原 `task_id` 查询 Task/Attempt/Authority 和事件。相同请求可按既有幂等规则
原样重放；不得生成替换 Task ID、第二 Attempt 或“再发一次”掩盖未知。

无法确认请求是否已提交时停止对该 Task 自动重发，报告 `SUBMISSION_UNKNOWN`
与尚未核实的边界。不要通过 Queue、新 Thread 或手工数据库操作绕过。

## Wake 恢复

Wake 消息到达表示 Executor 已完成自身 post-Release 通知流程，不是 Master 已恢复
或 Task 已接收。按以下顺序恢复：

1. 从消息核对 `task_id`、Attempt、Operation、Result digest 与已记录交接绑定。
   任一不一致或缺失时保持未验收，查询原 Task 并报告冲突。
2. 用 `zcode_status`/Attention/Events 核对当前 Attempt、Pending Interaction、
   Result、Cleanup Hold 与 Operation Release；需要时传 `expected_attempt`。
3. 用 `zcode_result(view="summary")` 读取持久 Result；已知需要原文或摘要缺项时，
   按同一 Attempt 读取 `view="full"`。Result 存在不等于 Cleanup 或 Release 完成。
4. 在实际执行目录独立检查 Git 状态、diff、文件与适用测试；分别记录
   Result committed、Cleanup verified、Operation released 和 Master acceptance。
5. 验收失败时按原范围做一次 `zcode_continue`；新目标、扩大写入/外部操作或无法
   证据补齐的决定重新取得用户授权。

`QUEUED`、`TURN_STARTED`、`TURN_COMPLETED`、`DESKTOP_VISIBLE` 是独立状态。
Queue exit 0、消息出现或新 Turn 开始均不能证明 Worker Result、Cleanup、Release
或验收；没有 UI acknowledgement 时 `DESKTOP_VISIBLE=UNKNOWN`。

Task Console 的 `web_url` 只证明受理后的状态查询入口可用，不证明 Turn 已启动、
Result 已提交或任务已验收。页面默认轮询只刷新本地 Adapter；Console 断开不等于
Executor 或 Task 取消。若页面或链接不可访问，保留原 Task 和 UNKNOWN 边界，
不要自动重发可能产生模型请求的命令。

## Pending Interaction

Pending Interaction 是活动阻塞事实，不是完成、可自动批准或可忽略状态。

- 结束 Turn 前发现 Pending 时，留在当前 Turn 读取原请求；只有用户明确授权该
  具体操作才回复 `allow`，归属不明时保持未决。
- 已交接受理 Task 后出现 Pending 时，本文件不承诺自动产生新的 Thread Wake。
  用户下一次 Turn 或 Web/CLI 手动检查时仍须按原请求、原 Attempt 和明确授权处理。
- 不得因 Turn 结束、断连或等待超时自动 `allow`，也不得把 Pending 当作失败后
  擅自取消或换 Task ID 重派。

## 禁止

- 不新增第二 Task Manager、持久 Handoff 表、Wake 状态机或恢复引擎。
- 不直接修改 Wake 策略、Codex Desktop 数据库、私有 IPC 或凭据。
- 不在链接、日志或用户报告中放入 CSRF、凭据或伪造的 Console 地址。
- 不由 Master 直接运行 `codex queue`；Queue 只属于已授权的 Executor Wake Adapter。
- 不以新 Task/Attempt 掩盖未知回执，不自动重试潜在模型请求。
- 不把 `completed`、Wake、Queue ACK、Turn start 或文件存在单独当作验收 PASS。
