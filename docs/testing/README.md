# 测试入口与成本边界

> Status: AUTHORITATIVE
> Last updated: 2026-11-27（Stable 2.0.0 结项清理）
> Last verified: 2026-11-27，核对 Stable 2.0.0 的本地完整门禁、PR Release Gate 和 master push CI 记录；未执行新的真实模型任务。
> Verified against: `dfee062e7c30261763f642106d9ae18b48ce1ae0`

`test/test-impact-map.json` 是可执行测试清单的唯一来源。源测试、映射、实际 `--list` 由回归对账；`docs/testing/test-inventory.json` 是静态声明索引，不决定执行。不得把延期、跳过或 `NO_TESTS_APPLICABLE` 写成测试通过。

## 本地入口

| 入口 | 行为 |
|---|---|
| `npm run test:affected` | 必跑 T0（typecheck/build/plugin validation/generated freshness/diff check），按真实依赖选择受影响测试 |
| `npm run test:affected -- --development` | 开发门禁；完整回归可明确延期到 Release Gate |
| `npm test` | 编译并运行本平台全部自动功能测试 |
| `npm run test:full` | typecheck、build、`npm test` 和插件校验 |
| `npm run test:stress` | 显式运行登记资源矩阵；不替代功能测试 |
| `npm run test:shard -- --shard=1/2` | Windows 两路分片入口；计划必须覆盖全部自动测试 |
| `npm run test:clean-entrypoints` | 无 production dist 的 stdio、launcher、Worker 拒绝与 bundled Core |
| `node scripts/test-isolated.mjs --list` | 本平台实际默认执行集合 |

文档-only 变更至少运行受影响入口的 T0，并检查 Markdown 链接和 fence。Windows 进程/身份套件按文件串行；其他平台保留既有限制，不通过新增 SKIP 获得绿色。

## CI 门禁

普通 PR 先运行 Impact、Development Fast 和适用的 Windows Integration。`release-candidate` 标签只在非 Draft PR 生效；手动运行必须显式设置 `release_gate=true`。完整 Release Gate 运行 Ubuntu Verify、Windows 分片与聚合、SQLite 资源矩阵、Cost Lab、生成物 freshness、插件校验和 `git diff --check`。Push 到 `master` 直接运行完整保护。

变更不得降低断言、删除测试、放宽预算或把未执行的矩阵写成 `PASS`。压力测试只在完整 Release Gate 或 Owner 明确授权时运行；真实模型、真实 Desktop、官方 Queue 和真实 Billing 不是普通 PR 门禁。

## 当前基线

Stable 2.0.0 的本地完整门禁为 `1,199` tests / `1,197` pass / `2` existing platform skips / `0` fail；Release Gate [45958023915](https://github.com/Sandyzzx/codex-zcode-bridge/actions/runs/45958023915) 和 master push CI [45959124456](https://github.com/Sandyzzx/codex-zcode-bridge/actions/runs/45959124456) 通过。首次 master push CI 曾出现一次测试辅助进程抖动，第二次 attempt 通过；该事实不能被表述为首轮全绿。

SQLite 功能测试覆盖永久 Claim、CAS、路径/Capacity 竞争、Result、Recovery、Interaction、Cleanup、真实 Worker/Windows 管道和资源边界。v13 升级成功、恢复与回滚测试已退役，仅保留非破坏性拒绝合同。SQLITE-STRESS-01 使用生产 Store/事务 API，不替代真实 Provider 或进程树认证。
