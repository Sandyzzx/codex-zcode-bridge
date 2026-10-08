# 长会话可靠性修复记录

> Status: RESEARCH（一次性交付与验证记录，不替代当前合同）
> Date: 2026-10-08
> Branch: codex/long-session-reliability-fixes
> Base HEAD: ed2d402

## 问题证据

检查会话 `01a0dee0-0001-7773-ba52-706087631028`、本地 LumeCAE 任务记录和整改索引。快照有 167 个逻辑任务、275 个唯一 attempt 结果：completed 138、failed 119、cancelled 16、waiting_for_master 2。失败包含 timeout 56、zcode_nonzero_exit 21、cleanup_failed 15、worker_lost 13、invalid_agent_report 7、provider_config_invalid 6、execution_mode_disabled 1。它们跨插件版本、包含续跑，不是项目失败率，也不是当前版本故障率。

6 个格式失败涉及 needs_master_decision；12 个清理失败摘要有编码替换字符。2026-10-06 曾因不可读取的 recovery-lock owner 排队约 1,490 分钟；2026-10-08 JD2 恢复任务与 JD4 再次出现清理和报告格式故障。历史材料仅用于选定回归，不修改真实任务库或重新执行其他会话的项目任务。

## 本地改动

| 范围 | 修复与保持的边界 |
| --- | --- |
| Windows 清理 | 终止前采集当前根/后代身份，终止后按 startup fingerprint 确认退出。taskkill 非零可由新退出证据解消；根退出不掩盖存活子进程，unknown 不释放占用。公开错误用稳定代码，避免本地化 stderr 乱码。 |
| Windows 身份查询 | 只有正常结束并带完整标记的批量查询可认定缺失 PID 已退出；部分输出、权限错误或截断不变成“已退出”。 |
| 锁释放 | 原子撤销完整共享锁目录，再尽力删除私有 retired 目录。崩溃不在共享锁名留下缺 owner 的目录。释放异常仍复位 recovery single-flight。 |
| 报告 | 保留严格 AgentReport 校验，提供有效 JSON 示例和必填布尔检查。显式报告修复续作只携带 candidate、有界原响应与反馈，不重发原实现目标/测试命令，不自动发起修复 turn。 |
| provider | 优先精确 runtime catalog ID，仅有同 model 的 account catalog 项或官方 account 映射规则时解析无前缀旧 ID；保留请求值与实际选择，不更改工作区默认，最终由 session/setModel 验证。 |
| 反馈 | 心跳而无业务事件不推断业务执行；固定模板区分原 cleanup_failed 和后来 cleanup=verified。记录更新时间不充当业务事件时间；投影拒绝混用旧 task/attempt/status 的结果。 |
| 调度 | 压力回归发现同次 pump 三轮重复全量校验，改为一次锁内快照并复用；启动前重读状态，不跨操作缓存，不降低占用保护。仍随历史库规模增长。 |
| 交付 | ADR-005 先于合同改动，更新架构、接口、运行配置、文档索引与随插件发布的 skill；两个 bundle 重建。 |

## 验证

| 检查 | 本次证据 |
| --- | --- |
| 定向回归第一轮 | 53 passed，0 failed，0 skipped。包括真实 Windows 父/子进程树终止、真实系统身份查询、锁释放中崩溃，以及 taskkill 非零/残留后代/unknown 的受控测试。后续新增反馈、provider 集成和 recovery 释放异常用例纳入全量检查。 |
| 第一轮全量 | 278 tests：276 passed、1 failed、1 skipped；失败为新增 recovery 释放异常用例的 fixture 心跳仍新鲜，未进入注入探测路径。已令 fixture 心跳过期，27 项观察/恢复定向检查全部通过。首次压力用例通过，32/10,000 档 setup 732,770 ms，recovery 25,772 ms；该轮尚未包含调度快照优化。 |
| npm run typecheck | PASS，exit 0 |
| npm test（最终代码） | PASS，exit 0；279 tests：278 passed、0 failed、1 skipped（Windows 不适用的 POSIX mode 权限用例），耗时 647,395 ms。包含真实 Windows 树清理、锁释放崩溃、provider 假运行时集成、单次调度快照和释放异常后的恢复回归。 |
| npm run build | PASS，exit 0；server 与 worker bundle 已同步 |
| npm run validate:plugin | PASS，exit 0 |
| git diff --check | PASS，exit 0；只有既有 LF/CRLF 提示 |

最终压力回归使用临时库与假 worker/probe，未调用模型。每档状态查询 60 次，均未触发 OS probe，p95 小于测试预算 250 ms：

| 合成规模（active / historical） | status p50 / p95 / p99（ms） | fixture setup（ms） | recovery（ms） |
| --- | --- | --- | --- |
| 1 / 0 | 6.33 / 19.55 / 23.13 | 137 | 108 |
| 8 / 1,000 | 1.93 / 2.24 / 2.50 | 35,988 | 2,964.2 |
| 32 / 10,000 | 2.92 / 4.58 / 6.36 | 564,977 | 33,741.2 |

最大档仅 8 个 worker 运行，24 个正常排队。setup 包含历史记录生成及 active 提交，不能当作纯派发延迟；两轮不是控制缓存与系统负载的性能实验，不能据此承诺固定提速比例。最大档 setup 仍约 9.4 分钟，recovery 仍约 33.7 秒，显示全库校验扩展性尚未解决。近容量事件扫描读取 589,824 bytes，在预算与允许块余量内，正确返回 scan_incomplete。

## 不确定与未运行

- 未在真实 ZCode provider 发起任务验证模型选择或报告一次合格率；模型仍可能违反 JSON 合同。
- 未运行跨版本 session/read、真实审批、GUI 或长期无人值守验收；不切换默认 Executor。
- 进程树采样后新建或已脱离树的后代，以及查询与发信号间的 PID 复用窗口，仍未充分验证。
- 本次树身份快照用于当前强制终止调用，没有作为长期持久化后代清单保存。Windows app-server 自然关闭和后续只读恢复仍依据记录的 worker/runtime 身份，不能据此保证孤儿后代已经退出；完整的跨重启树清理闭环仍未完成。
- 旧损坏 owner 与遗留 reclaim guard 不能只按年龄删；本次修复防止新的释放缺口，不自动修改旧锁。历史 worker_lost 的确切根因仍不确定。
- 未改安装缓存、重启服务、同步 dsh、提交、推送或发布；本地修复不等同已加载到其他会话。版本仍 1.2.2，后续发布走 release-please。
