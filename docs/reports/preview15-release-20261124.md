# Preview.15 发布准备记录（2026-11-24）

> Status: RESEARCH（发布证据记录；最终发布事实以本页更新后的版本为准）
> Date: 2026-11-24
> Candidate branch: `codex/final-integration-20261124`
> Base: `origin/preview@7d0e6f35f`（PR #135 merge）

## 集成内容

1. **PR #135**（Owner Review PASS，Release Gate `45200314368` SUCCESS）→ merge `7d0e6f35f`。
2. **ZCode 4.0.0 适配（ADR-054）** → 分支 `codex/preview-zcode4-runtime-integration-20261123` 以提交 `15e75001` 固化后并入候选（合并提交解决 `docs/decisions/README.md` 头部冲突；制品随合并重新生成并入库）。
3. **P1 整改**：Turn Lifecycle Truthfulness、Executor Lease Spawn Fence、Release→Wake 恢复、ADR-056 Result 回读合同，各带故障注入测试。
4. **P2 精简**：死代码删除（LeaseGuardedTaskManager、#acceptRunOutcome、authorize 工具、env 键、实验 workflow）、Status `updated_at` 修正、Prompt 容量合同、文档/仓库卫生、engines 钉到 `>=24.16.0 <25`。

## 验证摘要（本机，REAL）

- 零模型 Protocol Smoke：`PASS`（4.0.0.10870 / `3bc8a247`，fingerprint `1493db78…`，bundle SHA-256 与审计一致，model_requests=0）。
- 真实任务 E2E：`PASS — REAL`（随包 `dist/executor.mjs` → 真实 Worker → 安装版 4.0.0 AppServer → 真实 GLM-5.3 回合；持久事件序列完整：turn_started(原生)→…→result_committed→cleanup_verified→released；工程产物逐字节核对一致；Executor 空闲关停 accepted）。
- 定向测试：批次 3 共 419+ PASS；两项失败均归因修复后复验（fixture seq 计数器、CLI 摘要桩）。mvp 家族 + CLI 终验 66/66 PASS。完整矩阵由 Release Gate 承担。
- 未测量/未运行：真实模型 Skill 遵循率、Prompt Cache 收益、付费 A/B；严格 Wake C/D；Desktop fully exited；跨机器复现。

## 已知边界

- `turn_accepted` 仅为内存/诊断事实；`runtime_task_events` 冻结 SQL CHECK 未扩展（诚实边界，不伪造持久化）。
- ADR-036 自动重派链保持 test-only（2026-11-24 裁决附注）；interuption-requeue 完整退役排期下周期。
- 本机操作员 `runtime-config.json` 仍含已退役授权键（仅报告，未修改用户配置）。

## 制品身份（发布时以 Release Gate 运行产物为准）

- Worker bundle / plugin dist 均由 `npm run build` 重新生成并通过 `check:generated`（14 文件 fresh）与 `validate:plugin`。
- 版本号：`package.json`、`package-lock.json`、`plugin.json`（两处）、插件 README 均为 `2.0.0-preview.15`。
