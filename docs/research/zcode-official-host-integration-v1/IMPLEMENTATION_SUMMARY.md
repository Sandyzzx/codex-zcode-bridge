# ZCode 官方 Host 集成实施摘要

> Status: RESEARCH — PREVIEW.4 IMPLEMENTATION CANDIDATE / PR-READY
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对候选 Worker、固定上游制品、最终完整隔离回归、提交后 clean checkout 与当前候选 Astra review
> Verified against: Bridge candidate `ba25f837` + final documentation/artifact completion
> Applicability: HISTORICAL — Preview.4 / ZCode 3.18.0 candidate evidence. This report does not describe the current ADR-037 ZCode 3.18.2 local candidate, its fixed Host/BOM, or its acceptance state.

## 当前结论

ADR-032 的官方 Host 拓扑已经进入 `2.0.0-preview.4` 源码候选。生产 Worker 的 `zcode_app_server` 路径在 Windows x64 默认装配 `OfficialHostAdapter`；固定官方 Host module 管理 AppServer 与 Windows helper，Bridge 继续持有 SQLite Authority、Claim、Result、Hold、Recovery、Cleanup 和 Release。

候选没有 Companion 服务、Companion IPC、第二套账户数据库、平行 RuntimeAdapter 或 Shared AppServer Pool。直接 AppServer selector 仅为现有跨平台路径与 test-only 回滚 smoke；它不能通过任务输入、环境变量或持久设置改变 Windows x64 的生产选择。

## 已实现

- `OfficialHostAdapter` 继承 `ZCodeAppServerAdapter`，保留现有 Adapter、Worker 私有管道和公共 MCP 合同。
- 官方 `ZCodeAgentProcessManager` 独占正常 Runtime/AppServer/helper 启动与关闭。
- 固定制品验证 Host module、AppServer、provider、NOTICE、helper 和六个 keyring 闭包文件；入口不能由用户环境或持久设置重定向。
- Runtime root exact identity、Worker exact identity、recorded-tree claimant scan、resource facts、Cleanup Digest 和 Release CAS 串接。
- close result、close failure 与 Cleanup verdict 分开保留；Adapter 未启动时只能生成受限 proof。
- 16 MiB raw UTF-8 frame 上限通过 `maxFrameBytes` 传入固定 upstream transport。
- 固定上游包含 profile-scoped OAuth refresh coordination 和 account runtime-header coordination。
- Preview.4 生产 Lifecycle Gate 在 bootstrap lock 内自动升级 v13→v14，并保留 running Attempt、Hold、events 和 digest。
- six-file `@napi-rs/keyring` native closure/license/metadata 已由提交后的 clean checkout 证明可解析并加载，Host exports 也可动态导入。

## 证据结果

| 项目 | 状态 | 证据 |
|---|---|---|
| 固定源码/制品构建 | `PASS` | Windows x64、Node 24.16.0；两次输出、BOM、provenance 一致 |
| same-source-tree rebuild | `PASS` | Host module byte-identical |
| Adapter/Worker 定向 | `PASS` | 32/32 |
| 路由、SQLite、影响选择定向 | `PASS` | 64/64 |
| SQLite real-adapter | `PASS` | 47/47 |
| upstream frame | `PASS` | 7/7 |
| upstream account | `PASS` | 12/12 |
| 完整回归 | `PASS` | 最终 `FULL_SUITE` 936 项：935 pass、0 fail、1 skip |
| SQLite stress | `PASS` | 3/3 |
| clean checkout build/load | `PASS` | 从候选提交新建 detached checkout；`npm ci`、typecheck、build、plugin validation、Host exports 与 keyring native load 通过 |
| 当前候选独立 Astra review | `APPROVED` | 审查实际源码、diff、BOM、原始 Git bytes、Host/native 加载与测试证据；未发现本候选引入的 P0/P1/P2 |
| 真实 OAuth/账户/模型/Start Plan/Billing | `NOT_RUN` | 所有 Provider 只指 loopback Mock；请求数为 0 |
| 生产 schema migration | `NOT_RUN` | 仅执行隔离 SQLite v13→v14 |
| 跨 upstream 版本升级与生产回滚 | `NOT_RUN` | 当前只冻结 ZCode 3.18.0；不伪造第二版本 |

## 固定输入

- ZCode `3.18.0`，commit `b95ebaffeab641907b38652f45c1502bd762972d`，tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`
- AppServer `0.17.1`
- 构建/验证 Node `24.16.0`，Windows x64
- 三个有序 patch，bytes 与 SHA-256 见 [制品 BOM](SOURCE_ARTIFACT_BOM.md)
- Host module：1,821,168 bytes，`3F481AAE16EFF9912DAF17178B49491BD64E67C4419BFFDB59EB4B78E85EB537`
- BOM：7,260 bytes，`B9A7104DAB3B10250CA93899324C0B33966E64C0BE02F279A1353BABBA8F129C`
- 制品构建不使用用户 Desktop 安装作为输入，也不修改 fixed source tracked bytes。

## 剩余限制

- 没有真实账户和远端服务授权，因此真实 OAuth rotation、Start Plan、模型和 Billing E2E 保持 `NOT_RUN`。
- 当前候选只声明 Windows x64 / Node 24.16.0 host bundle；其他平台走既有路径或 fail closed。
- 性能样本仍是受控合成路径，不能据此宣布产品总体更快。
- 下一上游版本的正式升级和安装级回滚需要在有第二个批准制品后执行。
- 逐项再分发的法律/Owner 批准超出工程技术验证。
- `npm audit --omit=dev` 的 `@modelcontextprotocol/server` 与 `zod` high advisories 是
  `origin/preview` 既有依赖基线，需独立的安全发布流程处理。

## 证据位置

- `.run/final-evidence-20261112/`
- `.run/performance-benchmark-20261112/evidence/summary.json`
- `.run/official-host-clean-20261112/`
- [Test Coverage](TEST_COVERAGE.md)、[Regression Report](REGRESSION_REPORT.md)、[Final Acceptance Report](FINAL_ACCEPTANCE_REPORT.md)
