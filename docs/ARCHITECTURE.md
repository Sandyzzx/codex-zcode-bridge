# 当前架构

> Status: AUTHORITATIVE
> Last updated: 2026-10-07
> Last verified: 2026-10-07（本轮核对 heartbeat 周期与 15 秒宽限、结果 checkpoint、事件补拉与降级；其余条款沿用此前记录，未逐条复核）
> Verified against: ed2d402

本文件描述当前代码，不是历史阶段的冻结设计。公共类型见 `src/interfaces.ts`，MCP schema 见 `src/mcp/schemas.ts`；共享边界见 [SHARED_CORE.md](SHARED_CORE.md)。

## 总览

```text
Codex 宿主
   │ MCP（stdio）
Bridge MCP server（src/mcp）
   │
TaskManager（src/manager）
   ├─ TaskStore（src/store）        任务证据持久化
   ├─ 调度队列与 worker 启动
   └─ 事件与 feedback 聚合
   │
ZCodeAppServerAdapter（src/adapters）
   │
ZCode app-server（zcode.cjs app-server --stdio）
```

| 组件 | 负责 | 不负责 |
|---|---|---|
| MCP server | 对外契约面：工具名、输入 schema、输出结构 | 任务状态判定 |
| TaskManager | 生命周期所有者：排队、调度、attempt 边界、终态、续跑、清理 | ZCode 协议细节 |
| TaskStore | 任务证据持久化：status、result、events、attempt 元数据 | 业务判断 |
| Worker | 单 attempt 的执行进程，一次进入、不重跑 | 调度决策 |
| AppServerAdapter | ZCode 协议边界：session、事件、交互、清理 | 宿主策略 |
| 调用宿主 | 准备执行目录、决定是否接收改动 | 任务调度 |

合同级定义见 [INTERFACES.md](INTERFACES.md)。

## 运行细节

`src/mcp/main.ts` 仅为 Codex 入口；`src/host/stdio.ts` 组合宿主 profile、运行配置、TaskStore、DirectWorkspaceProvider、BridgeTaskManager 和 MCP server。启动不创建 ZCode session；坏的 Bridge 配置会明确阻止启动。doctor 对坏配置返回 error。

Manager 用进程内 promise 队列以及同一 data root 下的 `.tasks/.manager.lock` 序列化调度。锁记录 owner PID，活 owner 不因时间超限被驱逐；死 owner 由串行 reclaim guard 回收。未完成 owner 发布的异常锁明确报错。不同 data root 不共享调度锁，需要调用宿主避免向重叠目录提交冲突任务。PID 重用的跨进程身份强化尚未验证。

同一 data root 内，FIFO 队列按 worker 上限和执行路径重叠规则启动 detached worker。Spawner 显式传 attempt。worker 在进入 adapter 前通过 attempt 目录的永久 `execution.claim` 抢占执行权，拒绝重复、旧 attempt 和终态入场。`state.lock` 保护状态更新和结果提交；worker 提交还校验当前 attempt/非终态。Manager 的延迟 PID 写入只作用于仍 running 的同一 attempt。

未启动 worker 可重拉一次；抢占过的 attempt 不会重复执行。已开始的 worker 不自动重跑。worker 丢失但记录的 ZCode PID 仍存活时保留占用，要求 `zcode_cancel` 验证清理。清理失败的终态任务也保留目录与 slot；续跑被拒绝，再次 cancel 成功后才释放。进程身份依赖 PID；操作系统重用 PID 和自行脱离进程组的后代属于未充分验证的边界。

worker 每 3 秒原子写入一次绑定 attempt 与 PID 的私有 heartbeat，字段含 session、turn、Bridge event 序号和已观测到的 ZCode event 序号。管理器遇到一次负向 PID 探测时，若 heartbeat 不超过 15 秒则暂缓失联判定。ZCode turn 完成后，worker 在清理进程前写入 outcome checkpoint，并在清理成功后更新验证标志；worker 在提交最终 result 之前退出时，管理器可据 checkpoint 恢复报告，清理未验证则保留 `cleanup_failed` 与 workspace 占用。

续跑先复制旧结果到 attempt 归档、准备 continue spec，再提交新 attempt 的 queued 状态。旧 root result 在提交前可恢复，在提交后因 attempt 不匹配不会被视为新结果。即使准备过程崩溃，原终态仍可读取。

审批记录按 attempt 隔离，公开 request ID 也带 attempt。相同 ID 的方法与规范化参数（包括 session 和输入）必须一致，否则拒绝。超时、取消和结束均 abort 待处理 interaction，释放 worker 轮询。

生产执行使用 ZCodeAppServerAdapter。历史 CLI adapter、envelope、loader 和 GitWorktreeProvider 保留为 legacy 模块及其测试，不从共享公共入口导出，也不参与生产任务路径。不要把 legacy CLI 的重试、快照排除或 worktree 创建语义应用到当前生产路径。

模型目录客户端与执行客户端目前保留各自 RPC 生命周期：前者处理短 session/cache，后者处理 turn/event/interaction。未为了减少行数合并协议客户端；公共配置、环境、报告和进程管理仍共享。

TaskStore 的 JSON 用临时文件原子 rename；事件文件有独立短锁、字节上限、关键事件保留空间和稀疏索引。追加只读最后一个字节，不重新读取完整历史。worker 把模型输出拆为 2000 字符事件；容量用尽仍可能丢弃非关键事件，普通超长摘要明确标记截断。

损坏记录会显式诊断、隔离调度，并保留可确定的执行路径。健康且不重叠的任务可继续；无法确定损坏任务的执行范围时暂停新调度，不能猜测它已经释放目录。

Desktop 索引同步是 best effort，事务内检查 schema 与 Bridge owner、更新有限状态字段，保留用户标题与额外 metadata。回归使用临时 SQLite。真实 Desktop schema/刷新/并发行为受安装版本影响，本轮未写入真实数据库。
