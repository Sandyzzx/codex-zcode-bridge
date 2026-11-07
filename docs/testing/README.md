# 测试入口与成本边界

> Status: AUTHORITATIVE
> Last updated: 2026-11-07
> Last verified: 2026-11-07，核对 ADR-029 自动/压力清单、selector 与退役范围；实际结果见本轮报告。
> Verified against: a46137fe46b567271a7756be819361132625278c + ADR-029 本地候选

`test/test-impact-map.json` 为可执行清单唯一来源。共享资格规则禁止 MANUAL_E2E、Fixture 自动执行，显式误传同样拒绝；源 .test.ts/.test.mjs、map 与实际 --list 由回归对账。生成的 test-inventory.json 是静态声明/历史证据索引，不决定执行。

| 入口 | 行为 |
|---|---|
| npm run test:affected | 必跑 T0（typecheck/build/plugin validation/diff check），按真实依赖选择功能/压力测试；未知源码或基础设施变化回退完整功能回归 |
| npm test | 编译并运行本平台全部功能测试；不隐式执行登记压力矩阵 |
| npm run test:full | typecheck/build/npm test/plugin validation；冻结 Windows 门禁 |
| npm run test:stress | 编译后显式运行登记资源矩阵；支持 --file=<registered file> |
| npm run test:clean-entrypoints | 无 production dist 的 compiled stdio、shipped launcher、Worker 拒绝和 bundled Core |
| node scripts/test-isolated.mjs --list | 本平台实际默认执行集合 |

FULL_SUITE 表示完整功能回归，压力状态为 SEPARATE_STRESS_GATE。SQLite 边界的 targeted selection 标记 STRESS_TEST_REQUIRED；显式 test:stress 或受影响文件入口可执行压力项。文档-only 是 NO_TESTS_APPLICABLE，dry-run 是 DRY_RUN_ONLY，都不能称测试 PASS。

Windows 进程/身份套件按文件串行；其他平台保留既有 Windows-only 限制并打印排除清单，不通过新增 SKIP 获得绿色。现有 admin-abandonment CLI 测试在 Windows 验证成功/CAS，在其他平台验证 windows_required 且数据库逻辑事实不变；生产 guard 不变。

## 退役与保留

JSON B3-05 是 TaskStore/TaskManager 的 32 active/10,000 historical 与 JSON event scan 测试，随旧实现删除，不是 SQLite v14 的性能证据。其 695.904s 集成基线只作为历史成本保留。

SQLite 功能门禁继续覆盖永久 Claim、CAS、路径/Capacity 竞争、Result、Recovery、Interaction、Cleanup、v13→v14、真实 Worker/Windows 管道和 R1–R5。混合用例保留 Adapter/进程/隐私部分；旧 JSON 写盘、checkpoint、respawn、roster 和专属锁协议退役，逐项依据见本轮报告。

SQLITE-STRESS-01 使用生产 Store/事务 API：0/32/256 已取消历史任务、WAL reader snapshot 与 checkpoint、四进程同 Result CAS、八进程 Admission/Capacity。使用真实 SQLite、隔离根和受控 synthetic identity，不假称真实 Provider/进程树压力认证。旧大 Result 1/2/4/8 资源证据仍独立保留，不把此矩阵推广为任意规模性能保证。

压力资源与功能断言分开报告；不复制 10,000 次 JSON 文件准备，不提高原测试 timeout，不减小 32 MiB 合同，不以 SKIP 或放宽断言换耗时。CI 保留完整 npm test；登记压力矩阵通过独立 CI job 调度。
