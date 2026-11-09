# SQLite 合同收敛：本轮工程回执

> Status: RESEARCH
> Date: 2026-11-05
> Implementation: `a70ea20bec615a6c49c42f45b4fe188aca3a48e4`
> Implementation tree: `3ded8b7155762ffa179da979d84644290dc09842`
> Platform follow-up: `21a8d377bc79bbab8de3ba1af5b2e4417248b0db`；code tree `ea3ae9161a680eed73164cac4fc4e46e9da1a787`
> Parent: `aabbb0a959ee234508c62731ed5122f28dfcf5b0`

## 已解决

- 自动 test 清单统一由 impact map 决定。full、affected、stress、显式文件运行共用资格/平台/编译路径规则；manual E2E 和 Fixture 不再混入，显式传入亦拒绝。删除独立 glob/补列逻辑，陈旧 dist-test 文件不会被自动发现执行；新增/遗漏/失效映射由源文件对账测试报错。
- Attention/Thin Waiter 原有 16 项接入真实依赖映射；安装根、Store/Schema/Port、read-only/wait/snapshot、CLI 与相关 Host 变化有消费者覆盖。
- 六个漏执行 SQLite `.mjs` 先修再接入：容量场景使用不同路径，路径互斥负例保留；补合法交互 helper；cursor 使用真实完成/Release/Continue，删除不可达的直接 SQL 合成。没有删测试、加 SKIP、放宽失败类型或调高超时。
- 生产 `spawnClaimOnlyWorker` 创建 ChildProcess 后立即 resume stderr。无人订阅的数据流直接消费丢弃，不累计日志；已有观察者仍可订阅，不引入缓存、配置、watchdog 或额外状态机。Result/Claim/interaction FD 及 Cleanup 语义未改。提交的 bridge bundle 已同步。
- affected 回退 full 时消除一次重复测试编译。

## 文件范围

| 范围 | 文件 |
|---|---|
| 自动执行 | scripts/lib/test-files.mjs；test-isolated、test-impact-selector、run-affected-tests、run-stress-tests、test-clean-entrypoints |
| 映射/不变量 | test/test-impact-map.json、test/test-impact-selector.test.ts |
| 旧测试修复 | wp6b2b1/admission.test.mjs、lifecycle-port.test.mjs；wp6c/result-recovery.test.mjs |
| 生产与真实管道验证 | src/manager/spawn-worker.ts、test/spawn-worker-stderr.test.ts、wp6b-wiring/mvp-real-adapter.test.ts、插件 dist/bridge.mjs |
| 合同方案/实验 | ADR-026、docs/research/sqlite-result-contract-20261105/probe.mjs；测试入口说明同步更新 |

Store、schema.sql、行政 schema、业务 Task/Attempt/Claim/Recovery 转换和旧 JSON API 未变。没有迁移或读取生产数据库、恢复/删除未知 Hold/WRITER_INTENT。

## 验证

Windows / Node 24.16.0；所有自有数据库和日志位于本 worktree 内。

| 检查 | 实际结果 |
|---|---|
| 初始 test:affected T0 dry-run | PASS |
| 最终 affected dry-run（显式对比冻结 SHA） | PASS；选中 FULL_SUITE 的 87 个自动文件，压力 INCLUDED_BY_FULL_SUITE；T0 通过，DRY_RUN_ONLY，不重复计为另一轮功能回归 |
| 修复后定向组合 | **161 pass / 0 fail / 0 skip**，73.850s；包含 13 项 selector、16 项 Attention/Waiter、124 项源 mjs、4 项 pipe、4 项 MVP |
| Windows stderr 原版/修复版对照 | 同样同步写 8MiB：原版 1s 时无 Result/未退出，外部排水后完成；修复版无人 recorder 时已交付 Result 并退出 0 |
| 真实生产 Spawner 管道 | 4/4 PASS；8MiB，同/不同 interaction FD 布局，正常/23 非零退出 |
| SQLite Worker→真实 Adapter→受控 app-server | PASS；32,000 个流式事件，无 stderr recorder，Result completed、Cleanup/Release、session/send 一次 |
| Windows 精确进程身份 probe | PASS，win32/exact/fingerprint，无 failure |
| 无 production dist 的 clean entrypoints | 4/4 PASS；compiled stdio、marketplace launcher、worker 参数拒绝、bundled core |
| stress 误选 manual 的实际 CLI | 显式拒绝、退出 1，无 live 执行 |
| Result 当前合同探针 | PASS（反例证据）；19 组，真实序列化和 SQLite 原值/字节回读；旧规则拒绝仍如实记为缺陷，不计为修复通过 |
| Windows test:full | **PASS，973 项 / 971 pass / 0 fail / 2 个原有 skip**；Node 1379.423s，wall 1402.914s；含 typecheck/build/完整测试/plugin validation |
| 正式压力 B3-05 | **已运行并 PASS**，353.584s；32 active / 10,000 historical、900s timeout / 720s setup budget 原样保留，不是 STRESS_TESTS_NOT_APPLICABLE |
| Ubuntu 完整运行、真实 Provider/Host E2E | NOT RUN；CI 配置与原有两平台门禁保留 |

新增源文件与 map 的对账测试保证：full 解释集合与实际 `--list` 一致，四个 manual/三个 Fixture 不自动执行；Linux 模拟选择保留原八项 Windows-only 限制。实际 Linux 内核执行未据此宣称通过。

自动集合当前为 Windows 87 个文件、POSIX 79 个文件。新接入的源 mjs 中，Worker 要求精确 Windows 身份的成功分支在其他平台验证退出 3、无身份报告/Claim；行政结案后的新派发在不支持平台验证 TASK_INVALID，原结案保持。这些是明确的失败边界断言，不是新增 SKIP；Windows 原成功断言保留。实际 Ubuntu 仍需 CI 验证。

证据目录：`.run/execution/` 中 `targeted-final.tap`、`stderr-before-after.json`、`windows-identity.log`、`clean-entrypoints.log`、`result-contract-evidence.json`、`test-full.log`。原始失败尝试同样保留；最终通过不抹掉问题发现过程。

相对 Phase 0 的 841 项，当前增加 132 项，主要来自真正执行的六文件和新回归；没有以数量下降作为优化。两个 skip 沿用 Windows POSIX 权限位和 ENOTEMPTY 注入用例。当前单次全量耗时低于旧测量，但机器缓存/负载与执行集合不同，不据此宣称稳定性能提升；可确定的成本减法是移除 affected→full 的重复编译和不再误选 live/fixture。

## Result：待 Owner 决策，未实施 Schema 修改

推荐 [ADR-026](../decisions/ADR-026-sqlite-result-contract.md)：报告自由文本/数组统一语义；完整 canonical TaskResult **32MiB UTF-8** 上限，Worker envelope 另留 **256KiB**；v13→v14 显式升级，生产迁移另授权。删除 Store 独有的报告文本限制，保留身份、类型、CAS 和真实资源闭合。不截断 Result、不建 JSON sidecar、不重派。

本轮用 ASCII/中文/emoji/JSON 转义验证 65,536-byte 两侧；当前 Store 恰能保存边界内完整字节，65,537-byte 被拒。2M 字符控制文本序列化约 12MB，说明字符长度不能替代容量。新推荐上限及 migration 尚未实施/验收，不能称 D2 已解决。

## 仍阻塞与下一步

本轮交付不包含 Result/schema 修复、执行/清理时限、Launch 已证 no-spawn 终结、Manager 重启后无 Result 结案、并发配置/pump 和普通 Events/Feedback 的生产改动。它们保持原裁决，尤其不因 stderr 修复就解除相关 Hold 或重派。

Owner 批准 ADR-026 后，优先做共享 Result 合同、隔离 v13/v14 升级与真实 Worker 完整结果回归，再做期限衔接；Launch/Recovery 语义继续单独决策和验证。历史 JSON 专属测试的退役等待对应生产覆盖，当前没有批量减测试或声称总耗时已下降。

## Git 与回滚

工作区：`D:\codex-zcode-bridge\.run\sqlite-contract-execution-20261105`，分支 `codex/sqlite-contract-execution-20261105`。实现 commit/tree 见顶部；决策与回执另行本地提交。主 checkout 原 `.gitignore` WIP 保留，未 Push/Merge/Tag/Release。

本轮无数据格式改变，可以独立回退实现代码；回退会重新暴露误选/背压，不能当作问题已解决。未来 Schema 写入后不得直接用旧二进制/旧快照回滚新增业务数据；按 ADR 的显式升级与恢复方案处理。
