# AGENTS.md

本仓库维护已发布的 Codex ZCode Bridge Stable `2.0.0`。稳定维护阶段不新增功能、不升级依赖，也不执行真实模型任务，除非用户对当前目标明确授权。

## 阅读顺序

1. `docs/README.md`：当前文档路由和状态约定。
2. `docs/PROJECT_STATE.md`：Stable 2.0.0 的发布事实、验收范围和已知限制。
3. 按任务读取权威文档：架构、接口、宿主接入、运行配置、Web Console 和测试维护分别见 `docs/ARCHITECTURE.md`、`docs/INTERFACES.md`、`docs/SHARED_CORE.md`、`docs/ZCODE_RUNTIME.md`、`docs/WEB_CONSOLE.md` 和 `docs/testing/README.md`。
4. 历史事实只从 Git Commit、Tag 和 GitHub Release 追溯；`docs/reports/`、`docs/archive/`、研究正文和 ADR 正文不再保留。`docs/decisions/README.md` 与 `docs/research/master-skill-simplification-20261111.md` 仅为生产 Skill 的兼容路由。

## 产品与安全不变量

- 保持 Thin MCP 与独立 Executor 分离。MCP Host 断开不得取消已受理任务，也不得建立第二套任务 Authority。
- SQLite v14 是唯一生产 Authority。不得恢复旧 JSON Authority、SQLite v13 或第二套状态机。
- Worker 通过已安装的官方 ZCode AppServer 执行；模型目录和 Registry 按官方运行期发现，不维护 Bridge 自有的模型白名单或 Registry 下载服务。
- 保留 Coding Plan / Start Plan 路由、`-StartPlan` 后缀、任务 Continue 与 Session Resume 分离；用户指定的 Provider、Model 和 Reasoning 不得被静默改写。
- 保留 Auto Wake、Owner Binding、Master 独立验收与验收驱动返工。Queue ACK、Turn 启动、Master 接受和资源清理是不同事实，不得互相冒充。
- 保留 Task Workspace、结构化 Diagnostics、有界脱敏 RPC 错误、Cleanup/Release 证明与用户授权清理门槛。未知或存活状态必须 fail closed。
- ZCode 使用当前 OS 账户权限运行；Task 路径、`allowed_paths` / `forbidden_paths`、Worktree 和 `yolo` 模式都不是安全沙箱。
- 当前项目根目录以 `pwd` / `git rev-parse --show-toplevel` 为准。持久化产物必须留在项目内；项目外持久写入须先取得用户批准，不得通过扩大权限或关闭沙盒绕过限制。
- 根目录 `AGENTS.md` 只约束仓库开发治理；生产插件的 Master Skill 及其 references 是另一份运行合同，未经明确授权不得改动。

## 文档治理

权威文档顶部至少包含：

```markdown
> Status: AUTHORITATIVE
> Last updated: YYYY-MM-DD
> Last verified: YYYY-MM-DD（核对范围）
> Verified against: <commit SHA 或明确基线>
```

`Last updated` 与 `Last verified` 必须分开；改过不等于核对过。当前合同只写入上述权威文档；不新增过程性报告、研究、归档或 ADR 正文。历史证据通过 Git 和 GitHub Release 链接追溯，不复制到仓库。

改变 `ARCHITECTURE`、`INTERFACES`、`SHARED_CORE` 或 `ZCODE_RUNTIME` 描述的行为前，必须有明确变更授权和对应验证。公共 MCP 工具名与 schema、任务状态语义、隐私边界和新增运行时依赖都属于合同变更。

`README.md` 使用英文；技术文档使用中文；`docs/README.md` 为双语索引。结论必须区分 `PASS`、`BLOCKED`、`NOT_RUN`、`UNKNOWN`、`UNVERIFIED`，不得把未执行写成通过。

## 变更与验证

- 文档变更至少运行 `npm run test:affected` 的 T0，并检查 Markdown 链接和 fence；所有变更结束前运行 `git diff --check`。
- 源码或生成制品变更才运行对应定向测试；不得删除测试、增加跳过、放宽断言或伪装定向范围。
- `plugins/codex-zcode-bridge/dist/bridge.mjs`、`worker/worker-main.mjs`、插件 manifest 与 Schema 等生成/发布制品必须与源码同步；不得手工伪造 freshness。
- 不默认提交、推送、合并或发布。只有用户对当前目标的明确授权才允许这些操作；高风险步骤须逐项报告真实结果。
- 结束时检查 Worktree 和 Git 变更，保留任务外 WIP、历史 Tag、Release、审计证据、`LICENSE` 和 `NOTICE`。
