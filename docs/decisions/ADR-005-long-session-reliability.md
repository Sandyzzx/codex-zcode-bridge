# ADR-005：长会话清理与报告修复

> Status: DECISION
> Decision: Accepted（用户于 2026-10-08 授权执行本次修复）
> Date: 2026-10-08

## Context

LumeCAE 长会话的持久化证据包含 Windows 清理失败、报告字段缺失、旧 provider ID 选择失败与恢复锁阻塞。历史失败不应通过改写真实任务记录消除；个别 worker_lost 与旧损坏锁的根因仍不确定。

## Decision

1. Windows 清理在终止前采集当前进程树及启动身份，终止后核验采集到的所有身份。taskkill 非零退出不能独自决定失败；只有已记录身份全部退出才确认清理。仍存活或 unknown 均保持失败与占用，探测表明根身份已退出或重用时不向该 PID 发信号。不按本地化错误文本判定成功。
2. 锁释放先将完整目录原子移出共享锁名，再尽力清理私有 retired 目录。活 owner、不可读取的旧 owner 不按年龄删除。恢复 promise 的清理必须在锁释放异常时也执行。
3. AgentReport 继续严格校验，不补造缺失的 needs_master_decision，不自动发送修复 turn。任务提示提供合法 JSON 示例；报告续作只提供既有报告证据和反馈，省去原实现任务，禁止编辑文件或重跑测试。
4. 模型选择优先保持 runtime catalog 中的精确 provider/model；仅在精确值缺席且对应 account 前缀值真实存在时解析无前缀旧 ID。不能只按 model_id 或显示名称选择其他 provider。
5. 心跳且缺少业务事件时不声称正在执行业务；固定反馈投影只读取相同 task/attempt/status 的结果，业务时间从 observation 的业务事件年龄取得，不使用 status 更新时间。历史 cleanup_failed 与后续清理验证作为两个事实保留。公开任务状态、MCP schema、隐私边界和依赖保持不变。
6. 大历史库回归确认调度重复全量校验。每次持有调度锁的 pump 只采集一次健康性与状态快照，复用于 running、损坏记录占用和 FIFO queued 集合；启动前仍重读 queued 状态。快照不跨操作缓存，不省略终态健康检查，不降低损坏任务或 cleanup_unverified 的占用保护。调度复杂度仍随历史任务数增长，不能宣称消除了长期扩展限制。

## Rationale

按身份和实际退出证据消除收尾竞态，比忽略 taskkill 错误更保守；原子撤销锁避免释放中崩溃留下缺 owner 的共享目录。严格报告校验和显式续作保留 Master 决策权。

## Consequences

Windows 清理增加有界的系统进程树查询，使用已有 PowerShell 系统设施，无新包依赖。采样之后新建或自行脱离的后代仍为未充分验证的边界。旧损坏锁需要独立诊断，不自动修复真实任务库。模型输出仍可能违反合同；本修复不保证所有报告一次合格。真实 provider、跨版本协议和长期无人值守回归需另行验证。
