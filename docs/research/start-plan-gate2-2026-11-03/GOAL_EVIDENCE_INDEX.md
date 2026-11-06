# Gate 2 目标证据索引（进行中）

> Status: RESEARCH
> Baseline: 67dd8c67275c4afeb81dd9795ee03e258083c54d
> 本轮真实 OAuth、Billing、模型请求：NOT RUN。

- 历史 E2E 只证明旧 JSON 路径，见原研究 Worktree；不作为本轮验收。
- 私有帧、Lease、通道组件测试：Windows Node 24.16.0，9/9 PASS。首次通道组合测试为 8 PASS / 1 FAIL：`private_auth_receive_failed`，并伴有异步 `private_auth_delivery_failed`。原因是写端 `finish` 后立即清零 Buffer，接收端尚未消费，修正为不在此时变更缓冲，原组合测试复跑通过。测试不证明物理内存擦除。
- 生产 SQLite Worker + 真实 Adapter + fake AppServer：隔离合成标记一次交付，1/1 PASS，`worker-integration-first.log` 保存在 `.run/gate2-harness/`。此为合成 Provider，不是原生 AppServer 时序或真实 Provider E2E。
- 本机原生 AppServer 直接离线探针：`.run/gate2-native-probe/run-1793639893657/evidence.json`。预加载代码禁止网络与子进程，synthetic Registry；`turn.started` 在 runtime-header 之前，回调含 Session/Turn 后主动拒绝，得到 `turn.failed`；进程退出 code 0。不是生产 Adapter 组合证据，不能声称 turn.completed。
- 生产 Adapter + 安装版原生 AppServer + 指定 loopback 合成服务：`.run/gate2-native-probe/local-run-1793640520387/evidence.json` 和对应 `data/adapter-wire-local.jsonl`。观测顺序为 session/create → session/setModel → session/send → turn.started → runtime-header（Session 与 Turn 均匹配）→ turn.completed；一次 loopback 请求，Cleanup verified，746 文件扫描无合成标记。Guard 拒绝非指定回环端口和子进程。不是实际 Provider 请求或真实权益。
- 合成 405/code 3012：`.run/gate2-native-probe/local-run-1793640702595/evidence.json`。仅一次本地合成请求、一次认证回调、turn.failed；未观察自动重试。Adapter 在显式 broker Start Plan 分支设置 `ZCODE_MODEL_RETRY_MAX_RETRIES=0`；该观测只覆盖本机安装版和此类响应，不证明所有错误/版本没有其他重试路径。
- 尚未完成：异常和崩溃矩阵、精确 argv/env 扫描、认证回调对异常/取消的泄漏分析、真实 Adapter + 原生 AppServer 组合、Coding Plan 完整回归、最终独立审查、完整测试与 Bundle 验证。

此索引记录当前 WIP，不是 Gate 2 APPROVED。

## 后续验证与审查

- 生产 SQLite 两个 Worker 竞争同一租约：1/1 PASS，`.run/gate2-harness/worker-competing-lease.log`；只有一个任务取得凭据，两个任务各自完成 Release。
- 当前修改后组件、真实 SQLite Worker、Adapter 定向组合 48/48 PASS：`.run/gate2-harness/current-focused.log`。不代表完整回归或全部崩溃矩阵通过。
- 独立审查指出 Worker 返回凭据与 Adapter 响应写入之间，已观察到的父租约撤销可能未被再次检查。候选增加与缓存引用绑定的同步 `isValid` 检查。受控 Adapter 测试在返回后、写入前撤销，拒绝响应且合成标记未出现在线路日志：1/1 PASS，`.run/gate2-harness/revoked-before-reply-fixed.log`。前两次测试超时日志 `revoked-before-reply.log`、`revoked-before-reply-second.log` 保留：fixture 的完成事件重复使用 seq 1，实际拒绝响应已在 diagnostic 日志中观察，改为 seq 2 后通过。
- 撤销不是跨进程全局原子操作：只证明 Worker 已观察撤销后的同步检查；撤销尚未送达前及已发送到 AppServer 的数据不能承诺撤回。
- 实时权益尚由内部可信 `issue()` 边界提供，本阶段无真实权益验证实现。脱敏扫描目前覆盖完整合成标记，不能证明任意拆分或变换的凭据回显均被识别。
- 独立 Reviewer 复审认可上述已观察撤销的竞态修复，但结论仍为 CHANGES_REQUIRED：生产 Worker 的 ACK 丢失、写入中取消、Parent EOF、崩溃/重启、旧 Attempt 重放和 argv/env/交互诊断扫描尚缺完整证据。不得将组件级故障注入视为生产链路覆盖。
- 当前代码 `npm run typecheck`、`npm run validate:plugin`、`git diff --check` 通过；schema 专项 12/12 PASS（`schema-integrity.log`）。在 `.run/gate2-build-mirror` 执行 `npm run build` 首次失败，Windows 将编译目录 rename 到 `dist/src` 时返回 EPERM，输出保存在 `build-mirror.log`；尚不能标记 build PASS。标准全量测试等价的隔离编译/串行执行仍在进行，额外的源文件 schema 测试已单独运行。
- 隔离镜像 build 有一次复验，在同一 rename 步骤再次 EPERM（`build-mirror-retry.log`）；镜像中空目录跨父目录移动成功，故尚不能确定失败原因，不宣称已排除权限或句柄问题。
- 全量隔离 harness 运行中已出现 L2 和两项 host 路径测试失败。包含完整源码、插件目录的镜像定向复验 L2 1/1、host 2/2 PASS（`gate2-build-mirror/.run/l2-mirror.log`、`host-path-mirror.log`）；首次失败不抹去，完整结果待进程退出后分析。
- 全量 harness 结束：672 项，647 PASS、23 FAIL、2 SKIP（`full-isolated.log`）。已确认 L2 缺少 harness `src/manager`，Skill 用例缺少 Skill 文件，validator 缺少脚本；SQLite 启动 10 项在完整镜像复验 10/10 PASS（`bootstrap-mirror.log`）。其余失败尚未逐一复验；这不是标准 `npm test` PASS。进程退出后按命令行筛查未发现属于两处 harness 的残留 Node 进程；该筛查不能单独证明所有锁均已释放。
- 余下路径失败的镜像定向复验：9 项中 7 PASS、2 FAIL（`path-failures-mirror.log`）；后两项因复制镜像时排除了插件 `dist`，补入原仓库现有 bundle 后 2/2 PASS（`marketplace-baseline-mirror.log`）。Skill 测试 6/6 PASS（`skill-policy-mirror.log`）。Marketplace 测试使用旧 bundle，不能证明当前候选源码和 bundle 同步；完整运行仍为 FAIL。
- 构建诊断：仅在镜像副本的 `build-core.mjs` 的 rename 前插入 2 秒等待后，core 与 plugin 构建完成（`build-mirror-delayed-diagnostic.log`）。这支持时序相关假设，不证明根因，也不等同未修改脚本的标准 build PASS；原源码构建脚本未改动。
- 真实 SQLite Worker 路径，签发器阻塞期间取消，随后签发器迟到返回：1/1 PASS（`delayed-issuer-cancel.log`；增加数据根及请求日志的完整标记扫描后复验 `delayed-issuer-cancel-scan.log` 1/1）。验证未应用认证、正确绑定的迟到 Lease 不可领取、任务 Release；独立 Reviewer 核验通过该测试范围，不代表 ACK 丢失或崩溃矩阵已覆盖。
- 在延迟构建诊断产生的当前候选镜像 bundle 上，Marketplace 与 Worker 身份五项定向测试 5/5 PASS（`current-bundle-focused.log`）；不替代标准 build。
- 生产 SQLite Worker 的 ACK 通道被关闭：`worker-ack-channel-loss-write-evidence.log` 1/1 PASS；凭据帧写端 `finish` 恰一次、无重发、Lease 不可重新领取、任务 failed 且 Release、数据根和假 AppServer 请求日志无完整合成标记。写端 `finish` 不能证明 Worker 已消费，不能据此覆盖接收后 ACK 丢失的全部时序。
- 生产 Worker 在签发器等待中退出：`worker-exit-pending-issuer.log` 证明迟到 Lease 不能领取且未应用认证；加强为要求取消和 Release 后失败（`worker-exit-pending-issuer-release.log`），`CANCEL_FAILED` 因没有绑定的 Worker 句柄，保留失败现场。只读查询失败 fixture 的 SQLite：该 Attempt 仍为 `running`。原有恢复合同在缺失完整清理证据时 fail-closed；不能仅据 PID 不存在伪造清理或 Release。退出场景仍为未收束，不把首次较窄测试等同完整崩溃通过。
- 独立 Reviewer 复核 ACK 范围及 crash 证据：Manager 结束 `run()` 时移除活动句柄，之后取消缺少句柄而失败，保持占用符合既有 fail-closed 合同。要自动 Release 必须先有完整、身份绑定的后代进程与 AppServer/浏览器/交互资源关闭证据，并通过既有 CAS 清理门禁；仅凭根 PID 退出或观察到的 claimant 扫描不能证明完整关闭。恢复 hold、完整资源证据和后续 Release 尚未通过。
- 加入 ACK 通道反例后，正常交付、回显、错误 Turn/Claim、账户切换、交付后取消、迟到签发取消、ACK 通道关闭、双 Worker 竞争等生产路径定向组合 9/9 PASS（`worker-relevant-after-ack.log`）；不包括上述仍失败的 crash 自动 Release 测试。
- 在同一崩溃反例中重启真实 SQLite Authority：`worker-crash-restart-fence.log` 记录重新分类为 held、根只读，实际新任务创建被拒；随后原有要求取消成功及 Release 的断言仍因 `CANCEL_FAILED` 失败。测试同时验证迟到租约不再领取，不能将安全隔离与生命周期收束混为一项通过。
- 真实 SQLite continuation 旧 Attempt 重放：`worker-old-attempt-replay-resume.log` 1/1 PASS。Attempt 1 成功消费 Lease 并 Release；Attempt 2 实际进入签发器，复用该已消费 Lease 被拒、任务失败且 Release，认证仅应用一次。该测试同时依赖已消费状态和 Attempt 绑定，不单独证明未消费旧 Lease 的跨 Attempt 拒绝。首次失败 `worker-old-attempt-replay.log` 因 fake AppServer 缺少 `session/setMode`，第二 Attempt 未到认证阶段；已补齐 fixture，不改变断言。
- 加强旧 Attempt 测试后：`worker-old-attempt-unconsumed.log` 1/1 PASS。Attempt 1 额外创建一个从未交付的旧绑定 Lease，Attempt 2 获取该 Lease 时被拒；全测试 14.5 秒、Lease TTL 60 秒，排除已消费及过期作为本次拒绝原因。独立 Reviewer 已检查测试设计；结果仍限于本机合成生产路径。
- 增加两种合成标记的数据根及请求日志扫描后，旧 Attempt 反例再次 1/1 PASS（`worker-old-attempt-unconsumed-scan.log`）。当前 `git diff --check` 干净，index 无暂存；按测试路径筛查没有残留 Node，未据此推断所有锁均已释放。
- 生命周期管道 EOF：`worker-lifetime-eof-regression.log` 定向组合 3/3 PASS。首次授权后，关闭 Manager 端生命周期管道，同一仍存活 Worker 后续认证拒绝、任务失败并 Release。固定 500ms 等待不证明任意调度或真实 Manager 进程退出；Reviewer 已复核范围。
- ACK 真正丢弃：`worker-ack-received-discarded-detail.log` 旧实现中 Manager 收到 ACK 部分字节后丢弃，任务仍 completed，证明 Worker 可在 Manager 接受 ACK 前使用凭据。为修复此问题，在既有生命周期管道中加入 Manager 确认字节；只有严格 ACK 被接受后 Worker 才可交付 Adapter。`worker-confirmation-regression.log` 6/6 PASS，ACK 丢弃时任务 failed、认证未应用，写端仅完成一次；同时修正 abort 已发生后监听器才注册的管道关闭竞态。
- 确认丢失/EOF：`worker-confirmation-lost-expiry.log` 1/1 和 `worker-confirmation-eof.log` 1/1 PASS，真实 Worker 在确认丢失后到期或确认前 EOF 时均未应用认证、任务失败且 Release。均为受控管道故障；确认发出后及 Worker 实际观察撤销之前的跨进程原子撤回仍无法保证。
- 畸形确认：`worker-invalid-confirmation.log` 2/2 PASS，生产路径注入一次写入的重复确认 `[2,2]` 与非法字节 `[0]`，未应用认证并 Release。该结果不证明任意分片调度下，合法确认之后才到达的多余字节能撤回已用凭据。独立 Reviewer 复核确认握手后未发现新增必修安全问题；最终 Gate 仍受 crash、完整 secret isolation 与标准回归阻断。
- 确认等待期间取消：`worker-confirmation-cancel.log` 1/1 PASS。在 Manager 接受 ACK 后丢弃确认字节，再通过真实 SQLite `zcode_cancel` 取消；Worker 未应用凭据，任务 cancelled 并 Release，数据根及 fake AppServer 日志无完整合成标记。
- 确认握手后的 Coding Plan/Adapter/帧与租约定向回归：`confirmation-coding-regression.log` 39/39 PASS。`worker-argv-scan.log` 2/2 PASS：正常交付及 AppServer 回显场景扫描 ChildProcess 的实际 `spawnargs`、数据根、stderr、结果和 fake 请求日志均未发现完整合成标记；未读取 Worker OS 环境块，不能称完整 env/交互/所有诊断扫描已完成。
- 未修改构建脚本的当前候选镜像 `npm run build` 通过（`build-mirror-current-standard.log`）；八个改动的生产源码文件与 Worktree SHA256 分别一致。此前两次 EPERM 保留、根因未证实；镜像产物尚未同步至 Worktree 的受版本控制 bundle，不宣称源码/bundle 同步。
- 环境块单次快照：`worker-env-probe-fixture-isolated.log` 1/1 PASS。测试仅打开本次 Worker 的身份绑定句柄，核对 PID、创建时间及目标 x64 架构，读取有界环境块并只返回布尔结果；没有完整合成凭据标记。独立非 JWT 哨兵子进程的阳性对照通过。结论受本机 Windows x64 PEB 布局约束，只覆盖一次环境快照，不能代表任意编码/时点或其他子进程。
- fixture 隔离纠正：此前某些真实 Worker 合成测试未指定 builtin 配置，因环境中的 LOCALAPPDATA 只读发现了安装版 builtin；完全隔离目录复验首先以 `provider_config_missing` 失败（`worker-env-probe-isolated-control.log`）。现 fixture 显式设置其合成 builtin/personal 文件并恢复环境，完整隔离环境复验通过；之前结果不能视为完全隔离配置证据。
- 测试现场保全失误：两个同文件定向测试并行运行时，成功进程的 after hook 使用共享 fixture 根目录执行递归清理，报 EPERM 并误删先前崩溃反例保留的 SQLite fixture（`9fa01963-.../operations.sqlite3` 现不存在）；相应日志 `worker-exit-pending-issuer-release.log`、`worker-crash-restart-fence.log` 仍在。该轮并行组合中至少确认等待超时反例受影响，不能视为有效回归。已将 fixture 根改为每个测试进程独占的 PID+随机标识，必须重建失败现场并验证并行清理不会互相删除。
- 修正后在完全隔离 provider 配置下重建 crash：`worker-crash-rebuilt-isolated.log` 保留相同 `CANCEL_FAILED` 与重启 held；新现场 `.run/gate2-harness/dist-test/src/sqlite-candidate/wp6b2b1/.wp6-mvp-real-adapter-12620-063c6404-2672-48be-b86a-337e90b0640b/0885dd94-4837-408e-8864-11f8c8c2525a/sqlite-root/operations.sqlite3` 只读确认 Attempt 为 running。此后审批交互测试和两个并行独立进程（`worker-parallel-fixture-a.log`、`worker-parallel-fixture-b.log`，各 1/1 PASS）均结束，重建 SQLite 仍存在；并行运行保留根与另一进程清理互不影响。
- `worker-interaction-secret-scan-isolated.log` 1/1 PASS：fake AppServer 在审批理由和参数中回显完整合成凭据，真实 SQLite Worker 向 MCP 展示、记录审批并完成后，数据根、公开事件与结果、stderr 和 fake 请求日志均不含完整标记；不涵盖变换/分片的任意编码。
- Reviewer 指出的 harness 清理时序缺陷已修复：`withRealAdapterMcp` 原先在 `run()` 返回后立即标记 `successful`，随后吞掉 client/server/manager/authority 的 shutdown 错误，关闭失败时仍会删除本进程 fixture。现改为资源全部关闭且无 shutdown 失败后才标记成功，authority 关闭失败也会向上抛出；失败 fixture 因此被保留。该修改为测试辅助代码，不进入生产路径。
- 崩溃 Release 阻断已用证据路径关闭（本轮核心修复）。根因有两层：(1) 驱动以 `result_rejected` 结束时无条件删除 `activeWorkers` 条目，而操作阶段仍为 `running`（`result_rejected` 不落库），使 `cancelRunning` 专为已退出 Worker 设计的 `already_exited` 验证释放路径永远不可达；(2) Windows Node 24.16.0 实测 `child.kill()` 后 `exitCode=null`、`signalCode="SIGTERM"`（`kill-semantics-probe.mjs`），且 `close` 事件可能先于监听注册触发，`waitForClose` 只检查 `exitCode` 导致 `worker_stop_timeout`。修复：驱动结束时操作仍为 `running` 则保留绑定句柄；`waitForClose` 在 `exitSeen` 且全部 stdio 已关闭时直接返回；取消证据新增 `worker_termination_signal`；释放完成后从 `activeWorkers` 退役条目。证据链：Worker 退出精确身份探测（exited）→ 不需终止（already_exited）→ OS 全局 claimant 扫描 fail-closed（存活孤儿会保持占用）→ stdio 关闭 → 清理证据 → Release。这是证据化释放，不是 PID 消失伪造；存活孤儿进程仍会被扫描保持占用。
- 崩溃场景重验：修复后 "Worker exit while issuer is pending revokes a late lease" 与新增的 "crash without cancellation holds recovery and fences dispatch" 2/2 PASS（`crash-release-retest4.log`）；前者现在验证取消成功、任务 cancelled、Release、重启恢复分类 complete、根不再只读、新任务可派发；后者保持崩溃不取消时 held + 只读 + 拒绝新任务的 fail-closed 合同。该文件全量 24/24 PASS（`crash-release-full-rerun.log`）。
- 镜像同步与本轮全量回归：`src/store/lifecycle-gate.ts`（SHA256 `83E7154C…99BD97`）与 `mvp-real-adapter.test.ts`（`9615EBD1…43975C2A`）同步至 `.run/gate2-build-mirror` 后，未修改构建脚本的标准 `npm run build`、`tsc --noEmit`、测试编译全部通过。两次标准全量 `npm test` 各 689 项、2 SKIP：第一次唯一失败 `mcp-stdio-entry`，根因是本轮把测试环境目录放进镜像包根，触发 `sqlite_data_root_reserved_location` 的保留位置判定（代码行为正确），环境移至项目内包根外后该文件 4/4 PASS（`full-test-final.log`、`full-test-final2.log`）；第二次该测试通过，唯一失败为旧 JSON `TaskStore` 路径的 `runtime-remediation` 权限回复测试在满载下 Worker 退出超出 5 秒期限（`hung`），该测试不引用 lifecycle-gate，且第一次全量与单跑复验均通过（8.7s）。两次运行合并覆盖下每一项测试均至少有一次全量运行通过，Gate 2/SQLite 表面无失败；两次失败均为已定位的环境或负载因素并有独立复验，不据此宣称绝对零抖动。
- 独立 Reviewer 第二轮裁决：崩溃后的身份验证、清理与 Release 路径及定向证据可接受；仍要求 (1) fixture 成功标记必须在 Authority 关闭成功之后、(2) 生产路径写入中取消验证、(3) 单次零失败完整回归，不接受两次有失败运行的合并宣称。以下三项为对应处置。
- 修复 (1)：`withRealAdapterMcp` 重构为收集 run/client/server/manager 关闭失败，authority 关闭在既有 finally 完成后，任一失败先抛出且 `successful` 仅在全部资源关闭成功后标记——authority 关闭失败现在必然保留 fixture。测试辅助代码，无生产影响。
- 修复 (2)：新增生产路径测试 "SQLite cancellation during an outstanding credential write aborts delivery once and releases"（`write-cancel-first.log` 1/1 PASS）。真实 SQLite Worker + 真实 Adapter + fake AppServer，harness 在 `onWorkerSpawn` 中持有 Manager 侧凭据帧 `end()`，在写入未完成窗口内通过真实 `zcode_cancel` 取消；断言取消后 Release、帧 `end` 恰一次（无重发）、Worker 未应用认证（无 `auth_applied`）、数据根与 fake 请求日志无完整合成标记。取消经 `privateAuthAbort` 触发帧流 destroy，`servePrivateCredential` 终态 revoke，与生产代码一致；未修改生产代码。
- 处置 (3)：同步两个变更文件后第三次标准全量 `npm test` 以修正环境（`.run/gate2-test-env`，位于项目内且在所有包根之外）单次运行完成：689 项，687 PASS、0 FAIL、2 SKIP（`full-test-final3.log`）。该运行包含修复后的 fixture 成功标记逻辑、崩溃 Release 24/24 全文件（含新增写入中取消测试），此前两轮中的两类失败在本轮均未复现。这是 Reviewer 要求的单次零失败完整回归；2 SKIP 分别为平台受限用例，与既有基线一致。
- 独立 Reviewer 第三轮裁决：fixture 清理时序修复与第三次 687/0/2 全量回归确认接受；但此前写入中取消测试在 `end()` 调用前拦截，证明的是写入前取消，不满足"部分帧已写入后取消"的验收要求，仍为 CHANGES_REQUIRED。
- 部分帧取消重做：测试更名为 "SQLite cancellation during a partially written credential frame aborts delivery once and releases"。harness 现将凭据帧拆分：4 字节 prefix + 前 64 字节 body 通过真实 `stream.write` 交付（以 write 回调证明字节已交给 OS socket）后扣留剩余字节，测试再经真实 `zcode_cancel` 取消。断言：帧 `end` 恰一次（无重发）、Worker 未应用认证、Release、数据根与请求日志无完整合成标记；若 Worker 失败结果先提交，则其 summary 必须标识 `private_auth_receive_failed`（EOF 中断帧）。`write-cancel-partial.log` 1/1 PASS（10.7s）。生产代码未改动；取消语义（abort → 帧流 destroy → servePrivateCredential 终态 revoke）与既有实现一致。
- 第四次标准全量 `npm test` 以最终测试文件（`mvp-real-adapter.test.ts` SHA256 `1C17E2EF…256629E5`）重新同步镜像后单次运行完成：689 项，687 PASS、0 FAIL、2 SKIP（`full-test-final4.log`）。该运行包含部分帧取消测试且本轮两处历史失败均未复现，是针对 Reviewer 第三轮要求的最终单次零失败完整回归。
- 独立 Reviewer 第四轮裁决：真实管道写入与 687/0/2 全量回归接受；剩余精确缺口为写入回调忽略错误，不能严格证明字节成功交给 OS。已修复：write 回调现检查 handoff 错误，失败时拒绝 `writeBegun` 使测试以 `partial frame handoff failed` 失败；定向复跑 1/1 PASS（`write-cancel-partial-handoff-assert.log`，12.7s）。最终测试文件（SHA256 `CF47B6B7…1A6B80`）同步镜像后第五次标准全量 `npm test` 单次运行：689 项，687 PASS、0 FAIL、2 SKIP（`full-test-final5.log`）。
