# AGENTS.md

本仓库把 Codex 任务委派给本机 ZCode 执行。任何 agent 动手前先读本文件。

## 阅读顺序

1. `docs/README.md`：文档路由、状态等级和语言约定。
2. `docs/PROJECT_STATE.md`：当前发布状态、已验证范围和明确边界。
3. 按任务类型读权威文档：架构读 `docs/ARCHITECTURE.md`，接口读 `docs/INTERFACES.md`，宿主接入读 `docs/SHARED_CORE.md`，运行配置读 `docs/ZCODE_RUNTIME.md`。
4. 需要解释“为什么这样定”时读 `docs/decisions/`；`docs/archive/` 只在追溯历史时读。

## 架构与安全不变量

- 保持 Thin MCP 与独立 Executor 分离。MCP Host 断开不得取消已受理任务，也不得建立第二套任务 Authority。
- SQLite v14 是唯一生产 Authority。不要恢复旧 JSON Authority、SQLite v13 或第二套状态机。
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

`Last updated` 与 `Last verified` 必须分开；改过不等于核对过。研究材料放 `docs/research/`，一次性交付放 `docs/reports/`，草稿放已忽略的 `docs/_draft/`。研究、归档和发布记录不能冒充当前合同。

改变 `ARCHITECTURE`、`INTERFACES`、`SHARED_CORE` 或 `ZCODE_RUNTIME` 描述的行为前，先有 `DECISION` 记录。公共 MCP 工具名与 schema、任务状态语义、隐私边界和新增运行时依赖都属于合同变更。

`README.md` 使用英文；技术文档使用中文；`docs/README.md` 为双语索引。写结论时区分 `PASS`、`BLOCKED`、`NOT_RUN`、`UNKNOWN` 和 `UNVERIFIED`，不得把未执行写成通过。

## 变更与验证

- 开发期先跑 typecheck、受影响单元测试和关键生命周期 E2E，并在相关时验证 build/生成物。统一入口可使用 `npm run test:affected -- --development`；`FULL_SUITE_DEFERRED_TO_RELEASE_GATE` 不是测试通过。
- 完整 CI 在形成明确 Release Candidate、Owner 明确要求，或重大跨模块影响无法由定向验证界定时运行。发布候选由仓库治理配置和当次授权请求；候选内容变更后必须重新验证。
- 不得为省时间删除测试、增加跳过、放宽断言、降低预算或伪装定向范围。被延期的完整套件、平台矩阵和登记压力矩阵必须在报告中明确记录。
- 文档-only 变更至少运行 `npm run test:affected` 的 T0；`NO_TESTS_APPLICABLE` 不是 PASS。所有变更结束前检查 `git diff --check`；涉及 Markdown 时检查链接和 fence。
- `plugins/codex-zcode-bridge/dist/bridge.mjs`、`worker/worker-main.mjs`、插件 manifest 与 Schema 等生成/发布制品必须与源码同步；不得手工伪造 freshness。
- 不默认提交、推送、合并或发布。只有用户对当前目标的明确授权才允许这些操作；高风险发布步骤仍须按当次授权逐项报告真实结果。
- 结束时检查当前 Worktree 和 Git 变更，保留任务外 WIP、历史 Tag、Release、审计证据、`LICENSE` 和 `NOTICE`。
