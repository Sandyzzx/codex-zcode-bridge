# Test Impact Gating 实施与验证记录

> Status: RESEARCH（一次性实施与验证记录，不替代当前合同）
> Date: 2026-11-03
> Base: origin/master `879568c211bac6233817acc90923e23d7861ca79`
> Branch: `codex/test-impact-gating-20261103`

## 结果概览

本工作包在独立 worktree `D:\codex-zcode-bridge\.run\test-impact-gating-20261103` 实施 Test Impact Gating。生产业务逻辑、SQLite Authority、任务调度和 Worker 生命周期未改；现有测试全部保留，`npm test` 和 CI 的完整回归语义未改。

- 新增纯选择器 `scripts/test-impact-selector.mjs`，Git 采集/命令执行分离在 `scripts/run-affected-tests.mjs`。
- 新增 `test/test-impact-map.json` 影响映射、`test:affected`、`test:stress`、`test:full` 和 `test:inventory`。
- 新增 AST 生成器 `scripts/generate-test-inventory.mjs` 与 `docs/testing/test-inventory.json` 完整声明清单。
- 新增测试分层合同 `docs/testing/README.md`、B3-05 触发规则、AGENTS/Skill 工作流更新与选择器单元测试。

## 测试清单与分层

静态清单通过 TypeScript AST 解析 `test/` 中的 `test(...)`/`it(...)` 声明，并与影响映射合并。当前快照登记 89 个可执行或手动 E2E 文件、872 条 Node test 声明；类型合计 207 Unit、664 Integration、1 Stress。四份 `live-*.mjs` 是映射中的 manual E2E 文件，但没有 `test(...)` 声明；现有默认 runner 也不 glob 这些文件，因此它们不计入 872 条，也不被 `npm test` 自动执行。无当前逐项实测运行时间；除 B3-05 的历史 setup 证据外均标记 `NOT_MEASURED`。

注意：E2E 数字按文件 gate 汇总，Node 默认 runner 实际不 glob `test/live-*.mjs`。不能把 manual/live E2E 数量理解为已进入 Full G6。正式 Full G6 当前合同是 `npm run test:full`，其中 `npm test` 执行隔离串行回归；真实 provider/live E2E仍需单独命令和授权。

## 触发规则实现

- 命中范围：当前分支相对 upstream merge-base 的已提交变更、暂存/未暂存变更和未跟踪文件。显式 `--base <ref>` 使用 `<ref>...HEAD` 再叠加工作区变更；重命名同时记录旧路径与新路径。
- 命中域：由 `test/test-impact-map.json` 显式声明；只有该域的测试被选中。变更测试文件也会选中自身；共享 fixture、runner、map、package、CI、公共接口或未知源码立即进入完整回归。
- 压力门：`B3-05` 只在 JSON TaskStore、Manager 遍历/查询/恢复、workspace provider、SQLite persistence/schema/bootstrap/admission/CAS/lifecycle，或 B3-05/fixture/test runner/map 命中时运行。
- 安全回退：无测试匹配输出 `NO_TESTS_APPLICABLE`，不是 PASS；未知源码或测试基础设施、接口、共享错误合同、构建/CI/runner/map 变更输出 `FULL_SUITE`。

## 旧流程对照

| 场景 | 旧流程 | 新流程 |
|---|---|---|
| 日常路径发现器修改 | 常规要求完整 `npm test`，可能重复 B3-05 | `npm run test:affected` 执行 T0 和路径/Runtime/Worker 环境测试；`STRESS_TESTS_NOT_APPLICABLE` |
| TaskStore/SQLite schema 修改 | 完整回归，压力触发隐含在全量中 | 先选中对应单元/集成测试，并显式给出 `STRESS_TEST_REQUIRED` |
| 文档-only 修改 | 通常无统一快速门 | T0 必跑；无测试匹配显式 `NO_TESTS_APPLICABLE` |
| runner/map/fixture/CI 修改 | 完整回归 | 显式 `FULL_SUITE`，继续执行完整 `npm test` |
| R4/发布候选 | 完整回归 | `npm run test:full` 或同等完整 T0–T4；真实 live E2E仍按其单独授权执行 |

## 验证结果（2026-11-03，Windows / Node 24.16.0）

1. `npm run typecheck`：PASS。
2. `npm run build`：最终 PASS。两次瞬时 Windows rename `EPERM` 后，为 `scripts/build-core.mjs` 的原子目录替换增加仅针对 `EPERM` 的有界重试；每次重试间隔 10/20/30/40 ms，非 `EPERM` 仍立即失败，产物守卫和目标范围不变。
3. `npm run validate:plugin`：PASS。
4. `git diff --check`：PASS；Git 仅输出仓库既有 CRLF normalization warning，无空白错误。
5. 选择器单元测试：`node scripts/test-isolated.mjs dist-test/test/test-impact-selector.test.js` PASS，10 tests / 10 pass / 0 fail。覆盖路径不触发 B3-05、TaskStore 与 SQLite schema 触发 B3-05、Worker/AppServer 选择、文档-only、未知源码/测试基础设施回退、runner/helper/map 完整回归、重命名、多来源 Git 输入、显式 base 与重复快照稳定性。
6. `npm run test:inventory`：PASS；生成 89 个映射文件、872 条声明（207 Unit、664 Integration、1 Stress）。
7. `npm run test:affected -- --dry-run`：PASS；当前工作包因修改 package/runner/map 正确进入 `FULL_SUITE`，理由可追溯到具体路径。
8. `npm run test:affected`：PASS，触发并执行完整 `npm test`。最终 Node test汇总：707 tests，705 pass，2 skip，0 fail，0 cancelled；总耗时 1,156,800.9109 ms。两个 skip 是既有平台/运行时条件 skip，本次未新增 SKIP。
9. B3-05 stress：PASS，实测 347,909.0974 ms。32 active/10,000 historical setup 实测 288,621 ms，低于 720,000 ms 预算；status p95 3.82 ms、recovery 14,644.4 ms。未修改 active/historical 参数、timeout、断言或预算。
10. Bundle identity：`git diff --exit-code -- plugins/codex-zcode-bridge/dist/bridge.mjs plugins/codex-zcode-bridge/dist/schema.sql plugins/codex-zcode-bridge/dist/admin-abandonment.sql plugins/codex-zcode-bridge/worker/worker-main.mjs` exit 0。

`npm run test:full` 未作为字面命令重复执行；其 typecheck、build、`npm test` 和 validate:plugin 组成门已在本次 `test:affected` 的 FULL_SUITE 及相邻验证中全部通过。避免刚完成 B3-05 后立即重复压力测试。

## 边界与 NOT RUN

- 当前逐项测试 runtime 仍未测量；清单中的 `runtime=NOT_MEASURED` 不得当作快速或已验证耗时。B3-05 只有本次和历史 setup 证据。
- 当前 master 快照没有独立登记的 Attention/Waiter、Worker 并发、SQLite WAL/CAS 大规模正式压力测试；相关测试保持 T2 分类。
- manual `test/live-*.mjs` 不进入 `npm test`，本次未运行。
- CI 工作流未改为日常 selective gate，以保持现有 Windows/Linux 双平台完整回归门槛。

## 最终裁决

PASS。实现保留全部既有测试和完整回归语义；B3-05 触发/不触发策略经单元测试与完整运行验证，未降低预算或断言。
