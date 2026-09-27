# Codex ZCode Bridge 插件

此插件通过本机 stdio MCP 服务把有边界的开发任务交给 ZCode，并提供 `delegate-zcode` 工作流 Skill。

## 安装

插件包包含 MCP 服务、detached worker 和本地 MCP 启动配置，安装时不需要单独克隆 Bridge 仓库或运行依赖安装。使用前需要安装 Node.js 和 ZCode。每个任务默认通过 ZCode app-server 以 `yolo` 模式运行，并继承当前用户权限；Git worktree 与 allowed/forbidden path 指令不是 OS 沙箱。`workspace` 始终是 Codex 项目根目录及 ZCode Desktop 项目归属。是否建立 worktree 由 Codex agent 根据任务指示决定；如有 worktree，Codex 将其现存路径通过 `worktree_path` 传给 Bridge。Bridge 不创建、选择或删除 worktree，并在开始工作前报告项目路径、实际执行路径、session ID、runtime 报告的模型和执行模式。

Bridge 默认发现常见 ZCode 安装与 provider 位置。自定义安装需要通过操作系统用户环境变量设置 runtime/provider 文件路径。

## 使用边界

- 未传 `worktree_path` 时任务直接在 `workspace` 执行；传入时任务在 Codex 选择的 worktree 执行。任务完成后由 Codex 检查实际 diff 和验收结果。
- 模型可按 provider/model ID 选择；模型要求思考档位时，要提供 runtime 支持的 `reasoning_level`。
- 首条任务 prompt 以 `TASK ID` 开头，由 ZCode 根据 prompt 自动生成 session 标题；Bridge 不另行调用重命名命令。
- `completed` 只表示任务执行与结果规范化完成，不表示 Codex 已接受改动。
- Bridge 当前固定使用 ZCode `yolo` 模式，不是操作系统沙箱；ZCode 仍以当前用户权限运行。`allowed_paths` 和 `forbidden_paths` 是任务指令，不是强制访问控制。当前 Bridge 尚未验证向 Codex 转发逐项审批的安全执行模式。
- Bridge 仅将运行状态、日志、事件和结果保存在用户目录下 `.codex/codex-zcode-bridge`；worktree 生命周期由 Codex 管理。
- Bridge 不创建 Git snapshot，也不筛除项目文件；派发前应检查任务可见的工作区内容。
- ZCode app-server 是本机运行时接口，随 ZCode 版本变化；升级后应重新执行验证。
