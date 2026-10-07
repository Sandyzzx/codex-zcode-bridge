# Native CLI vs app-server 研究（2026-10-05）

> Status: RESEARCH
> Date: 2026-10-05
> 研究结论，不代表当前实现。观测版本 ZCode CLI 0.16.9；官方源码提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。

本目录是一次完整研究的交付物：6 篇文档、实验脚本、以及证据索引。原始 ledger 不进入仓库，归档位置与 SHA-256 见 [evidence/manifest.json](evidence/manifest.json)。

## 结论摘要

- Executor 架构方向：**GO WITH CONDITIONS**。引入 NativeCliExecutor 候选、保留 AppServerExecutor、建立统一 Run Ledger 与顺序 Handoff 的方向合理；但没有足够证据把 Native 切成默认 Coding Executor，生产默认继续 app-server。
- 跨 Host 并发 attach/control：**NO-GO**，除非上游提供明确的 ownership/control 协议或另行证明安全。
- Session handoff：双向顺序恢复可行；"全部 Runtime 状态无损"未证明。

## 文档

| 文档 | 内容 |
|---|---|
| [ZCODE_CLI_VS_APPSERVER.md](ZCODE_CLI_VS_APPSERVER.md) | 总报告：两条执行路径的深度审计 |
| [ZCODE_RUNTIME_CALLCHAIN.md](ZCODE_RUNTIME_CALLCHAIN.md) | 官方源码调用链 |
| [ZCODE_EXECUTOR_ARCHITECTURE_RECOMMENDATION.md](ZCODE_EXECUTOR_ARCHITECTURE_RECOMMENDATION.md) | Executor 架构建议与决策门槛 |
| [ZCODE_EXECUTOR_BENCHMARK.md](ZCODE_EXECUTOR_BENCHMARK.md) | 基准与成本审计 |
| [ZCODE_SESSION_HANDOFF.md](ZCODE_SESSION_HANDOFF.md) | Session handoff 审计 |
| [VALIDATION.md](VALIDATION.md) | 交付验证记录 |
| [experiments/README.md](experiments/README.md) | 实验脚本职责与证据文件清单 |

## 适用范围

结论只适用于记录的版本和实验范围，不构成对其他安装版本的保证。文中标注 NOT RUN 的部分保持未验证。
