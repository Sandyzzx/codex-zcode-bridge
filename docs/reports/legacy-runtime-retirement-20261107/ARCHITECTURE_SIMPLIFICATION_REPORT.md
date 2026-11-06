# Legacy Runtime Retirement 交付报告

> Status: RESEARCH（本地候选验收证据，不代表发布或生产部署）
> Date: 2026-11-07
> Integration baseline: a46137fe46b567271a7756be819361132625278c

## 判定与范围

**ARCHITECTURE_SIMPLIFICATION_PASS — 本地 Windows 隔离候选。** 最终冻结候选完整门禁 776 项 / 775 PASS / 1 既有 SKIP / 0 FAIL；墙钟 825.623 秒。原生 Ubuntu、远程 CI、外部 fork 升级与真实 Host 大 Result 接收本轮均 NOT RUN，不由本地 Windows 结论代替。

## 实际架构与删除依据

Host `startBridge` 直接持有原有 `SqliteLifecycleMcpAuthority`；SQLite driver/Store 管持久事实，私有 Worker 运行 `ZCodeAppServerAdapter`。删除外层双模式 Manager，把它唯一仍有生产职责的 Attention 等待及输入校验并入现有 SQLite Manager；没有新建 Manager、状态机或兼容包装。

| 退役对象 | 依赖证据与处理 |
|---|---|
| JSON TaskStore、TaskManager、调度/恢复/历史机制 | 正式 Host 已走 SQLite；旧 Core 导出仍构成公开合同，按 Owner 批准 ADR-029 破坏性删除 |
| JSON cutover/archive/writer-quiescence 及迁移 CLI | Fresh SQLite Bootstrap 不再调用；删除执行器，不读取、删除或迁移用户旧 JSON 文件 |
| CLI Adapter/envelope/loader、旧 runWorkerTask/Spawner | 生产已使用私有 Claim Worker 与 app-server；Worker 拒绝旧位置参数启动；共享 outcome 类型移到小型 type 模块 |
| GitWorktreeProvider | 当前 Host 提供执行目录，SQLite Admission 校验；无正式构造入口、未作为 Core 导出承诺 |
| Doctor JSON fallback、JSON observation builder | Doctor 只读绑定 SQLite；未绑定返回 unknown，不把旧文件当任务事实 |

生产 esbuild 依赖图 168 inputs，退役模块可达数 0。`src/store/lifecycle-gate.ts`、SQLite Store、v13/v14 Schema、Result 共享合同、任务期限和 MCP schema 相对基线未改；app-server Adapter 仅替换 outcome type import。这是退役，不是 R1–R5 重写。

保留 `json_artifacts`、历史 receipt/digest/result exception 校验、schema-v13.sql、显式离线升级：它们服务已经存在的 SQLite 数据。保留 JSON-RPC/canonical JSON/AgentReport/TaskResult。模型设置的旧目录查找属于安装兼容。`process-lock`/`atomic-rename` 仍用于设置/可选 Ledger；小型公开 DirectWorkspaceProvider、纯 observation/feedback/usage 工具仍有独立职责，不构成第二运行链。

## 覆盖与测试成本

逐文件/静态声明前后表见 [COVERAGE_MAP.json](COVERAGE_MAP.json)。其中 replacement 表示相应生产合同的当前覆盖文件，不声称复刻被退役 JSON 算法。

| 原验证职责 | 当前有效覆盖/退役理由 |
|---|---|
| JSON Store 文件发布、checkpoint、writer roster/drain、迁移 CLI、JSON retry generation | 对应实现整体退役；不为已删除协议新建等价测试 |
| B3-05：32 active/10,000 historical JSON 文件压力 | 退役。新的 SQLite 0/32/256 历史/WAL矩阵是另一工作负载，不是原基准等价认证 |
| Adapter provider/failure facts、turn 竞态、隐私、不可自动重试 | failure-facts-integration、batch2-evidence、app-server Adapter 原套件保留；用真实 Adapter callback 与 Normalizer 取代 JSON 写盘消费 |
| TaskResult 归一化 | 新 normalize-result 覆盖报告决策、非法/缺失报告、cancel usage、cleanup report candidate 与诊断过滤；R2 真实链路保持 |
| Worker generation/树身份/未知状态 | spawn-generation 纯世代测试及 windows-process-cleanup、windows-recorded-tree-native、windows-cleanup-review-regressions 保留；SQLite composition/MVP 覆盖真正 Claim 与 Manager 重启 |
| 大 interaction | SQLite lifecycle-port 新增完整多字节输入/超限不改 Claim；composition/MVP 保留真实 request/reply/ACK；旧 JSON preview/full_request 协议退役 |
| Attention/Thin Waiter | wait/snapshot 与真实 SQLite composition/MVP/Thin Waiter；新增 Manager 等待、cursor 先校验、queued cancel 场景 |
| Ledger review 与投影 | 公共 ProgressTaskManager 的局部 mock 测 Ledger 语义；真实生命周期由 SQLite composition/MVP 测，不保留假 Store |
| Selector/执行安全 | 既有 selector 回归保留；清单为唯一来源，MANUAL_E2E/Fixture 自动及误传拒绝，Attention 实际依赖和实际 --list 对账 |

默认完整功能回归不再隐式执行压力。SQLite 压力由显式 `test:stress`、targeted `test:affected` 的实际影响、或独立 Windows/Ubuntu CI job 触发。FULL_SUITE 报 SEPARATE_STRESS_GATE；原有 CI Verify 仍完整运行 npm test。未新增 SKIP、未提高 timeout、未放宽 Windows 身份断言。

新压力验证实际生产 Store：历史增长与独立 WAL reader snapshot/checkpoint、四个独立进程同一 Result CAS、八进程独立 Admission/八槽与第九个拒绝。并发碰撞允许明确 root_writer_busy；仅重试 untouched synthetic Admission，不重放 Claim/Launch。八进程压力项的标题含 same-path，但该项主要证明 Capacity；同/重叠路径互斥由保留的功能测试证明，不能单凭此项标题扩大结论。

## 前后指标与验证

| 指标 | R1–R5 集成基线（历史） | 本轮冻结候选（新执行/新计量） |
|---|---:|---:|
| src 文件（含类型/测试 seam，不含 bundle） | 108 | 96 |
| src physical LOC（CRLF 归一、末尾空白去除） | 37,134 | 28,366（-8,768，-23.6%） |
| src nonblank LOC | 35,248 | 26,923 |
| .test.ts/.test.mjs 文件 | 90 | 78（77默认功能 + 1独立压力） |
| 静态测试声明 | 949 | 725（Unit 203 / Integration 519 / Stress 3） |
| Windows实际运行项 | 1002 / 1000 PASS / 2 SKIP | 776 / 775 PASS / 1 SKIP |
| 完整门禁墙钟 | 2343.1s（Owner 集成基线） | 825.623s（减少 64.8%） |
| 压力 | JSON B3-05 695.904s，隐式全量 | SQLite 3项合计约11.343s；与selector/shared一起23项14.160s，单独/按影响触发 |
| Bridge bundle UTF-8 bytes | 1,790,755 | 1,593,755 |
| Worker bundle UTF-8 bytes | 1,274,604 | 1,152,884 |
| 实体ADR | 23 | 24（新增批准029；20完整有效 + 4部分有效） |

src diff +82/-8850；test diff +566/-11705。冻结候选整体 diff +38083/-79150，包含生成 bundle、inventory 和覆盖映射，不能当纯生产 LOC。桥接/Worker bundle 合计减少318,720 bytes（10.4%）；Thin Waiter和离线升级bundle不变。映射清单81项包含3个Fixture与压力项；静态声明与运行时子用例不同，不能直接比较。既有SKIP保留为 injected ENOTEMPTY 平台场景；另一个基线SKIP随对应JSON测试退役，没有新加SKIP。

默认完整回归的耗时减少含删除JSON压力的收益，不能据此声称SQLite单次执行性能提高。文档字节与完整文件/ADR列表见 [METRICS.json](METRICS.json)；这里的physical LOC使用trimEnd口径，不等同于未经处理的wc行数。

| 实际验证 | 结果 |
|---|---|
| 最终 Windows npm run test:full（Node v24.16.0，Windows 10.0.26100） | 776项，775 PASS，1既有SKIP，0 FAIL；typecheck/build/plugin validation通过 |
| R1–R5真实进程定向 | 16/16 PASS，176.194s；真实Windows Spawner/Worker/私有管道/Manager重启/取消/期限 |
| SQLite资源+selector+共享身份定向 | 23/23 PASS，14.160s；不是全量计数的额外相加 |
| 干净入口（含无repo-local依赖的shipped launcher） | 4/4 PASS，8.319s |
| 修正Skill边界 | 原7项断言7/7 PASS；不改测试，不改生产代码 |
| 本地npm pack/解包Core | 201 files，409,302 compressed bytes；旧运行时文件/导出0；新入口和历史Schema存在；依赖由候选node_modules解析，非外部fork安装认证 |
| 生产依赖图/本地Markdown引用 | 168 inputs、退役可达0；新增坏链接0，基线5→当前4（4处历史问题路径见证据JSON） |
| 交付文档 test:affected | T0 PASS；NO_TESTS_APPLICABLE，仅表示无适用执行测试，不算测试 PASS |
| 原生Ubuntu/远程CI/真实Host最大Result/外部fork升级 | NOT RUN |

压力历史档位0/32/256，256档当前任务read p95 0.1652ms；WAL 4,132,392 bytes，checkpoint后0；记录的maxRSS104,688KiB仅为该测试进程，不是8进程/整机峰值。四进程CAS只提交一次，保留一次永久Claim；八Admission终态八独立slot，第九个拒绝。该有界样本不认证任意历史规模、真实Provider负载或最大Result并发资源成本。

保留两项失败证据：首轮混合定向因impact map缺composition失败，修正后selector/依赖对账通过；第一次完整门禁776项/774PASS/1FAIL/1SKIP（828.511s），发现精简遗漏Skill的release-intent边界。恢复该仍有效说明并保留原断言后，重新冻结并完整运行得到上表最终结果。未用重跑掩盖未解释失败。

完整功能文件清单、最慢12项、运行摘要、未运行边界与日志SHA-256见 [VALIDATION_EVIDENCE.json](VALIDATION_EVIDENCE.json)。本地原始日志与逐项名称/耗时留在项目内 `.run/windows-full-final.log`、`.run/windows-final-cases.json`；基线全量是历史证据，本轮没有重新跑旧JSON基线。

## Git与交付身份

冻结验收Commit：`6b254089a49a112e9881d40813f16d96c079a582`；Tree：`cf2c30818225dda602199b990df367be64bb2138`。提交链为基线a46137fe → ad4ac4cd（退役）→78711eb8（类型模块EOF）→6b254089（恢复Skill边界），无cherry-pick/merge重放前序R1–R5。交付报告另作docs-only本地提交，最终SHA/Tree见交付回复；生产/测试源码与此冻结提交一致。

Worktree：`D:\codex-zcode-bridge\.run\legacy-runtime-retirement-20261106`；分支`codex/legacy-runtime-retirement-20261106`。根master/origin/master仍aabbb0a959ee234508c62731ed5122f28dfcf5b0；根既有.gitignore和$null未改动。本轮不Push/Merge/Tag/Release，不写生产SQLite，不处理未知Hold。

## 文档与兼容

ARCHITECTURE 只讲当前实现，INTERFACES 只讲当前合同，SHARED_CORE 列公共破坏与宿主布局，ADR 解释取舍。ADR-002/005/008/019 标 Partially superseded，历史正文和路径保留；两份旧 roadmap/repair plan 标 ARCHIVED。ADR-009/026/027/028 不改。基线索引 ADR-011 的原文并不在 Git tree，本轮撤掉坏链接并注明缺失，不伪造历史决策。

实体 ADR 23→24（新增已批准 029），其中完整有效 20、部分有效 4；没有为减少数量合并 ADR。Master 默认读 Skill 动作路由；实现诊断读 PROJECT_STATE，再按问题选 ARCHITECTURE/INTERFACES 和主题 ADR，不默认加载 archive/research/全部 ADR。6份路由/核心文档字节指标见 METRICS.json，不冒充真实 token A/B。

Marketplace MCP 名称/schema 和 SQLite v14 不变。公共 Core 删除 TaskStore、BridgeTaskManager/TaskManagerOptions、createWorkerSpawner、runWorkerTask/RunWorkerTaskOptions、buildTaskObservation，公开现有 SqliteLifecycleMcpAuthority/SqliteAuthorityOptions。Owner 已批准未来主版本发布；本轮版本字段仍 1.6.0，仅本地候选。外部 dsh/fork 若使用旧构造参数/JSON runner，需迁至 startBridge 或 SQLite 创建入口；本轮不修改外部仓库，不能宣称其已兼容。

## 遗留、发布门槛与回滚

- 本轮验收范围之外：原生 Ubuntu/远程 CI、外部 fork 迁移、真实 Provider 长时运行。Linux admin-abandonment 测试改为验证 windows_required 且 DB 逻辑事实不变，Windows 原成功/CAS断言保持；Linux分支未实跑。历史 QEMU MCP 超时原因仍不确定。
- 正式发布前：Owner 审核、主版本/消费者升级说明、实际必需 CI 平台门禁通过、确认安装制品与目标版本。当前远程/master未集成，不能直接把本地1.6.0 pack作为兼容补丁发布。
- Owner 已明确延后：Host 最大 Result 读取与1.1MB continuation 输入上限；本轮不做 Chunk/扩容。R6调度及R7普通Events/usage持久化缺口未修，不把JSON测试退役称为这些能力已完善。
- 回滚只切回 a46137fe 的代码/插件制品，先停止当前 Host/Worker、核对已完成清理；不重派未知 Operation，不清 Hold，不删除/替换数据库。Schema仍v14，没有本轮数据迁移可回滚。

最终只读快照未发现命令行引用本Worktree的残留node.exe；这是一份限定范围进程快照，不替代各生命周期测试的Cleanup证明。构建后8个关键制品的Git归一blob与冻结HEAD一致；仅恢复已逐个证明相同blob的换行重写。

完成本轮后停止，不进入 R6/R7，不发布。
