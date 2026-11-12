# Start Plan Prereview Integration Status

> Status: RESEARCH
> Date: 2026-11-06
> Branch: `codex/start-plan-prereview-20261106`（基点 `d77de9bb`，含未提交集成 WIP）
> Scope: Gate 2 WIP 选择性移植 + P0 生产模块实现；**P0 合成验收未完成，存在具体阻塞点**。

## 状态

```yaml
STATUS: BLOCKED（两个确定性集成失败；未提交、未推送、未开 PR）
TRANSPANT: DONE（三方合并：3 干净 + 3 手工解冲突；27 个 untracked 零冲突）
PRESERVATION: DONE（原 WIP 18 条未动；快照与哈希见 .run/start-plan-prereview-20261106-wip-snapshot）
TYPECHECK_BUILD_PLUGIN: PASS
UNIT_TESTS: PASS（11/11，node:test 编译管线）
INTEGRATION_TESTS: 21/25 PASS（隔离复跑另有 3 个通过 → 实际确定性失败 2 个）
FULL_NPM_TEST: NOT RUN
```

## 已完成

1. 原 WIP 保全：`git status`、tracked 补丁（SHA256 `2d1f4963…`）、27 个 untracked 文件 SHA256 清单。
2. 移植：`git apply -3` 干净应用 lifecycle-gate/spawn-worker/adapter-test；adapter/worker-main/mvp-test 手工三方合并（master 的 prewarmCleanup/诊断 onEvent/lifecycleCollector 与 WIP 的 private-auth 选项全部保留）。
3. P0-C HANDLE 门禁：`windows-process-cleanup.ts` 新增 `Alive` 命令（held-handle 上 WaitForSingleObject+GetProcessTimes）；新模块 `start-plan-handle-gate.ts`（open→hold→exact ticks 校验→assertAlive→close）；lifecycle-gate 交付前验证改用 held handle（独立 PID 快照不再作为充分证据）；事务可注入（Ubuntu CI 假事务）。
4. P0-A/B 生产签发：`start-plan-production-auth.ts` — 官方凭据读取（`credentials.json` 的 `zcodejwttoken`+OAuth account，仅内存）、官方版本来源（`zcode.cjs --version` 只读执行，禁硬编码）、实时权益客户端（官方 billing 端点形状，一次一查、无缓存、无重试）、判别式失败分类（401/403/429/3007/3012/3001/quota/no-entitlement/model-unavailable）；stdio.ts 生产接线（Windows+官方凭据存在才构造，否则按既有路径 fail-closed）。
5. 测试工装：mvp fixture 注入受控假句柄事务（保持门禁身份合同真实执行）；env-probe 路径修复（`import.meta.url` 相对解析 + copy-test-assets 复制探针）。

## 阻塞点（P0 合成验收）

### 阻塞 1：crash-hold 与 ADR-024 恢复语义冲突

`SQLite Worker crash without cancellation holds recovery and fences dispatch`
确定性失败：crash 后同 workspace 新派发未被 fence（旧 Gate 2 预期全局/路径 hold 语义 vs
ADR-024 的 operation 级占用 + evidence-only recovery）。需要按 ADR-024 正式裁决：
crash 后 operation 保持 running 占用应足够 fence，需查 admission overlap 判定为何放行。

### 阻塞 2：lifetime-EOF 后任务不终态

`SQLite Worker rejects subsequent runtime auth after lifetime pipe EOF`
确定性失败（53s 超时，observed: running）：父管道 EOF 后后续 runtime auth 请求应快速失败并使
task 终态。疑似与 master 侧 harness 改动（worker teardown race 修复 4a3763eb/7fbbfcec）
或 ADR-024 hold 下 result 提交路径交互。需要 worker stderr + operation 事件链定位。

### 干扰说明

wrong-claim 与 write-cancel 在全文件连跑时超时/失败，但隔离复跑均 PASS（6.1s / 7.9s）；
属进程内测试间干扰（fixture 清理/handle 遗留），非语义回归，建议后续按文件拆分或加固隔离。

## 禁止事项遵守

原 WIP 未动；无 OAuth/Billing/captcha/真实模型请求；未生成或轮换 Device ID；未启用 Model I/O
retention；未改 SQLite 生产数据；未 push/merge/tag/release；工作分支上内容为未提交集成 WIP。
