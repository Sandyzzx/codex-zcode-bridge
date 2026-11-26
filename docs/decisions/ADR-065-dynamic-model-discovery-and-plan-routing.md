# ADR-065：动态模型发现与 Plan 路由

> Status: DECISION
> Date: 2026-11-26
> Decision: Accepted（Owner 在 Preview.19 任务中明确批准）
> Baseline: `origin/preview` `00d37aba9acd3c00a5411415d575edae1deadd9c`

## Decision

1. **AppServer 快照是模型权威。** 任务路由在派发前读取执行工作区的实时
   `session/create` 模型目录。模型匹配使用精确 `providerId + modelId`；
   目录为空、读取失败或模型不存在时拒绝派发，不回退旧缓存。
2. **Model Catalog 不再用缓存结果决策。** `zcode_model_catalog` 每次读取实时
   目录；写入的 snapshot 仅作为审计痕迹，不作为下一次读数或派发来源。
   24 小时 TTL 决策路径退役。
3. **Plan 路由矩阵基于实时目录。** 明确 Provider 选择严格保留。未指定套餐时：
   Start Plan 独有选 Start；Coding Plan 独有选 Coding；两者同型号默认选 Start；
   两者均不可用失败。Billing verdict 不再触发模型或套餐 fallback。
4. **Start Plan 别名只做表示层适配。** AppServer 已返回 `-StartPlan` 时保留原
   ID；AppServer 返回基础 ID 时，Bridge 生成动态别名供选择，并在最终
   `session/setModel` 使用 AppServer 返回的完整 ID。别名追加幂等。
5. **Reasoning 使用所选条目元数据。** 有 `defaultLevel` 用默认值；显式档位必须
   出现在同一 Provider/Model 条目中；元数据缺失时既不推断也不跨套餐借用，
   显式请求失败。最终以 `session/setModel` 回读为准。
6. **设置失败是模型准备失败。** `session/setModel` 失败时保留请求 Provider/
   Model 和原始错误证据，发布 `model_setup_failed`，不自动切套餐，不发送
   Turn 请求。

## Non-Changes

- 不修改 Executor 架构、SQLite Schema、Task/Attempt 状态机、Wake、Cleanup、
  Recovery、WebUI、认证凭据或其他 Provider 路由。
- 不新增模型名单、模型数据库或常驻模型发现服务。

## Verification

- 已用已安装 ZCode AppServer 完成零模型 `session/create` 目录探测：快照包含
  `providerId`、`modelId`、`reasoning.levels` 和 `reasoning.defaultLevel`。
  Coding 当前快照为 REAL PASS；Start Provider 的任务态目录探测同样为 REAL PASS，
  但该探测使用临时 Provider snapshot，没有发送模型或 Billing 请求。
- 合成 AppServer 测试覆盖新模型发现、双套餐、显式套餐、单套餐、缺失模型、
  后缀保留/幂等、Reasoning 隔离、目录更新、设置失败与默认模型保留。
