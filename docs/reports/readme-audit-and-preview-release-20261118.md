# README、Cost Lab 审计与 Preview.9 发布验收

> Status: RESEARCH
> Last updated: 2026-11-18

## 基线与产品说明

- Preview.8 基线为 `02cf2fa92c8235370fe7a883d4c5b30d93a8ab33`。集成提交 `20da3ca6e77220ec39ce6a47a49d7fb10c34a9b4` 是账单修复 `b4273b5ff8944edb294cb288b94d45f3180b4ee3` 的直接父提交。账单修复的 Tree 为 `b9be79c612e6dfc1455abe07b63fa8bf3c883809`。
- 英文和中文首页将实现细节移至技术文档，保留持久化委派、官方 ZCode Runtime、两类套餐、已验证的 Coding Plan 积分倍率及 Cost Lab 本地入口。Preview Marketplace 使用 `--ref preview`，Stable 安装引用指向 `codex-zcode-bridge-v1.7.2`。
- Coding Plan 的额外倍率仅适用于已对账的个人套餐、模型和 Runtime 配置。Start Plan 使用独立认证、模型权益门禁和任务级 Private Lease。Windows 历史真实证据仍有效，Desktop `3.18.2.10443` 的 Start Plan 实时 E2E 为 `NOT_RUN`，当前 AppServer 研究范围为离线兼容性。

## 生产执行和官方积分

Coding Plan 选择通过 ADR-040 Manifest 校验的安装版官方 AppServer。现有 Official Host 认证、ProcessManager 和 SQLite Attempt/Cleanup/Release 合同继续负责执行和生命周期。Start Plan 沿用独立路径。实现及早期真实实验见 [集成报告](official-runtime-integration-costlab-web-startplan-20261118.md)。

2026-11-18 21:06（Asia/Shanghai）执行了一次候选 Coding Plan 真实任务。`GLM-5.3-Flash`、`low`，任务完成且持久 Release 已观察。21:05:41 的 before 和 21:17:28 的只读 after 位于同一日期及小时，Usage 观察时间为 21:06:19。账单分别匹配未缓存输入 22,905、缓存输入 0、输出 82，共 22,987 Token。

| 官方积分 | 正常理论积分 | 0.67 理论积分 | 实际额外倍率 |
| --- | --- | --- | --- |
| 1.7868 | 2.666875 | 1.78680625 | 0.6699976564 |

Web 初次轮询在官方结算前结束，后续只读快照完成对账。模型 HTTP 请求数仍为未知。真实执行早于本轮任务级 Runtime 诊断标记，诊断链以定向测试验收。模型调用量为一次真实 Coding Plan 任务，Start Plan 实时任务为零。原始快照保存在实验工作树的忽略目录，公开报告仅保留分类汇总。

## 独立审计与整改

独立审计覆盖 `origin/preview` 至候选的完整差异，包含 `20da3ca..b4273b5`。审计检查了官方 Bundle 选择、Worker 和 Host 的运行链、Start Plan 边界、账单语义、历史导出、README 与 Marketplace。冻结候选 `502045b2` 的审计通过 `codex/gpt-6.2-astra` 选项调度，审计者可见元数据仅能确认模型家族。

| 优先级 | 审计发现 | 整改 |
| --- | --- | --- |
| P1 | 预检 Bundle 摘要可被提升为任务级执行证据 | 要求建立成功的 Worker 官方客户端证据与 Task、Attempt、Bundle 摘要一致 |
| P1 | 旧历史可能使用展示补零确认优惠 | 对账只采用原始分类序列，按当前算法重新评估旧历史 |
| P2 | 派发后异常会保留初始零次请求 | 进入 `MODEL_REQUESTED` 后保留未知次数，取得证据后填入 |
| P1 | 对账可接受错误日期的小时标签及观察窗口外的 Usage | 保留小时标签日期约束，并核对已知 Usage 时间位于 before/after 之间 |
| P1 | 活动任务清理超时后 CLI 仍会成功退出 | 先关闭监听，再等待有界清理，超时报告失败并保留持久历史 |

Cost Lab 把明确已结算的零、缺失账单、积分待结算、无效数据和无法归因分别表示。History Summary 与 Export 保留未知积分 `null`。本地合成测试覆盖真实零值、无数据、延迟、日期和时间窗口、旧历史、持久化失败及关闭超时。

`5a8bce91` 的独立复审重放了账单反例，确认两项 P1 已关闭。Ubuntu CI 在同一版本暴露六个 Resolver 夹具失败。模拟 Windows 能力的测试应使用实际宿主文件系统查找夹具，生产 Windows x64 能力门禁保持原样。修复后本机 Resolver、Adapter 和 Start Plan 定向测试合计 40 项通过。

## 验证记录

| 验证 | 当前证据 |
| --- | --- |
| Windows 本地完整回归 | 前一候选 933 项，931 通过、0 失败、2 既有跳过 |
| Typecheck、Build、Plugin Validation | `502045b2` 生产文件通过 |
| 生成物检查 | 全部 12 项跟踪文件与构建一致 |
| Cost Lab 定向测试 | 55 通过，0 失败，0 跳过 |
| Cost Lab 服务 | 从 `5a8bce91` 重启，loopback 健康检查、真实历史及导出中的显式 `null`、零模型 AppServer smoke 均通过 |
| Start Plan 兼容性 | Windows 历史真实证据，当前 3.18.2.10443 离线检查 |
| PR | [#101](https://github.com/Sandyzzx/codex-zcode-bridge/pull/101)，目标 `preview` |
| PR CI、独立复审、合并、Tag、发布和资源校验 | 待最终候选的独立复审及完整 CI |

Preview Marketplace 标识为 `codex-zcode-bridge-preview`，插件标识为 `codex-zcode-bridge`。候选包和生成物版本为 `2.0.0-preview.9`。后续发布验收以合并后的实际 Tree、CI 及 GitHub Release 资产为准。
