---
name: delegate-zcode
description: 通过 Codex ZCode Bridge 把已授权的开发任务交给本机 ZCode，跟进实时进度、选择模型、审查隔离 worktree，并决定如何接收改动。
---

# Codex → ZCode 委派工作流

你是 Master，ZCode 是执行一个有明确边界任务的 worker。仅委派用户已授权的实现工作。保持单任务串行，不与 ZCode 同时修改同一个源工作区。

## 派发

1. 确认当前项目的 Git 仓库根目录，并把该目录作为 zcode_task 的 workspace。Bridge 会把该仓库当前已跟踪改动及未忽略的新文件快照到一个隔离 worktree；任务不在源工作区运行。
2. 把目标拆成简洁的 objective、requirements、allowed_paths、forbidden_paths、acceptance_criteria 和 test_commands。不要把验收责任交给 ZCode。
3. 用户指定 ZCode 模型时，传入 model: { provider_id, model_id }。只使用用户给出的或已从 ZCode runtime 明确确认的标识；不能确认时向用户说明模型标识未知。若该模型明确要求思考档位，再传入 reasoning_level；不要猜可用档位。用户未指定时省略 model，保留 ZCode session 默认模型。
4. 调用 zcode_task。MCP 报错时先解释和解决具体配置问题，不要重复提交相同 task_id。

## 跟进

1. 首次调用 zcode_events，取得 workspace_ready 事件中的 source_path、workspace_path 和 branch_name，并记住 workspace_path。ZCode 的实际改动位于该隔离 worktree。
2. 运行期间用 zcode_events 的 after_seq 读取增量事件，wait_ms 可设为 10000–25000；如需快速刷新状态，可调用 zcode_status。不要忙轮询。
3. 用简短进度告诉用户当前状态、模型（有报告时）、模型可见输出和工具活动摘要。事件不包含隐藏推理或原始工具参数。
4. 任务终态后调用 zcode_result。completed 仅表示 Bridge/ZCode 执行和报告规范化完成，不代表代码审查通过。

## 审查与接收改动

1. 在 workspace_path 检查 Git 状态、完整 diff、实际文件和测试。对照用户目标、允许/禁止路径和验收标准逐项核实。
2. 不能仅相信 AgentReport.files_changed、ZCode 报告的测试状态或模型输出；独立运行适用的验收命令。
3. 在审查通过后，将需要的改动应用到 source_path。先保留源工作区已有的用户改动，检查是否存在冲突；应用后在源工作区复查 diff 并运行验收。
4. Bridge 不会自动合并或删除 worktree。不要在审查及应用完成前删除 workspace_path，也不要自动提交、推送或创建 PR。
5. 如果结果未达标，调用 zcode_continue，反馈具体失败证据；续作会复用相同 ZCode session 和 worktree。任务运行期间若用户取消，调用 zcode_cancel 并确认终态。

## 边界

- Bridge 目前一个时刻只运行一个 worker。
- Git worktree 是工作区隔离，不是 OS 沙箱。allowed_paths / forbidden_paths 是 worker 指令；不得声称它们能强制阻止所有越界命令。
- 不要把 ZCode Hooks、Desktop 历史索引、自动化或并行 worker 当作已启用能力。
- 不要为了方便而修改 ZCode provider 配置或将凭据写入任务 prompt、日志或仓库。
