# TaskPackage 与派发

> Status: AUTHORITATIVE
> Last updated: 2026-11-11
> Last verified: 2026-11-11，核对当前 MCP zcode_task schema、TaskPackage 接口、ADR-031 模型路由与 Prompt Builder 限制；真实 Worker 派发 NOT RUN。
> Verified against: 372e90622772b070357a278f1da3dea58fa42dee（基线；本候选离线证据见 docs/research/master-skill-simplification-20261111.md）

本文件假设入口授权已确认。提交前先完成 Ready Gate：确认目标、Codex 项目根目录、实际执行目录、修改边界、必要输入、验收标准、适用测试要求和预算是否充分；不适用项可为空或说明原因，不强行虚构。提交前另读 [监控与审批](monitoring-and-approval.md)，任务返回后立即跟踪事件。

## 公开字段

`zcode_task` 只接受现有 schema：`task_id`、绝对 `workspace`，以及可选 `worktree_path`、`model`、`timeout_ms`；正文为 `objective`，五个数组 `requirements`、`allowed_paths`、`forbidden_paths`、`acceptance_criteria`、`test_commands` 必须存在且可为空，`context` 可选。`whole_task`、`staged` 和 `auto` 都不是额外字段。

- `task_id` 最长 64 字符，仅字母数字、下划线和连字符，且以字母数字开头。同一完整交付复用同一 ID；MCP 报错后先诊断，不重复提交相同 ID。
- `workspace` 始终是 Codex 项目根目录。需要隔离时 Codex 先创建并确认 worktree，再传其现存绝对路径；未传 `worktree_path` 则直接在项目根执行。Bridge 不创建、选择或删除 worktree。
- 必须遵守的约束、非目标、权限和停止条件写入 `requirements` 或路径字段；`context` 只保留必要决策背景和相关文件，Builder 只保留前 2,000 个字符。
- 路径数组是 Worker 指令，不是 OS 沙箱。空 `allowed_paths` 表示不额外限定，不表示禁止写入；需要专属限制时才填写实际执行目录内路径。
- 测试命令来自当前项目权威说明、测试清单或已核实存在的适用入口；没有适用命令时用空数组，并在验收标准中说明验证方式或不适用原因。不要把通用命令名当成所有项目的默认要求。

## 模型与预算

- 任务/用户指定模型优先；未指定时沿用 Bridge 持久默认，其次 ZCode session 默认。用户未指定时省略 `model`，不把项目默认或请求值写成 runtime 实际值。
- 公开 `model.provider_id` 可选，`model_id` 必填，`reasoning_level` 可选。显式 provider/模型保持强制语义；省略 provider 的普通模型按 `ZCODE_BRIDGE_PREFER_STARTPLAN`（默认开启）在任务创建时一次选路，且只可在 Start Plan 与支持同一模型 ID 的 Coding Plan 间选择。
- `<ModelId>-StartPlan` 是 Start Plan 用户可见别名；目录别名不代表实时权益，权益以任务运行时结果为准。执行失败后不跨套餐自动补跑或替换模型。
- 需要精确标识时优先读取 `zcode_model_catalog` 或 runtime 事件报告；`reasoning_level` 只在用户指定或可靠目录/默认配置提供时传入，不用目录默认值冒充 runtime 已确认档位。
- `timeout_ms` 可选，范围 60 秒至 4 小时；省略沿用配置默认。超时或失败后先核对事件、实际文件变化和未完成项，再决定受控续作，不用新 task_id 原样重派。

## 内容模板

`whole_task`：`objective` 写用户可观察的最终状态；`requirements` 写已批准合同、兼容要求、非目标、权限限制和升级边界，并声明局部可逆选择由 Worker 自主决定；`acceptance_criteria` 覆盖端到端行为和必要回归；`test_commands` 列适用入口。不列无必要的函数、命令或实现顺序。

`staged`：`objective` 只写当前阶段的一个可独立验收成果；`requirements` 写已冻结决定、前置输入、本阶段范围、后续非目标、可自主局部事项和必须提交 Master 的具体问题；`acceptance_criteria` 覆盖阶段成果、验证和交接证据；`context` 可用 `PROJECT DECISIONS`、`RELEVANT FILES`、`OPEN DECISIONS — DO NOT CHOOSE` 组织。当前阶段完成后停止。

只读调查在 `requirements` 写明“不创建、修改或删除任何文件”；若允许研究文档交付，则列出其写入范围并保护实现文件。重大未决项可以成为研究阶段的问题，不能是当前实施成立所必需却缺失的决定。
