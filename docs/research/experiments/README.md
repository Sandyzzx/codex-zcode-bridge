# 实验与证据复核

这些脚本为 2026-10-05 研究专用，不是生产 Executor。会调用真实模型并产生费用/配额用量；只有模型执行脚本需要授权账户配置。本次用户已授权 GLM-5.3-Flash。脚本内的固定 Windows 路径用于重现本机环境；迁移时先适配，不应直接指向真实项目执行 reset/clean。

## 证据

交付目录 `../evidence` 保存安全摘要：

| 文件 | 内容 |
|---|---|
| manifest.json | 版本、范围、完成与NOT RUN清单 |
| benchmark-observed.json | 10个成功运行：每run指标、真实task prompt及hash、候选diff、复核验收、规范事件 |
| benchmark-controlled-failed.json | Memory同时关闭的10次失败运行；完整usage未知、明确排除性能比较 |
| reasoning.json | low/high/max六次request body安全digest |
| policy.json | build权限拒绝/允许、Memory开启小探针 |
| handoff.json | A/B顺序续接，C只读发现/控制失败与危险resume NOT RUN |
| process-control.json | 两种实际ZCode执行器取消与自有工具helper存活检查 |
| job-object.json | 自有Node helper树的最终JobObject验证，不是ZCode集成 |
| smoke-isolated.json | 临时身份/config materialization后的顺序smoke |
| source-task-summary.json | 源码研究worker的会话选择与terminal usage |

临时完整allowlist ledger、fixture仓库、官方clone及session SQLite保留在 `C:/Users/Sandy/.codex/tmp/zcode-executor-audit-20261005`。原始model-I/O可能轮转，且含敏感headers/隐藏推理，**不复制入仓库、不以截图展示**；仅本次自有Session输出哈希、长度和usage。研究结束已移除临时配置、加密凭据副本和专用rollout中最后3个自有raw model-I/O文件；真实用户文件未改。

## 脚本职责

- `probe.mjs`：读取Bridge resolver的本机路径，在临时副本配置Flash/low，按官方cipher建立临时credential store；stdio RPC、事件白名单、Native stream-json与进程终止。
- `run-source.mjs`：独立research worktree中的真实源码审计worker。不能替代主审。
- `run-benchmark.mjs`：新建fixture，只在该专用Git仓库reset/clean；按5类任务交替执行器顺序。
- `review-benchmark.mjs`：不调用模型；重建候选diff/新文件并重新运行独立验收，生成指标。
- `run-handoff.mjs`：A/B顺序恢复，C运行中只读探针；不会做并发mutating resume。
- `run-reasoning.mjs`：相同无工具任务的三个effort档位配对。
- `run-policy.mjs`：build权限与Memory开启探针；仅本次指定文件的Write允许。
- `run-process-control.mjs`：执行本次自有60秒Node helper，分别验证taskkill与session/stop。
- `job-object.ps1`：P/Invoke helper树，kill-on-job-close，finally清理自有进程。
- `summarize-model-io.mjs`：精确Session ID读自有文件；仅输出安全digest，不输出headers/原始content。
- `export-evidence.mjs`：从已白名单ledger导出，移除敏感字段和高频streaming事件。

## 本机复核命令

先 `npm ci --ignore-scripts` 与 `npm run build:core`；确认resolver只读取正确本机安装与账户身份。官方clone必须固定到上述commit，路径为临时目录下 `official`，因为probe复用其credential cipher。目录 `.zcode/config.json` 使用正式项目配置发现规则。

```powershell
# 只重放已有观察组候选，不重新调用模型
node docs/research/experiments/review-benchmark.mjs

# 只重放失败补充组
$env:AUDIT_BENCHMARK_PHASE = 'controlled'
node docs/research/experiments/review-benchmark.mjs
Remove-Item Env:AUDIT_BENCHMARK_PHASE

# 导出白名单证据
node docs/research/experiments/export-evidence.mjs
```

重新执行 `run-benchmark.mjs` 会调用真实模型并覆盖同名临时ledger；应另建日期目录并保留旧证据。`AUDIT_ROOT` 只用于指向**已经准备好的专用审计目录**，不可指向项目根、用户Home或共享数据库。更换日期目录需复制/固定official clone并检查resolver配置。`AUDIT_BENCHMARK_PHASE=controlled` 新建 Memory-off fixture，而非更改真实用户配置。

独立验证的known limitations：只在Windows/Node24、安装版0.16.9、一个账户、一次样本上运行；T2是mutation testing，其余为复合断言脚本；Reviewer质量分非盲评。成功组Memory混杂，补充组网络失败。字段null表示未知，不表示0。
