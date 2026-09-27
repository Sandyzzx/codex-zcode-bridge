# MVP 0.3：模型选择与隔离工作区

日期：2026-09-27

本文记录在 V0.1 冻结接口之上的增量版本。V0.1 文件仍作为历史契约保留；MVP 0.3 的实际工具输入以当前 MCP schema 为准。

## 目标

Codex 能把有边界的开发任务交给本机 ZCode，选择本次任务使用的模型，在 Codex 中查看进度和结果，并审查隔离工作区中的改动。Codex 决定是否把审查通过的改动应用到用户工作区。

## V0.1 上的增量

TaskPackage 增加可选字段：

    model?: {
      provider_id: string;
      model_id: string;
      reasoning_level?: string;
    };

- 省略 model：保留 ZCode session 默认模型。
- 设置 model：先检查新 session 快照。如果所选 provider/model 已经是当前模型，就保留 ZCode 当前有效选项；否则调用本机 ZCode session/setModel 并核对返回快照中的 providerId / modelId。ZCode 明确要求档位的模型需额外提供 reasoning_level，并映射为原生 options.reasoningLevel。
- persistAsWorkspaceLastUsed 设置为 false：模型覆盖只作用于这个 session，不修改项目默认模型。
- 选择结果通过 model_selected 事件持久化；session 快照另记录 runtime 报告的模型信息。
- 目前不提供模型目录查询。Codex 可使用用户指定的 provider/model 标识；需要 reasoning_level 的模型应提供该字段。运行时不接受或无法确认选择时，任务失败，不静默回退。

zcode_task 的 workspace 现在表示 Git repository 中的输入目录。实际执行采用：

1. 解析到 Git 仓库根目录。
2. 用临时 Git index 将 HEAD、已跟踪改动和未忽略的新文件组成任务基线快照。原仓库的 index 和文件不被修改。
3. 在 data-root/.tasks/workspaces/task_id 建立 codex-zcode/task_id worktree。
4. 将 source path、execution path、branch 和模式写入 workspace.json 并发出 workspace_ready 事件。
5. 任务续作复用同一 worktree。任务结束后保留 worktree，供 Codex 检查和应用改动；Bridge 不自动合并、提交或删除它。

非 Git 目录、错误 task ID、已有冲突 worktree 或无效 Git 状态都会在启动 worker 前失败。被 .gitignore 忽略的文件不会纳入任务快照。Git worktree 隔离常见意外写入，但不是 OS 沙箱，也不能阻止命令访问仓库外路径。

## Codex 插件闭环

本仓库的 plugins/codex-zcode-bridge 提供 Master 工作流 Skill 和本地 stdio MCP 配置。Codex 按此顺序工作：

1. 将用户已授权的开发目标、验收条件和适用测试整理为 TaskPackage。
2. 用户指定模型时传入 model；否则省略并使用 ZCode 默认值。
3. 调用 zcode_task 后读取 zcode_events，记录 workspace_ready 中的执行目录和分支。
4. 等待任务终态，再调用 zcode_result；从事件中确认实际模型和执行证据。
5. 检查实际 worktree diff，独立运行验收。仅将审查通过且仍符合用户授权范围的改动应用到原工作区。
6. 如有失败项，使用 zcode_continue 在同 session / 同 worktree 续作；不符合要求时取消或停止。

模型报告、AgentReport 和 completed 都不代表代码审查通过。

## 版本与验证

- MCP server/package 版本：0.3.0。
- app-server 模型设置路径已对照本机安装包确认，并通过 fake app-server 回归测试；真实 E2E 已用本机 `deepseek-flash` 完成任务并核对模型事件。此次请求的 provider/model 与 session 默认选择相同，所以沿用该 session 的有效 reasoning 选项；对其他模型的 reasoning_level 值尚未逐模型实测。
- Workspace 快照与 Git worktree 生命周期由临时 Git 仓库测试覆盖。
- app-server 是 ZCode 原生运行时入口，但仍属于随 ZCode 版本变化的本机协议；升级后须重跑模型选择、worktree、事件和续作验证。

## MVP 不包含

ZCode companion 插件、Hooks 审批、权限模式选择、模型目录 UI、ZCode Desktop 历史索引、自动化、并行 worker、自动合并和 OS 级沙箱。这些都不阻止上述单任务闭环。
