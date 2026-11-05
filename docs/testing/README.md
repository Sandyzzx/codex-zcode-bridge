# Test Impact Gating

> Status: AUTHORITATIVE
> Last updated: 2026-11-05
> Last verified: 2026-11-05，核对共享自动清单、manual/fixture 拒绝、Attention/Waiter 依赖、六个原遗漏套件；Windows 定向 161 项全通过。完整回归和 NOT RUN 范围见[本轮实施回执](../reports/sqlite-contract-execution-20261105.md)。
> Verified against: a70ea20bec615a6c49c42f45b4fe188aca3a48e4

本规范只改变测试触发方式，不删除测试、不增加 SKIP、不降低断言或预算。现有完整隔离回归继续保留。

## 分层与命令

| 层级 | 内容 | 触发 |
|---|---|---|
| T0 | `typecheck`、`build`、`validate:plugin`、`git diff --check` | 每次变更 |
| T1 | 直接依赖的快速单元/集成测试 | 变更命中影响映射时 |
| T2 | 跨 Manager/Worker/Store/Adapter/Host 集成测试 | 变更命中对应模块边界时 |
| T3 | 已登记压力测试 | 只在压力边界命中时 |
| T4 | `npm test` 平台适用的完整隔离回归；Windows 执行全部映射集成测试 | CI、R4、发布候选、关键架构切换或测试基础设施变更 |

日常入口是 `npm run test:affected`。它无条件执行 T0，然后读取已提交（相对 upstream merge-base）、暂存、未暂存和未跟踪变更，输出影响域、选中测试、未触发压力测试和理由。`npm run test:stress -- --file=<file>` 按文件执行登记压力测试；不带参数执行全部登记压力测试。`npm run test:full` 是正式完整验收入口；`npm test` 保持完整隔离回归语义，并按操作系统合同选择可执行的测试集。

`test:affected` 不能在无测试匹配时输出测试 PASS；结果是显式的 `NO_TESTS_APPLICABLE`，文档-only 变更仍必须通过 T0。无法识别源码、新增未知源码或测试基础设施、公共接口、共享错误合同、构建/CI/runner/map 变更都会进入 `FULL_SUITE` 回退。默认测试运行器保持 Windows 串行、Linux 使用 Node test 默认并发，不改变超时和断言。

`test/test-impact-map.json` 是自动执行文件清单的唯一来源。`scripts/lib/test-files.mjs` 为 full、affected、stress 和显式文件调用共享自动资格、平台限制和编译路径转换。`MANUAL_E2E` 与 `Fixture` 不进入任何自动集合；显式传入也会在建立隔离环境前拒绝。手动 E2E 使用其显式入口，不由自动选择器启动。`node scripts/test-isolated.mjs --list` 查看本平台实际完整集合。

显式文件参数使用 `--list` 列出的相对路径；Node 测试选项使用 `--option=value` 形式，避免将独立选项值误当测试文件。

默认集合包含有效的编译后 TS 测试与源 `.test.mjs`，不再依赖宽 glob、单独补列 schema 测试或扫描陈旧编译输出。CI 的清单校验会对账所有 `.test.ts/.test.mjs` 源文件、失效路径、重复映射以及 full 与 runner 集合；新增测试必须登记。六个原遗漏 SQLite 文件先修复当前合同的 Fixture/helper 后接入，没有删除其合同断言。affected 回退 full 时由 `npm test` 统一编译一次。

`npm run test:inventory` 生成的 `test-inventory.json` 是 AST 分析与历史证据清单，不决定自动执行。没有当场测量的运行时标记为 `NOT_MEASURED`；不能把历史基准当作本次实测。

Windows 的 `npm test` 执行全部自动文件和其嵌套测试，包括 SQLite bootstrap cross-process 与源 `.mjs`。POSIX 在同一共享规则下明确排除原有八个要求 Windows exclusive-file-handle bootstrap 或 Windows-local Trusted Local Policy 的文件，并打印排除清单；targeted 同样适用此限制。Windows CI 仍是这些成功生命周期的执行门禁，不将其改成 SKIP 或放宽断言。

## B3-05

`test/batch2-performance.test.ts` 中的 `B3-05` 是当前唯一登记的正式压力测试。它验证 JSON TaskStore/TaskManager 在 32 active 与 10,000 historical 任务下的状态、恢复和有界事件扫描边界，保留 900 秒 timeout 和 720 秒 setup 性能预算；所有既有断言不变。历史报告记录 732,770 ms setup，本次未重测，不能据此宣称当前基准。

B3-05 只在这些边界命中时触发：JSON TaskStore 读写/扫描、Manager 遍历/查询/恢复、workspace provider 的执行路径、SQLite persistence/schema/bootstrap/admission/CAS/lifecycle 合同，或 B3-05 自身/fixture/test runner/map。`src/runtime/paths.ts`、ZCode HOME/USERPROFILE/dataBaseDir、Provider 配置路径、PowerShell 路径脚本、与 TaskStore 无关的 Doctor 路径诊断、普通 MCP 文档/图标/插件元数据不触发 B3-05。Bridge 自己的 TaskStore 数据目录与 ZCode 用户数据 `.zcode` 是不同边界；只有真实影响 TaskStore 打开/读写/迁移路径才触发。

Attention/Thin Waiter 的现有 16 项已登记到 `attention-waiting` 及其公共接口/Host 依赖，安装根、Store/Schema/Port、只读读取、等待谓词和 CLI 变更会选中相应消费者。它们是普通单元/集成测试；Worker 管道回归亦非正式压力测试。当前仍没有 SQLite WAL/CAS 大规模压力登记；不得把 B3-05 的 JSON 规模结论当作 SQLite 压力验收。

## Agent 工作流

开发中先运行 `npm run test:affected`；只有选择结果实际命中 T3 才运行压力测试。失败不得进入下一阶段。交付报告必须写明：实际运行命令、通过/失败、压力测试运行了还是未运行、未运行的真实影响域理由、`NO_TESTS_APPLICABLE` 不等于 PASS、以及是否需要 R4 完整回归。R4 在专门验收快照上运行 `npm run test:full` 和 Full G6，不减少测试、不添加 SKIP、不改断言。
