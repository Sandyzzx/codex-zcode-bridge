---
name: delegate-zcode
description: 通过 Codex ZCode Bridge 把已授权的开发任务交给本机 ZCode，跟进实时进度、选择模型、按需要由 Codex 准备 worktree、审查改动并决定如何接收。
---

# Codex → ZCode 委派工作流

你是 Master，ZCode 是执行一个有明确边界任务的 worker。仅委派用户已授权的实现工作。保持单任务串行，不与 ZCode 同时修改同一个源工作区。

## 持续目标

- 用户明确要求跨轮持续推进，例如“持续做到项目完成或我让你停止”时，把它视为当前 Codex 线程的长期目标；在派发首个 ZCode 任务前调用 `create_goal`，不要只在普通回复里复述持续意图。目标写明用户授权的最终结果、独立审查/验证要求、接收改动的条件，以及用户叫停或必须等待用户决定时的停止条件。不得借此扩大用户授权；除非用户明确指定，不设置 Goal token budget。
- 单次、有明确边界的委派或一次性问答不创建 Goal。若当前环境没有 Goal 工具，明确告知用户无法启用持久续行，不要声称已经创建。
- Goal 属于当前线程。保持它活动，直到最终目标经证据核验完成；Bridge 的 `completed`、ZCode 的完成报告或“任务仍在运行”都不单独满足完成条件。只有所有必要任务终态、改动完成独立审查和适用验证、授权范围内的改动已接收到目标工作区，才可完成 Goal。
- 若 Codex 当前轮结束时 Bridge 任务仍在运行，保留活动 Goal 并说明当前状态，让 Goal 在可继续时接手轮询；不要把中间状态作为最终结论或自行暂停 Goal。用户要求停止时遵从其指示。

## 派发

1. 确认 Codex 项目根目录，并始终把它作为 zcode_task 的 `workspace`。根据 Codex 对任务的执行指示决定是否需要 worktree；需要时由 Codex 创建并准备，再把其现存绝对路径作为 `worktree_path`。Bridge 不创建、选择或删除 worktree；未提供该字段时任务直接在项目根目录执行。
2. 将 objective、requirements、allowed_paths、forbidden_paths、acceptance_criteria 和 test_commands 写具体，路径约束只是任务指令，不是强制沙箱。只在任务需要时传入精简的 `context`，按 `PROJECT DECISIONS`、`CONSTRAINTS`、`RELEVANT FILES`、`OPEN DECISIONS — DO NOT CHOOSE` 组织；不要复制整段 Codex 对话。没有未决事项时省略该小节。不要把验收责任交给 ZCode。
3. 用户指定 ZCode 模型时，传入 model: { provider_id, model_id }。只使用用户给出的或已从 ZCode runtime 明确确认的标识；不能确认时向用户说明模型标识未知。若该模型明确要求思考档位，再传入 reasoning_level；不要猜可用档位。用户未指定时省略 model，保留 ZCode session 默认模型。
4. 调用 zcode_task。MCP 报错时先解释和解决具体配置问题，不要重复提交相同 task_id。

## 跟进

1. `zcode_task` 返回后立即调用 `zcode_events`（`after_seq: 0`），不要先做别的工作或只复述 queued receipt。先报告 `workspace_ready` 中的 `project_path`、`execution_path`（如有则说明 Codex 准备的 worktree）和 queued/running 状态。按 `next_seq` 和 `wait_ms` 继续读取，直到出现 `turn_started`、明确启动失败或终态；不要忙轮询。
2. 在 `turn_started` 后、等待模型输出前，先向用户报告：Codex 项目根目录、实际执行目录、ZCode session ID、runtime 实际报告的 provider/model 和执行模式。模式来自 Bridge 配置，默认 `yolo`。若使用 worktree，说明它不是 OS 沙箱。模型字段缺失时明确说 runtime 没有报告；不要把用户请求的模型或项目默认值猜成实际已选模型。
3. 如果在 `turn_started` 前失败，立即报告 Bridge 的启动错误；只有在 `session_ready` 已出现时才能声称 ZCode session 已创建。不存在 `session_ready` 时说明没有 ZCode session/model 元数据。
4. 运行期间用 `zcode_events` 的 `after_seq` 读取增量事件，`wait_ms` 可设为 10000–25000；如需快速刷新状态，可调用 `zcode_status`。向用户简短汇报模型可见输出和工具活动摘要。事件不包含隐藏推理或原始工具参数。
5. 任务终态后调用 `zcode_result`。completed 仅表示 Bridge/ZCode 执行和报告规范化完成，不代表代码审查通过。

## 审查与接收改动

1. 在事件报告的实际执行目录检查 Git 状态、完整 diff、实际文件和测试。对照用户目标、允许/禁止路径和验收标准逐项核实。
2. 不能仅相信 AgentReport.files_changed、ZCode 报告的测试状态或模型输出；独立运行适用的验收命令。
3. 若执行目录是 worktree，在审查通过后由 Codex 按用户授权把所需改动接收到项目工作区；先保留项目中已有的用户改动、检查冲突，再复查并运行验收。若直接在项目根目录执行，则在同一目录审查。
4. Bridge 不会自动应用、合并或删除 worktree。不要在审查及接收改动前删除 Codex 准备的 worktree，也不要自动提交、推送或创建 PR。
5. 如果结果未达标，调用 zcode_continue，反馈具体失败证据；续作会复用同一 ZCode session 和原执行目录。任务运行期间若用户取消，调用 zcode_cancel 并确认终态。

## 边界

- Bridge 目前一个时刻只运行一个 worker。
- 每个任务通过本机 ZCode app-server 运行；默认模式为 `yolo`，也可通过 `ZCODE_BRIDGE_MODE` 配置。告知用户实际执行模式和当前账户权限边界，不要把 worktree 描述成沙箱。
- `workspace` 是项目身份路径；`worktree_path`（如提供）是实际执行路径。Codex 决定是否准备 worktree，Bridge 只校验并使用所给路径。Git worktree 是工作区隔离，不是 OS 沙箱。allowed_paths / forbidden_paths 是 worker 指令；不得声称它们能强制阻止所有越界命令。
- ZCode 不得选择仍未解决的 `OPEN DECISIONS`；后续 Master Feedback 明确给出决定后，按新决定继续。即使未列出，遇到需求冲突或会实质改变外部行为的缺失决定，也要提出具体问题、设置 `needs_master_decision=true`，并继续不依赖该决定的工作。低影响实现选择可采用最简单一致的方案，同时报告假设。
- 不要把 ZCode Hooks、Desktop 历史索引、自动化或并行 worker 当作已启用能力。
- 不要为了方便而修改 ZCode provider 配置或将凭据写入任务 prompt、日志或仓库。
