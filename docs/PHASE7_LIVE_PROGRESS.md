# 进度集成兼容说明

此文件为历史 Phase 7 源码引用提供当前说明，不重建历史冻结契约。详细架构与事件接口见 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [INTERFACES.md](INTERFACES.md)。

生产 worker 通过 app-server 订阅 session/event，仅转发可见文本、工具名称/状态和有限生命周期 metadata。隐藏 reasoning 和未知 usage metadata 不进入公开事件。审批必须保留必要的输入以供主代理判断，属于私有任务证据。

订阅前记录 snapshot.runtime.eventSeq；过期 seq、外部 session 和不匹配 turn 被过滤。有历史事件的 session 需观察新的 turn.started；旧版本缺少某些身份字段仍存在兼容路径，其真实行为尚未全部验证。协议变化不能只靠字符串方法名推断支持。

worker 每 3 秒原子写入一次 attempt/PID 绑定的私有 heartbeat，包含 session、turn、Bridge event 序号和已观测到的 ZCode event 序号。管理器遇到一次负向 PID 探测时，若 heartbeat 不超过 15 秒则暂缓失联判定。ZCode turn 完成后，worker 会在进程清理前保存私有 outcome checkpoint，并在清理成功后更新验证标志；worker 在最终 result 提交前退出时，管理器可恢复报告，清理未验证时保留 `cleanup_failed` 与 workspace 占用。

当前没有在本机验证 `session/read` 或 `session/events` 的运行时版本与字段语义，因此不发送这些请求，也不以推测的原生状态覆盖 app-server 事件和 heartbeat。D 阶段的原生 session 状态查询仍为 NOT RUN。

本轮模型无关回归使用假运行时，覆盖 replay、foreign session/turn、参数相同的重复审批、续跑请求身份、未知 usage 私密字段、可见输出完整性和真实 worker 超时退出。真实 ZCode 权限审批和 Desktop UI 刷新未运行。
