# Start Plan 集成接收与计划

> Status: RESEARCH
> Date: 2026-11-03
> Baseline: `67dd8c67275c4afeb81dd9795ee03e258083c54d`（已核对远程 master）

## 历史资产清单

| 资产 | 状态与处理 |
| --- | --- |
| 历史 `src/startplan/` OAuth、权益映射、Session Auth | 已实现和历史合成测试；未在本基线集成。逐项审查后适配，不照搬设备头和生命周期假设。 |
| 历史 Adapter runtime-header 分支 | 已实现、历史测试及一次真实 E2E；需适配当前 Adapter 和 SQLite Worker。 |
| 历史 `worker-entry.ts` | 依赖 JSON `TaskStore`；不得作为 SQLite 生产入口移植。 |
| 主工作树未跟踪 `src/runtime/start-plan.ts` | 包含 Desktop 私有凭据解密；不移植。 |
| 主工作树 `provider-capabilities.ts` | 静态配置能力研究，非账户权益；需审查是否与当前原生 Registry 重叠。 |
| 历史真实 E2E 与设备调查 | 保留为历史证据；不能证明当前版本通过。 |

## 集成计划

1. 保持当前 SQLite Manager、Task/Attempt、Claim、Result、Cleanup 和 Release 所有权不变；确认 Worker 子进程与授权入口的生命周期。
2. 设计一次性的进程内凭据交付边界，绑定账户、精确 provider/model、attempt、Session 和 Turn；不得写入 SQLite、任务、事件、日志或命令行。无可信交付或身份绑定时 fail closed。
3. 以原生 Registry 事实提供模型目录；实时权益结果须与账户、模型及当次运行绑定，unknown 不提升为 available。
4. 审核 OAuth、Billing 设备身份来源、取消和失败语义；不生成随机身份规避限制，不在 401/403/429 或 unusual activity 后自动重试或切换。
5. 先运行合成与 SQLite 生命周期回归，再完成完整测试、构建、打包验证和独立审查；真实 E2E 单独记录当次账户授权、设备身份及一次任务预算。

## 当前已发现的适配缺口

- 历史 `StartPlanSessionAuth.reply()` 仅在已知 Turn 时校验 Turn；目标合同要求严格绑定，不能直接声称满足。
- 历史研究入口与认证对象同进程，当前 SQLite Worker 为独立进程；安全、身份绑定且不落盘的凭据交付尚未证明。
- 历史 Billing 设备 ID 为进程临时生成，与隔离 AppServer 持久 deviceMid 不同源；因果关系未知，不应直接沿用。
- 真实账户此前报告限制；历史成功和本次真实 E2E 必须分别记录。

本文件为接收和实施计划，不代表功能集成或测试通过。
