# 交付验证记录

> Status: RESEARCH
> Date: 2026-10-05
> 本次研究的交付验证记录。索引见 [README.md](README.md)。

2026-10-05，本次工作区基线 `2596759198fa826c2b7ac0478c5682da996e9727`。

| 检查 | 结果与范围 |
|---|---|
| `npm ci --ignore-scripts` | 本次成功，用于准备已有Bridge core模块；未修改package/lockfile |
| `npm run build:core` | 本次成功；不等于全项目测试验收 |
| 成功组候选独立重放 | 10/10 artifact、scope、functional acceptance通过；T2两组10单测及3/3 mutation kills |
| 失败组候选独立重放 | 10次执行均未成功终态；T1-N留下修改可通过验收；其余不满足task artifact要求；全部排除性能统计 |
| `.mjs` syntax | 实验脚本逐个 `node --check` 通过 |
| `verify-artifacts.mjs` | 必需5份文档；46个固定源码/本地链接存在及line anchor范围；10成功/10失败ledger、配对promptHash/commit/cwd、全部要求指标字段；敏感对象key白名单检查通过 |
| `git diff --check` | 本次通过 |
| 实际ZCode取消 | Native force tree kill、app-server stop及EOF退出成功；范围仅本次自有helper树 |
| Windows JobObject | 最终自有Node helper树验证成功；实际ZCode集成NOT RUN |
| 全项目 `npm test` / `typecheck` | NOT RUN：本次没有修改生产源码、公共合同或package配置；不引用历史测试冒充本次结果 |
| 默认Executor /发布 | 未更改默认；未提交/推送/创建PR/发布 |
| 临时敏感文件清理 | 已移除专用private-runtime中的credential/provider副本及最后3个自有raw model-I/O文件；保留专用SQLite、fixtures和安全ledger |

仅 `.gitignore` 增加 `docs/research` 保留规则，其余变化在研究目录。没有修改真实Provider配置、用户Session数据库、任务索引、生产Executor或其他工作树。研究期间只在本次新建fixture执行Git reset/clean。

源码worker独立输出位于临时source-review worktree，主审已检查其文档、固定源码与真实探针；没有直接把worker的“无所有权锁”等绝对表述当定论。最终保留absence evidence为SUPPORTED、危险resume为NOT RUN。

已知未解决项在总报告、Benchmark和Recommendation明确列出，尤其是严格配置对齐后的成功编码比较受网络故障影响；不把失败组当质量测量。研究产物可review，尚不构成生产架构实施验收。
