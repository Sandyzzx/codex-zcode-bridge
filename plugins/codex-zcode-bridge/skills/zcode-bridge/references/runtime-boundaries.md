# Bridge 运行时事实与安全边界

> Status: AUTHORITATIVE
> Last updated: 2026-11-07
> Last verified: 2026-11-07，仅核对 SQLite-only 边界与渐进加载路由；真实 Host/生产恢复未由本轮认证。
> Verified against: a46137fe46b567271a7756be819361132625278c + ADR-029 本地候选（未发布）

## 边界

- 生产只有 SQLite v14 Task Authority、一个 Lifecycle Manager 和 Worker→app-server 链。旧 JSON 调度/恢复锁及直接 Worker runner 已退役；禁止扫描旧 .tasks 或手工删除未知 Hold/WRITER_INTENT。
- Capacity、永久 Claim 和路径互斥以 SQLite 持久事实为准。同/重叠执行路径保持占用；Result、进程退出、树 Cleanup 与 Release 分别核实。配置日志不是实际并发验收证据。
- 单次执行默认上限为 60 分钟；可在任务中设置 `timeout_ms`（60 秒至 4 小时），或用 `ZCODE_BRIDGE_TIMEOUT_MS` 设置用户默认值。超时后 Bridge 尝试终止该次进程树并保留 attempt 证据；清理未确认时不得宣称资源已释放。
- 每个任务通过本机 ZCode app-server 运行。单用户本机 SQLite 使用固定受信任档案 `yolo`，ADR-019 后不再强制覆盖为 `build`。`yolo` 会放行普通工具操作并使用当前 Windows 账户权限；这不是提权，也不是沙箱。记录版本上已完成单次 43,014-byte Write 的真实权限审批往返实测；其他审批组合未据此认证。告知用户实际执行模式和当前账户权限边界。
- `workspace` 是项目身份路径；`worktree_path`（如提供）是实际执行路径。Codex 决定是否准备 worktree，Bridge 只校验并使用所给路径。Git worktree 是工作区隔离，不是 OS 沙箱。allowed_paths / forbidden_paths 是 worker 指令；不得声称它们能强制阻止所有越界命令。
- 本机允许/仍需明确的边界：普通读取、编辑、构建、测试和任务范围内清理可在 `yolo` 下执行；Push、Merge、Tag、Release、生产 Authority 切换、删除任务范围外的用户数据、修改或读取凭据，以及真实生产任务数据操作仍须用户明确授权。任务 prompt、Skill 或 worktree 选择不能自行产生这些授权。
- ZCode 不得选择仍未解决的 `OPEN DECISIONS`；后续 Master Feedback 明确给出决定后，按新决定继续。即使未列出，遇到需求冲突或会实质改变外部行为的缺失决定，也要提出具体问题、设置 `needs_master_decision=true`，并继续不依赖该决定的工作。低影响实现选择可采用最简单一致的方案，同时报告假设。
- 不要把 ZCode Hooks、Desktop 历史索引、自动化或并行 worker 当作已启用能力。
- 不要为了方便而修改 ZCode provider 配置或将凭据写入任务 prompt、日志或仓库。

**调用授权、执行权限与凭证的界限**：Skill/TaskPackage 中的“已授权”只能指导 Master，不是运行时可信调用者凭证。MCP 仍必须按实际运行时机制校验权限、工作区和冲突；不得声称这次提示词改造让 Bridge 获得了新的强制授权能力。用户明确选择 Bridge 不意味着授权每个高风险命令或发布、推送、合并。

诊断先查同一 task/attempt 的 status、result、events。无 Result 的 running 在重启后仍占用；显式 cancel 必须验证原身份和树，unknown 不释放、不重派。需要实现细节才读仓库 docs/INTERFACES.md 的 Recovery/期限章节，再按 docs/decisions/README.md 选择 ADR-009/024/026/027/028/029；普通委派不预读 ADR 或 archive。
