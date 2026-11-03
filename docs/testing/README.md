# Test Impact Gating

> Status: AUTHORITATIVE
> Last updated: 2026-11-03
> Last verified: 2026-11-03，核对 `package.json` scripts、`scripts/test-isolated.mjs` 的 `dist-test/test/**/*.test.js` 默认语义、`scripts/test-impact-selector.mjs`、`test/test-impact-map.json`、选择器 10/10 单元测试、dry-run 输出与 Windows 扩展完整隔离回归 804 pass/2 skip/0 fail
> Verified against: 本分支实施快照（见 `docs/reports/test-impact-gating-20261103.md`）

本规范只改变测试触发方式，不删除测试、不增加 SKIP、不降低断言或预算。现有完整隔离回归继续保留。

## 分层与命令

| 层级 | 内容 | 触发 |
|---|---|---|
| T0 | `typecheck`、`build`、`validate:plugin`、`git diff --check` | 每次变更 |
| T1 | 直接依赖的快速单元/集成测试 | 变更命中影响映射时 |
| T2 | 跨 Manager/Worker/Store/Adapter/Host 集成测试 | 变更命中对应模块边界时 |
| T3 | 已登记压力测试 | 只在压力边界命中时 |
| T4 | `npm test` 完整隔离串行回归 | CI、R4、发布候选、关键架构切换或测试基础设施变更 |

日常入口是 `npm run test:affected`。它无条件执行 T0，然后读取已提交（相对 upstream merge-base）、暂存、未暂存和未跟踪变更，输出影响域、选中测试、未触发压力测试和理由。`npm run test:stress -- --file=<file>` 按文件执行登记压力测试；不带参数执行全部登记压力测试。`npm run test:full` 是正式完整验收入口；`npm test` 的语义不变，仍是完整隔离回归，CI 也继续运行完整 `npm test`。

`test:affected` 不能在无测试匹配时输出测试 PASS；结果是显式的 `NO_TESTS_APPLICABLE`，文档-only 变更仍必须通过 T0。无法识别源码、新增未知源码或测试基础设施、公共接口、共享错误合同、构建/CI/runner/map 变更都会进入 `FULL_SUITE` 回退。默认测试运行器保持 Windows 串行、Linux 使用 Node test 默认并发，不改变超时和断言。

完整静态清单由 `npm run test:inventory` 从 AST 和影响映射生成到 `test-inventory.json`。每条记录包含稳定 Test ID、文件/行、类型、Gate、静态依赖、资源类别、触发路径、压力边界和运行证据。没有当场测量的运行时标记为 `NOT_MEASURED`；只有 B3-05 引用历史报告，不能把历史基准当作本次实测。

## B3-05

`test/batch2-performance.test.ts` 中的 `B3-05` 是当前唯一登记的正式压力测试。它验证 JSON TaskStore/TaskManager 在 32 active 与 10,000 historical 任务下的状态、恢复和有界事件扫描边界，保留 900 秒 timeout 和 720 秒 setup 性能预算；所有既有断言不变。历史报告记录 732,770 ms setup，本次未重测，不能据此宣称当前基准。

B3-05 只在这些边界命中时触发：JSON TaskStore 读写/扫描、Manager 遍历/查询/恢复、workspace provider 的执行路径、SQLite persistence/schema/bootstrap/admission/CAS/lifecycle 合同，或 B3-05 自身/fixture/test runner/map。`src/runtime/paths.ts`、ZCode HOME/USERPROFILE/dataBaseDir、Provider 配置路径、PowerShell 路径脚本、与 TaskStore 无关的 Doctor 路径诊断、普通 MCP 文档/图标/插件元数据不触发 B3-05。Bridge 自己的 TaskStore 数据目录与 ZCode 用户数据 `.zcode` 是不同边界；只有真实影响 TaskStore 打开/读写/迁移路径才触发。

当前仓库快照没有独立的 Attention/Waiter、Worker 并发压测或 SQLite WAL/CAS 大规模正式压力测试登记；相关生命周期测试归入 T2。不得按测试名称假设其它测试是压力测试；新增正式压力测试必须先补影响映射、命令、预算和基准。

## Agent 工作流

开发中先运行 `npm run test:affected`；只有选择结果实际命中 T3 才运行压力测试。失败不得进入下一阶段。交付报告必须写明：实际运行命令、通过/失败、压力测试运行了还是未运行、未运行的真实影响域理由、`NO_TESTS_APPLICABLE` 不等于 PASS、以及是否需要 R4 完整回归。R4 在专门验收快照上运行 `npm run test:full` 和 Full G6，不减少测试、不添加 SKIP、不改断言。
