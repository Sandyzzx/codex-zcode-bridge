# AGENTS.md

本仓库把 Codex 的任务派发给本机 ZCode 执行。任何 agent 动手前先读这份文件。

## 阅读顺序

1. `docs/README.md` —— 文档路由、状态等级、语言约定。
2. `docs/PROJECT_STATE.md` —— 当前状态快照：稳定、实验、不支持、调查中。
3. 按任务类型读权威文档：架构改动读 `docs/ARCHITECTURE.md`，接口改动读 `docs/INTERFACES.md`，宿主接入读 `docs/SHARED_CORE.md`，运行配置读 `docs/ZCODE_RUNTIME.md`。
4. 需要知道"为什么这样定"时读 `docs/decisions/`。
5. `docs/archive/` 默认不读，只有调查历史决策时才读。

## 文档等级

每份文档顶部标注四种状态之一：`AUTHORITATIVE` 当前事实或合同、`DECISION` 已批准决策、`RESEARCH` 研究结论、`ARCHIVED` 历史材料。研究结论和归档材料不能当作当前实现使用。

权威文档的顶部至少包含：

```markdown
> Status: AUTHORITATIVE
> Last updated: YYYY-MM-DD
> Last verified: YYYY-MM-DD（核对了哪几条；只核对了一部分就写明范围）
> Verified against: <commit SHA>
```

`Last updated` 和 `Last verified` 是两件事：改过不等于核对过。`Verified against` 记录核对时代码停在哪个提交，指码已经前进很多时应当重新核对。索引汇总在 `docs/README.md`，但不能代替文档自身的标注。

## 硬规则

- 改变 `docs/ARCHITECTURE.md`、`docs/INTERFACES.md`、`docs/SHARED_CORE.md`、`docs/ZCODE_RUNTIME.md` 描述的行为前，先有 `DECISION` 记录。实现不能反向改写合同。
- 公共 MCP 工具名与 schema、任务状态语义、隐私边界、新增运行时依赖，都属于合同变更。
- 研究材料放 `docs/research/`，草稿放 `docs/_draft/`（已忽略）。不要把未定稿留在 `docs/` 顶层。
- 语言：`README.md` 英文，技术文档中文，`docs/README.md` 双语索引。
- 核心权威文档控制在 10 份以内。单份超过约 15 KB，或同一主题被三个以上独立读者分读，才拆成多份。
- 写结论时区分"已核实"和"未运行"。不要把 NOT RUN 写成通过，也不要把尝试过的方法写成可行方法。
- 引用 ZCode 内部结构时标明观测版本，用 Observed 措辞，不要写成官方合同。

## 分支流程

- `master` 和 `preview` 是仅有的长期分支。`master` 保持稳定发布状态；`preview` 是唯一集成分支。
- 功能开发从最新 `origin/preview` 创建临时 `codex/<topic>-<date>` 分支，在独立 Worktree 中执行，PR Base 必须是 `preview`。
- 功能 PR 合并后删除对应临时分支和 Worktree；不把功能分支作为长期分支保留。
- `preview` 完成验收后，通过 `preview` 到 `master` 的 PR 合并到稳定线；随后将 `preview` 快进到 `master`，或在分支保护不允许快进时创建 `master` 到 `preview` 的同步 PR。
- 稳定线紧急修复可以从 `master` 创建临时分支；修复进入 `master` 后必须同步回 `preview`，避免两条长期分支分叉。

## 提交与验证

- 日常开发先跑 `npm run test:affected`；它始终包含 typecheck、build、plugin validation 和 `git diff --check`，并按影响映射选择测试。只有结果实际命中压力测试边界才运行该压力测试；报告中必须显式区分已运行压力测试与 `STRESS_TESTS_NOT_APPLICABLE`。
- R4、发布候选冻结、SQLite/生产架构切换或测试执行器重大变更跑 `npm run test:full`。CI 保留完整 `npm test`。不得为缩短时间删除测试、增加 SKIP、修改断言或降低预算。
- `npm test` 仍是完整隔离回归入口。文档-only 变更至少跑 `npm run test:affected` 的 T0 部分；其 `NO_TESTS_APPLICABLE` 不是测试 PASS。
- `plugins/codex-zcode-bridge/dist/bridge.mjs` 与 `worker/worker-main.mjs` 是提交物，必须与源码同步；CI 会校验它们没有落后。
- 不默认提交、推送或发布。发布走 release-please，合并到 `master` 之后由它生成版本 PR。
