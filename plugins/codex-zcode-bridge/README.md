# Codex ZCode Bridge 插件

此插件通过本机 stdio MCP 服务把有边界的开发任务交给 ZCode，并提供 `delegate-zcode` 工作流 Skill。

## 安装

插件包包含 MCP 服务、detached worker 和本地 MCP 启动配置，安装时不需要单独克隆 Bridge 仓库或运行依赖安装。首次使用前，必须安装 Node.js 和 ZCode，并显式启用 `ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION=1` 后重启 Codex。Marketplace 不会替用户授权执行。

Bridge 默认发现常见 ZCode 安装与 provider 位置。自定义安装需要通过操作系统用户环境变量设置 runtime/provider 文件路径。

## 使用边界

- 任务通过 Git worktree 隔离，任务完成后由 Codex 检查实际 diff 和验收结果。
- 模型可按 provider/model ID 选择；模型要求思考档位时，要提供 runtime 支持的 `reasoning_level`。
- `completed` 只表示任务执行与结果规范化完成，不表示 Codex 已接受改动。
- Bridge 当前固定使用 ZCode `yolo` 模式，不是操作系统沙箱；ZCode 仍以当前用户权限运行。授权前应检查工作区和任务内容。
- `.tasks` 和 worktree 数据保存在用户目录下 `.codex/codex-zcode-bridge`，不会随插件缓存版本更新而删除。
- 常见凭据路径会从 Git snapshot 排除，但这不是完整 secret scanner。`allowed_paths` / `forbidden_paths` 是提示约束，不是强制访问控制。
- ZCode app-server 是本机运行时接口，随 ZCode 版本变化；升级后应重新执行验证。
