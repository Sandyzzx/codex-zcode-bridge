# Preview.17 真实 Host 自动返工与验收 E2E

> Status: RESEARCH（真实 Host/Queue/Wake 证据）
> Date: 2026-11-25（Asia/Shanghai）
> Candidate: `2.0.0-preview.17`
> Runtime artifacts: `dist/bridge.mjs` SHA-256
> `C862DFA157568EF76403717A096B60157CBF0EC5DDE0B788156407E959E92DEE`
> Baseline: `origin/preview` `6af69b55d7ecb660c2ad2c923888cf7f1e8886c8`

## 1. 目的与边界

本运行只验证 Preview.17 第一阶段核心闭环：

1. 实际安装的候选插件被真实 Codex Host 注册并通过原生 `zcode_*` MCP
   工具调用。
2. Worker 正常完成且 Result 可回读，但 Master 的工程验收失败。
3. Master 自主诊断，不请求用户批准普通返工，直接 `zcode_continue`
   原 Task。
4. Continue 创建 Attempt 2，同时保留 Attempt 1 的 Result Digest、
   Cleanup、Release 和全部 Wake 事件。
5. 每次 Verification Release 只产生一次 Queue 交付，并在原 Owner Thread
   上触发新的 Host Turn。
6. 第二轮通过同一独立验收脚本后，Master 才报告 Goal Accepted。

不在本运行范围内：Desktop fully exited、Thread notLoaded、Windows 重启、
严格 Wake C/D、真实 Skill 遵循率与 Token Cache 效率。这些仍为
`NOT_RUN / NOT_MEASURED`。

## 2. 运行环境

| 项目 | 值 |
|---|---|
| 插件 | `codex-zcode-bridge@codex-zcode-bridge-candidate` |
| 版本 | `2.0.0-preview.17` |
| Task | `PREVIEW17-REAL-HOST-AUTOREWORK-20261125-R2` |
| Owner Thread | `01a21317-ce86-7842-9cab-075b96679311` |
| Model | `account:bigmodel-individual-coding-plan` / `GLM-5.3-Flash` |
| Reasoning | `low` |
| Scope | `whole_task` |
| Workspace | `.run/preview17-real-e2e-20261125/worker-workspace` |
| Bridge Authority | `.run/preview17-real-e2e-20261125/bridge-data` |
| Host profile | `.run/preview17-real-e2e-20261125/test-home`（仅测试用 `USERPROFILE`） |

隔离方式：测试进程使用独立 `USERPROFILE` 与
`ZCODE_BRIDGE_DATA_DIR`，但保留真实 `CODEX_HOME` 以复用账户与 Provider
连接。运行前的 `zcode_doctor` 只读到空的隔离 Authority，未触碰生产
Bridge 数据库。

## 3. 验收设计

- Attempt 1 合同：只创建 `ready.txt`，内容精确为
  `PREVIEW17_STAGE1_READY`，不得带尾随换行。
- Master 只有在 Attempt 1 Result 回读后才生成一次性
  `PREVIEW17_WITNESS_<16 hex>`。
- 独立验收脚本要求 workspace 精确包含 `ready.txt` 与 `witness.txt`，
  且两个文件字节完全匹配；任一缺失或多余文件均失败。
- 首轮故意不向 Worker 提供 witness，因此预期失败；失败必须由 Master
  以普通验收缺陷自动 Continue，而不是等待用户批准或降低标准。

## 4. 结果

| 项目 | Attempt 1 | Attempt 2 |
|---|---|---|
| Result Digest | `2541a3b1f59103a8a051c9f80eabd5dec9b99df194f1ad9933ef970401801fbf` | `72b47a0be2de59ecb67fdf42661fd4bf226040f71b3e9b32002d6bd42743db44` |
| Cleanup verified seq | 20 | 44 |
| Released seq | 21 | 45 |
| Queue seq | 23 | 47 |
| Queue message id | `01a21319-d641-7313-94b4-5787af5f15c1` | `01a2131b-5ae3-7f62-9616-dcccd5c3b16c` |
| Queue deliveries | 1 | 1 |
| New Host Turn on original Thread | 是 | 是 |
| 独立验收 | 失败：缺少 `witness.txt` | 通过：`PREVIEW17_ACCEPTANCE_OK`，exit 0 |

Attempt 1 的验收输出为 `AssertionError`，实际文件仅 `ready.txt`，符合
预设的“工程交付不完整”场景。Master 未修改验收标准，生成 witness 后
立即对同一 Task 调用 `zcode_continue`。

Attempt 2 保留 Attempt 1 的 `ready.txt` 字节不变，并新增
`witness.txt`。最终 workspace 精确为 `.git`、`ready.txt`、
`witness.txt`；Master 最后回复包含 `GOAL ACCEPTED`。

## 5. Host 与 MCP 证据

- `master-native-events-r2.json` 记录 47 个 Host 注册的
  `zcode_events` 事件；两个 Attempt 各有一条 `result_committed`、
  `cleanup_verified`、`released` 与一次 `observation_recorded` Wake。
- `host_observation` 明确记录两次 Wake 都在原 Thread
  `01a21317-ce86-7842-9cab-075b96679311` 的新 Turn 到达，且该 Turn
  执行了原生 MCP Result 回读。
- Executor 记录的 Host Turn 身份仍为 `turn_start_unverified`。Host 侧
  “新 Turn 收到 Wake”是独立观测，不提升为 Adapter 已验证的
  `turn_started`。
- 每次 Attempt 只有一次 Queue 交付；没有重复 Worker Spawn 或重复
  Queue Submission 证据。

## 6. 证据文件

| 文件 | 内容 |
|---|---|
| `.run/preview17-real-e2e-20261125/master-acceptance-evidence-r2.json` | 两轮 Digest、Cleanup/Release/Queue、验收输出与 Goal 状态 |
| `.run/preview17-real-e2e-20261125/master-native-events-r2.json` | 原生 `zcode_events` 汇总与 Host Turn 观测 |
| `.run/preview17-real-e2e-20261125/acceptance.mjs` | 独立验收脚本 |
| `.run/preview17-real-e2e-20261125/master-prompt.md` | Master 目标、权限与返工合同 |
| `.run/preview17-real-e2e-20261125/doctor-smoke-3.jsonl` | 隔离 Authority 与 Provider 预检 |
| `.run/preview17-real-e2e-20261125/failed-run-1-model-identification/` | 首次环境失败的保留证据（模型标识缺失，不是 Bridge 缺陷） |

## 7. 真实性边界

- 这是单次真实模型运行，证明一次完整自动返工闭环；不是 Skill 遵循率
  统计，也不是多轮无进展熔断的真实模型测量。
- 本次走的是 `zcode_continue` 同 Task 路径。真实 Host 上“Continue
  不可用时创建关联返工 Task”仍为 `NOT_RUN`，只有确定性策略夹具覆盖。
- 运行时制品与最终候选树一致；E2E 之后的提交只有插件清单品牌接线和
  文档，不改变 Bridge、Executor、Worker、Store 或 Host 协议行为。
