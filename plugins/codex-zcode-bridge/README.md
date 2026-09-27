# Codex ZCode Bridge 插件

此插件通过本机 stdio MCP 服务把有边界的开发任务交给 ZCode，并提供 `delegate-zcode` 工作流 Skill。

## 本机配置

`.mcp.json` 由仓库脚本生成且被 Git 忽略。先在 Bridge 仓库运行 `npm ci`、`npm run build`，再设置本机 provider 配置文件路径，并显式设置 `ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION=1` 后运行 `npm run plugin:configure`。脚本只保存路径，不读取、复制或修改配置内容。

若不设置 provider 路径，Bridge 会尝试运行时默认发现规则。不同 ZCode 安装的数据目录可能不同。

## 使用边界

- 任务通过 Git worktree 隔离，任务完成后由 Codex 检查实际 diff 和验收结果。
- 模型可按 provider/model ID 选择；模型要求思考档位时，要提供 runtime 支持的 `reasoning_level`。
- `completed` 只表示任务执行与结果规范化完成，不表示 Codex 已接受改动。
- Bridge 当前固定使用 ZCode `yolo` 模式，不是操作系统沙箱；ZCode 仍以当前用户权限运行。授权前应检查工作区和任务内容。
- 常见凭据路径会从 Git snapshot 排除，但这不是完整 secret scanner。`allowed_paths` / `forbidden_paths` 是提示约束，不是强制访问控制。
- ZCode app-server 是本机运行时接口，随 ZCode 版本变化；升级后应重新执行验证。
