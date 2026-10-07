# Bridge 可靠性修复计划 V2

> Status: DECISION
> Date: 2026-10-03
> 计划与决策记录，其中仍有未完成项（见文首状态行）。已实现的部分以 `ARCHITECTURE.md` 为准。

日期：2026-10-03。状态：A/B 主要改动已推送，其完整验收仍待补齐；新增收尾修复、C/D 和宿主启动核验尚未实施。下方第 10–17 节是本轮实施规格，与旧条目冲突时以新增规格为准。本文件不替代描述当前实现的 ARCHITECTURE.md，目前为被 Git 忽略的本地规划文件。

## 1. 目标与当前证据

解决：请求积压导致 300 秒工具超时、提交结果未知后重复派发、PID 与实际执行状态不一致、结果丢失后无法核对 ZCode 执行记录。

本会话观察：任务库有 188 条任务，无 queued/running worker，多达 5 个 Bridge MCP 服务共享 data root。现有每秒恢复 tick 进入同一进程内 promise 队列，再竞争跨进程 manager 锁。一次 recovery 经 recoverTasks、running 列表、损坏检查、queued 列表重复执行四遍全库读取；对应只读读取测量约 988–1053 ms。代码与测量支持恢复积压为主要原因；未读取存活进程内部队列长度，不将准确积压数量写成已证实事实。

CAD2BIM RM09_004 与 LumeCAE TASK_089 提交未获回执，当前任务目录不存在。不能仅据此证明仍在服务队列中的请求永远不会执行。TASK_088 的 1800000 ms 任务截止已被 task.json、events 和 outcome 证实，与之后的 300 秒工具调用超时分开处理。

最新源码交付：取消修复 bf23b8b 与 A/B 主要修复 34134b6 已推送；dsh f7997db 已推送并 pin 34134b6，两仓库对应提交 Windows/Ubuntu CI 均通过。这是对应提交的历史验证，不代表本轮新增规格通过；磁盘安装与存活服务的加载版本需单独核实。

## 2. 固定边界

- 公共 TaskStatus 的 queued/running/completed/failed/cancelled/waiting_for_master 保留。unknown 等作为附加执行观测字段，不把等待权限误映射为 waiting_for_master（后者是任务报告需要 Master 决策）。
- task_id 为一次逻辑任务的稳定 ID；attempt 只由显式续作增加。工具超时不得自动增加 attempt 或更换 ID。
- 不引入新 daemon、通用 observer 框架或第二套任务控制权。manager 管理接受/调度/所有权，worker 持有 ZCode stdio，adapter 解释原生协议，TaskStore 发布证据。
- 共享能力进入 codex-zcode-bridge core；dsh 仅更新 pin、tarball、bundle 和宿主组合测试。
- 本地 ZCode 文件只读、按需、字段白名单。Desktop task index 包含 Bridge 写入的镜像，不是独立执行权威。不修改真实任务库、Desktop 索引、rollout 或 CAD2BIM/LumeCAE 工作区来制造通过结果。
- 活 owner 的 manager 锁不按超时强制删除。RPC、进程终止等待、大量历史读取不长期持有全局调度锁。

## 3. 统一状态与证据模型

为现有 zcode_status 增加可选 observation 字段；zcode_events 可附同样摘要，doctor 提供服务健康。旧客户端仍可只读 status。

| 字段 | 含义 |
|---|---|
| execution_state | not_started / starting / active / waiting_permission / waiting_input / cancelling / finished / unknown |
| result_state | pending / available / missing / invalid；执行已结束不等于报告有效 |
| worker_health | responding / unresponsive / exited / unknown；不以 PID 存在代替 responding |
| source | worker_event / native_snapshot / native_events / persisted_result / local_record / process_check |
| observed_at、stale、reason | 证据时间、是否过旧、已知或未知的理由；不能用状态文件更新时刻代替最后执行证据时间 |
| session_id、turn_id、attempt、last_event_seq | 当前 attempt 的关联身份；缺字段必须降低判断能力，不猜测 |
| recommended_action | wait / reply_interaction / fetch_result / reconcile / manual_review；未知不建议重派 |

这不是对 ZCode 返回字段的假设，是 Bridge 对验证后证据的投影。execution_state=active 仅表示已证实活动 turn/工具，不保证模型持续产出。

判定规则：

1. 同 attempt 的合法 result 优先确定任务结果；cleanup_unverified 仍保留执行目录和 slot，不能因结果存在直接释放。
2. 新鲜 heartbeat 证明 worker 事件循环响应；模型等待、工具执行和权限等待分别由 runtime 证据解释。
3. PID 存活但 heartbeat 过期：worker_health=unresponsive，execution_state=unknown；触发有界核对，不直接判失败或新建任务。
4. worker 退出而 ZCode 仍可能运行：保留目录占用，核对 session/进程；不自动续作或重新发送 prompt。
5. 已核验同 session、同 turn 的结束证据但缺 Bridge 报告：execution_state=finished、result_state=missing，进入结果恢复。只有通过既有报告校验且清理有证明，才能发布相应终态。
6. session 快照 idle、日志静默、mtime 未变都不能单独证明当前 turn 完成或任务死亡。来源冲突时保留各来源和 reason，返回 unknown。
7. 旧 attempt/旧 turn 的结束事件、快照、heartbeat 不得更新当前 attempt。未取得当前 turn 身份时不能依据泛化 session 状态补造当前任务结果。

## 4. 阶段 A：解除队列积压

主要文件：src/manager/task-manager.ts、src/store/process-lock.ts、src/store/task-store.ts、src/mcp/server.ts、src/host/stdio.ts。

- 同一服务 recovery single-flight：一次 recovery 正在等待/执行时，后续 tick 合并，最多一项 pending，不继续追加 promise。
- 同 data root 使用一个共享 recovery 调度时隙/协调 owner；多个 MCP 服务不能各自每秒全库扫描。记录 next_due、owner token 与有界健康期限；移交通过短事务和 fencing 校验，不能删除活 manager 锁，也不能改变 worker 的永久 attempt 执行 claim。
- 一次 recovery 建立同一份 task/status 快照，复用 running/queued/占用计算；先消除四遍扫描，再引入可重建的非终态索引。索引失效时回退重建，不能据缓存遗漏释放执行目录。
- zcode_status/result/events 读取原子持久化快照，检查同 attempt，不等待全库 recovery。若需纠正状态，安排一次后台核对；返回当前证据与 stale/reconcile_pending。
- 调度写操作保留串行化和跨进程锁，但队列有界。建议初始上限 32 项、未开始执行的排队预算 5 秒；超限返回 BRIDGE_BUSY，超预算返回 REQUEST_QUEUE_TIMEOUT。数值是拟定起点，需要阶段 A 压测后确认。
- 请求排队超时后先标记失效，执行前再次检查；不得稍后建立任务目录或派 worker。计时使用进程单调时钟，不能把 MCP 客户端 300 秒超时当成服务器自动取消证明。
- 取消先在短事务中记录意图、保留目录占用；进程/RPC 清理在锁外进行，提交时重新核对 attempt 与清理证据，避免清理等待堵住所有查询。

验收：188 条终态任务、5 个 MCP 服务运行恢复 tick 的隔离 fixture 中，恢复队列长度有固定上界；没有因积压导致的 300 秒等待；status 正常负载目标 1 秒内，故意争锁时 5 秒内得到响应或明确 busy；取消不受历史恢复积压阻塞。性能阈值用固定 fixture/并发数报告，不能只报一次手工 stopwatch。

## 5. 阶段 B：提交回执与幂等

主要文件：src/manager/task-manager.ts、src/store/task-store.ts、src/interfaces.ts、src/mcp/server.ts；两宿主 instructions/skill 同步行为说明。

- 验证后计算规范化任务 fingerprint；稳定排序对象键，保留数组顺序，包含 workspace/worktree、objective、requirements、路径限制、model、timeout 等执行语义字段。原始 prompt/敏感配置不写入调度诊断日志。
- 同 task_id + 相同 fingerprint 返回首次持久化的 receipt，不 spawn 新 worker、不增加 attempt。receipt 已是 queued/running 的接受凭据，若任务如今已终态，仍回放原 receipt，并通过可选 replayed/current_status 与 status/result 告知当前情况，避免扩大原 receipt.status 类型。
- 同 task_id + 不同 fingerprint 返回 TASK_ID_CONFLICT。旧任务若没有 fingerprint，可从原 task.json 做确定性比较；不能将“无法比较”视为相同。
- receipt 与接受事实在同一锁保护的可恢复事务中持久化，再提交调度。崩溃恢复明确区分未接受/已接受未派发/已派发回执丢失；跨进程同时重试只能接受一次。
- 可取消的排队请求超时前尚未接受：保证无副作用；已接受但客户端断联：任务保留，查询/相同 ID 重试返回事实。
- Codex 遇超时使用原 ID 查询/重试；禁止因超时把 _001 改成 _002。查询也失败时标记 submission_unknown，停止追加派发，保留原工作区。
- zcode_continue 属于新的执行意图，不能仅靠 task_id 去重：新增可选 operation_id，持久化 operation_id -> accepted attempt/feedback fingerprint。重试同操作不再增加 attempt；旧调用仍可用，但 instructions 要求可重试操作提供该 ID。
- 相同 payload 的重复 task_id 从错误改为回放 receipt 是明确的兼容行为变更，需更新契约说明和宿主测试；不同 payload 继续明确拒绝，不允许覆盖原任务。

验收：提交后丢失回执、多个进程同时重试、首次持久化各阶段崩溃、提交终态任务、旧格式任务、同 ID 不同 payload、continue 回执丢失。每个逻辑任务/续作操作最多一个被 claim 的 attempt，超时队列请求不得延迟派发。

## 6. 阶段 C：worker 身份、心跳与证据发布

主要文件：src/worker/run-task.ts、src/manager/spawn-worker.ts、src/adapters/zcode-app-server-adapter.ts、src/store/task-store.ts、src/interfaces.ts。

- 每 attempt 的 observation.json 原子更新。包含 attempt、worker PID、启动身份、ownership token、heartbeat_seq/at、session_id、turn_id、最后 native seq、执行状态、最后观测来源；不包含模型推理、原始工具输出或凭据。
- heartbeat 与模型输出独立，建议 3 秒发布一次、15 秒无进展视为过旧并触发核对；这些是拟定观测阈值，不是任务失败/自动重派期限。权限等待及长工具执行照常发布心跳。
- OS 支持时记录进程启动身份并核对 PID 重用；无法可靠取得时显式 process_identity_unverified，不把 PID 对应任意存活进程作为强证明。
- 写入使用 attempt/owner fencing，旧 worker 不能更新新 attempt。心跳不增加 events 全文，也不进入全局恢复锁。
- session/turn 身份在获得时立即发布，状态快照和事件一致。没有 session ID 的 starting 是合法状态；超时需报告启动卡在哪一阶段。
- 心跳异常只能触发诊断，不单独释放路径、清理存活 runtime 或自动重跑已执行 attempt。保留现有 pre-start 受 claim 保护的一次重拉例外。

验收：模型静默、长工具、等待权限、worker 事件循环卡住、worker 退出 runtime 仍活、PID 重用、旧 attempt 写入、Bridge 重启且 worker 存活、worker 正常结束时心跳停止。不能通过更改真实任务状态来验证。

## 7. 阶段 D：ZCode 原生核对与结果恢复

主要文件：src/adapters/zcode-app-server-adapter.ts、src/worker/run-task.ts、必要的窄接口与能力记录。

先验证当前安装 runtime。session/read、session/events、session/subagents 的方法存在或历史文档，不等于当前字段和恢复语义已验证。

验证矩阵：同一个活 app-server 内读当前 session；长工具/权限等待中读取；缺 seq/turnId 的兼容行为；Bridge 重启而 worker 仍持有 stdio；worker/app-server 退出后的持久化 session 读取；另一 app-server 读同 session 是否是实时状态或只是历史重建。不得用 session/resume 充当无副作用查询，也不能发送 prompt 来探测。

执行结构：

- 活 stdio 由 worker 持有，优先由 worker 在同一连接上发有界核对并发布 observation；manager 读取发布结果。manager 不能假设可另建连接访问同一个运行中进程。
- 正常靠推送事件；事件缺口/状态冲突时才核对。建议单次 RPC 预算 3 秒、同 session 一次 in-flight、失败退避 5–30 秒。不能每个 status 调用新建 app-server 或触发远程 RPC。
- 全局 manager 锁外执行原生查询；结果回来后按 attempt/session/turn/token 核验并短事务提交。过期查询结果只留诊断，不改当前状态。
- worker 不响应时，独立 read-only session 查询是否可行必须由验证矩阵决定。若不支持跨进程实时查询，返回 unknown，不实现基于新进程 snapshot 的虚假“仍在运行”。
- 持久化 events/snapshot 的结束证据只对已经建立身份映射的 turn 有效。恢复完整报告需复用现有 parseAgentReport/normalize 和 cleanup 约束；无法补取报告时保留 result_state=missing 与人工审查指引，不合成 completed 报告。
- 权限/input pending 由已验证的原生字段及现有 interaction 记录交叉核对；不自动回答，不从 session/messages 暴露完整对话。

门槛：提供安装版本/能力、脱敏请求响应样本、字段白名单、身份匹配规则、支持与不支持场景和超时行为。不能取得可靠证据的分支保持 unknown，而不是使用版本号推断支持。

## 8. 阶段 E：诊断与受控恢复上线

- 本地有界按 attempt 保存 app-server stderr，避免当前只在内存捕获。文件权限与保留上限明确；公开 MCP 只返回脱敏摘要/诊断位置，不默认返回原始内容。
- 结构化诊断记录 request_id/task_id/attempt/操作、queue_wait_ms、queue_depth、recovery_duration_ms、lock_wait_ms、heartbeat_age、probe_result、退出 code/signal、取消/清理阶段、receipt_replayed。诊断不阻塞 worker，不把 heartbeat 全部写成公开事件。
- doctor 增加 core/source commit、安装 bundle fingerprint、服务 PID/身份、data root、最近恢复耗时、pending recovery 和队列健康。区分“服务可响应”“运行记录新鲜”“已验证 runtime 能力”。
- 本地日志/agent metadata 只在原生查询不够时按指定 session/attempt 点查。不得扫描全部 rollout 填入恢复队列；mtime、Desktop index、日志文字都不能单独确定终态。session/subagents 作为后续独立能力，不阻塞核心可靠性修复。
- core 本地通过后，更新 dsh pin/tarball/bundle；在 Windows/Ubuntu CI 核验共享取消、并发接受、队列有界和恢复。明确区分本地 commit、push、CI、已安装缓存和存活进程加载版本。
- 上线前备份任务库并只读列出活 worker/runtime 与未获回执的任务 ID。受控停止/重启 MCP 服务，保留 detached worker；启动新版本后逐 ID 核对 receipt/attempt/session，先恢复原任务状态再放开新派发。
- 如果旧服务仍有未接受的超时提交积压，停止旧 MCP 服务使其内存队列失效，再由同 ID 接受事实核对决定重试。不能仅替换磁盘 bundle 就认为旧进程队列消失。
- RM09_004、TASK_089 按原 ID 核对；TASK_088 保留既有 timeout 事实，代码接受依据与执行报告状态分开。需要续作时使用显式新 attempt/operation_id，不覆写旧超时证据。

## 9. 分阶段交付与停止条件

| 阶段 | 独立交付 | 接收门槛 |
|---|---|---|
| A | recovery 合并、共享节流、快读与队列失效 | 5 服务/188 任务隔离复现不再积压；旧 attempt/路径占用规则仍成立 |
| B | 可恢复回执、task/continue 幂等、instructions | 丢回执/并发/崩溃矩阵只有一次接受/执行 |
| C | attempt 身份与独立 heartbeat、状态投影 | 静默/等待/卡死可区分；旧 worker 无法写新 attempt |
| D | 当前 runtime 协议验证、同连接原生核对、结果恢复 | 脱敏证据支持每个采用分支；不支持分支清楚返回 unknown |
| E | 有界诊断、dsh 更新、CI 与安装/服务版本恢复 | 本地/CI/安装版本各自验证；原任务记录无非预期改写 |

A/B 先解决重复派发风险，C/D 解决执行状态不明确，E 交付现场可诊断能力。A/B/C 的假 runtime 回归可独立开展，D 的真实协议证据不足不阻塞已验证修复，也不允许猜测完成。

每阶段：设计审查 → 最小实现 → 聚焦回归 → 适用完整回归 → 差异审查 → 本地独立提交。重叠文件串行集成，不自行派发到用户的两个项目会话。本文件没有授权向其他会话发消息或重新执行它们的任务。

停止条件：无法确定 attempt/turn 身份、runtime 只返回历史快照却被要求判实时、清理未验证、真实数据记录出现非预期变化、隐私白名单测试失败。停止相关恢复/新调度，保留证据；不能通过清空任务库、删除活 owner 锁、把 unknown 改成 failed 或提高 300 秒客户端等待来掩盖问题。

原计划 C/D、真实 native 查询验证与新增上线流程：NOT RUN。A/B 实施与完整验收状态见第 10、15 节。

## 10. 本轮证据、范围与实施顺序

共享基准：core 34134b6；dsh f7997db，依赖 pin 34134b6。新增工作不直接编辑插件缓存，不修改真实任务记录或交付物来制造通过结果。

mate90-vs-mate80-01 attempt 2：seq 232 为 turn_completed，随后 seq 233 报找不到 app-server PID 15748，最终 outcome=null、文件/测试数组为空。源码先 client.close()、后 parseAgentReport，确认清理异常可以丢掉已收到的报告并误分类为 zcode_nonzero_exit。

attempt 1：execution.claim/started.json 均指向 worker 38720，约 4 分 40 秒后被写为 worker_lost。没有判定瞬间的启动身份、心跳和查询记录，假阴性原因仍不确定，不能据此断言 Windows process.kill(pid, 0) 不可靠。当前源码/已安装 dsh 已有逐任务 recovery try/catch，不重复实现。

dsh Desktop 由 DeepSeek Harness.exe 执行 Bridge，worker 使用 process.execPath，环境白名单未传 Electron Node 模式；这是待复现的宿主启动风险，不认定为本次 respawn 根因。

实施顺序：R1 收尾/报告保全 → H dsh 启动核验 → C 身份/心跳/保守判定 → D0 原生能力实验 → D1 核对/恢复 → AB 补强 → E 两宿主交付/上线。D0 可提前独立验证；不支持的协议分支明确 unknown，不阻塞其他已验证阶段。

## 11. R1：收尾竞态与报告保全（P0，共享核心）

主要文件：process-spawn.ts、zcode-app-server-adapter.ts、run-task.ts、normalize.ts、task-store.ts。

- 收到当前 session/turn 的结束响应后，先解析并原子保存私有 outcome-checkpoint.json，再清理 runtime。保存 attempt/owner/session/turn/seq、结束类型、可见响应/解析报告与截断标志；沿用输出限额，不保存隐藏推理、原始工具结果或凭据。报告被截断且无法校验时保持 invalid_agent_report。
- 区分 turn 结果、报告校验、runtime 清理、Desktop 镜像同步。Desktop 同步失败记录诊断；Bridge 收尾异常不能泛化为 zcode_nonzero_exit，后者留给明确的执行失败。
- client.close() 同连接 single-flight、幂等记录结果，覆盖 EOF、child close、取消、关闭超时、taskkill 与自然退出竞态。
- taskkill 非零后有界核对同身份进程/已知树退出证据，不按 128 或中英文文案直接认定清理完成。根 PID 消失不证明后代全部退出；无法核验时保持 cleanup_failed。先明确既有进程树保证，再决定窄范围 Windows 追踪；Job Object 不是默认第一版前提。
- 有效报告且清理 verified：按报告发布 completed/waiting_for_master。清理未验证：保留 failed + cleanup_failed、workspace/slot，并用现有 report_candidate 保留完整报告；checkpoint 保留可恢复结果。既有失败投影的空 files_changed/tests 不再意味着报告丢失。
- manager/worker 使用同一份清理证据；清理未验证不能清空 runtime 身份。取消与结束并发重新核对结果、意图和身份，不吞掉已确认结果，也不无条件 completed。

验收：正常退出、taskkill/自然退出竞态、重复 close、取消/结束并发、后代仍活、查询失败、checkpoint 后 worker 崩溃、Desktop 同步失败、无效报告。Windows 真实进程 fixture 与两平台假 runtime 回归；成功报告不丢，未验证清理不释放占用。

## 12. H：dsh Desktop worker 启动核验与宿主适配

- 用隔离 fixture 复现 Electron execPath 启动，记录 shell/实际 worker PID、process.pid、argv、Node/Electron 版本、退出码、execution claim；不反复启动业务任务验证。
- 普通 Node 正常复用执行器；Electron 宿主显式选择经验证的 Node 执行器或可用的 Electron Node 模式。执行器用可信绝对路径/argv，不在工作区搜索 executable。
- 验证需要后才扩展 core 公共 host worker launcher 配置；模式由 dsh 提供，不扩大任意环境继承。可用时测试 ELECTRON_RUN_AS_NODE；安装 fuse 不允许时使用发现/配置的 Node，无法启动明确拒绝，不能把 GUI 当 worker。
- 仅无永久 execution claim 的 attempt 可走现有一次 pre-start 替代启动。claim 已取得但 started.json 未写不能被当作从未执行；旧格式缺身份须保守处理。

验收：普通 Node、真实可用 Electron 模式或明确不支持、环境过滤、缺执行器、启动即退出、claim/started 间崩溃。此风险与本次误判的因果关系仍待证据。

## 13. C 的实施规格：所有权、独立心跳与三态判定

主要文件：spawn-worker.ts、run-task.ts、process-spawn.ts、task-store.ts、task-manager.ts、interfaces.ts、mcp/schemas.ts。

- 每 attempt 永久 execution claim 扩展为版本化身份：attempt、owner token、worker PID、启动身份、claimed_at。旧 claim 不重写；启动 shell 与实际执行 owner 分开记录。worker_started 表示 spawn 接受，worker_running 表示 owner 开始。
- observation/checkpoint/最终结果写入在任务 state.lock 内检查 attempt + owner token。旧 worker/过期 probe/旧 turn 不得覆盖新状态；manager 判 worker_lost 前在同一短事务重读结果、claim、心跳与取消意图。
- 私有 observation.json：schema_version、attempt/owner、worker/runtime 启动身份、heartbeat_seq/at、session/turn/native seq、执行阶段、最后核对证据。公开只投影白名单摘要，不暴露 owner token。
- heartbeat 独立每 3 秒发布，15 秒未刷新标 stale 并触发核对，不判失败/重派；长工具/静默/权限等待仍刷新。finally 停止 timer，禁止把终态改回 running。进程内期限用单调时钟；跨进程序号/时间处理时钟跳变。
- 进程探测返回 alive/exited/unknown，附观察时间、方法、启动身份、脱敏错误。OS 查询失败是 unknown，不是 exited。Windows 原生查询用于身份和退出核对，具体方法先验证并有界执行；不在全局锁内同步调用 PowerShell/tasklist。Linux 同样核验启动身份；缺身份明确 unverified。

| 证据 | 状态与行动 |
|---|---|
| 当前 owner 心跳新鲜 | running；worker responding；执行状态采用已验证 runtime 证据；保留占用 |
| 同身份 PID 活但心跳旧 | running；unresponsive + execution unknown；有界 probe；保留占用 |
| 查询异常、PID 重用、来源冲突 | running；unknown + reason；不重派，不释放占用 |
| worker 退出、runtime 活或未知 | running；recovery_required；核对 runtime/session，保留占用 |
| worker/runtime 均确认退出且无可恢复结果 | failed/worker_lost；保存判定证据；清理 verified 后释放占用 |
| 当前 checkpoint/合法结果存在 | 优先校验并恢复；清理未验证仍占用 |

旧任务无 heartbeat 走 legacy 证据路径，证据不足 unknown；mtime、文件存在、session idle 不作终态权威。zcode_status 增加可选 observation：execution_state、worker_health、result_state、cleanup_state、observed_at/stale/reason、sources、attempt/session/turn、last_event_seq、reconcile_pending、recommended_action。心跳证明事件循环响应，不证明模型产出；waiting_permission/input 对照同 attempt 的 pending interaction；unknown 不建议换 ID 重派。

验收：静默、长工具、审批等待、事件循环卡死、worker 退出/runtime 活、PID 重用、查询失败、时钟跳变、旧 attempt/owner 写入、多 manager reconcile、Bridge 重启/worker 活、旧格式兼容、claim 后 started 前崩溃。

## 14. D 的实施规格：先验证能力，再同连接核对与恢复

### D0：真实协议能力门槛

session/read、session/events、session/subagents 是候选方法，不假定字段/恢复语义。记录当前 runtime/Node/Desktop 版本与路径、脱敏请求/响应、白名单、实时/历史属性、session/turn/seq 语义、错误与超时。session/subagents 仅记录能力，不阻塞本轮核心完成。

必须验证：同一活 stdio 读当前 session；工具执行/权限等待/静默时读；缺 turnId/seq；Bridge 重启但 worker 仍持连接；worker/runtime 已退出后历史恢复；另一 app-server 读同 session 的实时性；worker 不响应时可否跨进程只读。不能用 resume/send prompt 作为 probe。生成实验状态只能用隔离 fixture/测试 session；会调用模型的实验与 NOT RUN 项单独报告，不操作业务 session。

### D1：核对与恢复

- worker 持有原 stdio，adapter 提供窄只读 probe 并发布白名单 observation。正常靠事件；缺口/冲突/结果缺失才查。manager 发同 attempt/owner 的持久化 probe request；worker 不响应且 D0 无替代入口则 unknown，不为每个 status 启动新 app-server。
- 单 probe 初始预算 3 秒，同 session 一项 in-flight，失败退避 5→10→20→30 秒。超时移除 pending RPC并拒收迟到响应；probe 不阻塞 heartbeat/结束/取消。全局锁外查询，回写核对 attempt/owner/session/turn/source seq。
- 优先恢复 R1 checkpoint；无 checkpoint 仅采用 D0 已验证的当前 turn 结束证据与完整可见响应。复用 parseAgentReport/normalize 并校验清理；不通过文件存在/关键字补造 completed。
- 只有结束证据没有完整报告：finished + result missing + manual_review。报告无效/截断：invalid_agent_report 与候选证据。来源冲突 unknown，不重复发送 prompt。
- 同 checkpoint/turn 恢复幂等，不增加 attempt；取消/恢复并发按当前意图与已确认结束事实裁决，旧快照不能覆盖新取消或新 attempt。
- 今后当前非终态任务可做 checkpoint 崩溃恢复。历史已失败任务不自动覆写；需独立可审查恢复操作，先归档旧结果/状态，记录来源，不改交付物。

验收：订阅缺口、异 session/turn、重复结束、RPC 超时/晚返回、不支持方法、只读副作用检查、取消并发、checkpoint 各写入窗口崩溃、完整恢复/报告缺失/无效/截断、审批等待、worker 不响应、仅历史快照。每个采用分支必须有 D0 证据。

## 15. A/B 未完成项补强与验收

- status/result/events 加 attempt 前后校验，避免 continuation 跨文件混读；快读不等 recovery/RPC，带新鲜度/核对状态。
- recovery 复用一次扫描快照，消除重复历史读取；索引可重建且失败保守，不能遗漏占用。验证已有逐任务隔离与 pump 故障安全性。
- 取消拆为短意图事务→锁外清理→身份/结果复核提交。写请求的 5 秒未开始预算涵盖本地排队加跨进程争锁总时间，用单调时钟；过期未接受请求不能晚派发。
- task/status/workspace/submission receipt 各写入崩溃窗口可恢复；规范化处理 undefined/默认值/路径，避免假冲突/假等同。
- continue operation_id 的 intent/attempt/receipt 可恢复，重点覆盖 nextAttempt 的 continue.json 已写、status 尚在旧 attempt 的窗口；同操作不能在后续终态后再次执行。
- 两宿主 instructions 补充原 ID 重试、未知停止追加、续作 operation_id；仅 README 说明不算完成。

验收：188 条历史任务/5 个共享 data root 服务/运行队列混合 fixture。正常 status 目标 1 秒内，争锁写请求总 5 秒内响应或明确超时，队列容量 32，过期请求无副作用；并发接受及全部崩溃窗口最多执行一次。必须报告实际性能数据，不能以功能测试绿代替压测。

## 16. E：诊断、两宿主交付与上线

- 有界私有诊断：worker/runtime 身份、claim、心跳、查询方法/结论/耗时、清理阶段/OS exit、checkpoint/恢复来源、request/queue/lock/recovery 耗时。公开只给摘要，不按 heartbeat 刷 events，不暴露推理/凭据/原始工具输出。
- doctor 区分 core pin/source、磁盘 bundle fingerprint、活服务加载身份、data root、Node/Electron 执行器、恢复健康与经验证能力；不能将安装文件更新等同活进程升级。
- core 各阶段聚焦/适用全量验证后独立提交；dsh core:update 刷新 pin/tarball/lock，再重建 bundles，追加宿主 C/D/退出竞态/Electron 组合验证。Windows/Ubuntu CI 检查制品可重现。
- 安装/重启为独立步骤：备份任务库，列活 worker/runtime/未知提交和旧 manager。活业务未收敛时不盲目升级/重启 worker；受控重启 manager 保留 detached worker，按原 ID 验证。
- mate90-vs-mate80-01 保留历史失败与交付物验收，不继续执行刷绿。恢复报告先给可审查候选，不默认覆写历史失败；不向其他会话派任务或重跑它们的业务任务。

## 17. 新增交付门槛与状态

| 阶段 | 完成门槛 |
|---|---|
| R1 | 收尾竞态不吞报告；清理未验证不释放占用 |
| H | dsh Desktop/普通 Node 实际 owner 正确启动；不支持场景明确拒绝 |
| C | 心跳/身份/三态/fencing/投影矩阵通过，无静默自动重派 |
| D0 | 每个采用的原生方法/字段有当前 runtime 证据 |
| D1 | probe/恢复有界幂等；旧 turn/owner 不能改当前状态 |
| AB 补强 | 多服务压测及接受/续作崩溃矩阵通过 |
| E | core/dsh 本地与 CI 齐全；安装/服务版本另行确认 |

本轮仅确定方案；新增 R1/H/C/D0/D1/AB补强/E 的实现与验收均 NOT RUN。身份/能力/清理证据不足时停止相关终态发布或恢复分支，保留 unknown 和占用；独立已验证阶段可继续交付。不自动修改缓存、真实历史任务或重启活服务。
