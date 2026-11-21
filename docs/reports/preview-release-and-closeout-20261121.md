# Preview 2.0.0-preview.10 Release and Closeout

> Status: RESEARCH
> Date: 2026-11-21
> Base: `origin/preview` `c1245a02f8f9d4b6e1102eabac230b657d85de9b`
> Integration branch: `codex/preview-release-20261121`
> Integration worktree: `D:\codex-zcode-bridge\.run\preview-integration`
> Preview integration merge: `0f8a6189ba17fe38e20ef24d7f15815515d1b065` (PR #109)
> Cost Lab CI repair merge: `22fc7a64f1e79c2c555cb7069183e83795959f99` (PR #110)

## 1. Integration Route

本次发布从实际 `origin/preview` 基线建立独立集成 Worktree，按依赖顺序合并已完成的候选，
没有把任一功能分支直接覆盖到 Preview。

| 候选 | 分支 HEAD | 集成提交 | 结果 |
|---|---|---|---|
| CI optimization | `09ccc5c03c79bb76cd861b3ded383a9df9a12b40` | `0b2d3121b` | 合并 |
| SQLite v13 retirement | `304a2ed0cedeb29aad162cc5eb3fb96f98fe1336` | `bc7bdfb32` | 合并 |
| Legacy retirement | `90ec182140d66a142b114ececdc7e4aec70c0673` | `eee6d8d4e` | 合并 |
| Wake research archive | `b9ffd229c4fe9e6edd56e463847ade18bd4c843d` | `ce74deb41` | 合并 |

SQLite v13 合并只在 `docs/testing/README.md` 与生成 inventory 发生冲突；README 元数据逐项
对账，inventory 从合并后的源码重新生成。CI 分片、v13 资产清理和 Legacy 清理均保留。

候选分别通过 PR #100、#106、#107、#108 合并。最终集成通过 PR #109 合入 `preview`，
merge commit 为 `0f8a6189ba17fe38e20ef24d7f15815515d1b065`。PR #109 的代码树 CI
`44856268724` 通过，但合入后的 Preview Push CI `44857084790` 暴露了一个真实平台门禁缺陷：
Cost Lab job 在 Ubuntu 执行，而其中 4 项合同要求 Windows 官方 Runtime/路径语义。

该缺陷由 PR #110 修复，只把 Cost Lab job 固定到 `windows-2022`，并增加 Test Impact
Selector 回归断言；没有修改生产 Bridge、Runtime Auth、Official Host 或 Cost Lab 测试断言。
PR #110 merge commit 为 `22fc7a64f1e79c2c555cb7069183e83795959f99`，最终 Preview Push CI
`44858240150` 全部通过。

发布报告 PR #111 又暴露了 CI 治理缺陷：文档-only PR 的分支保护要求 4 个全量检查上下文，
但影响选择器正确地把这些 job 标为 `skipped`，GitHub 因此拒绝合并。手工在同一 SHA 触发
workflow dispatch 后检查通过，但分支保护仍不接受该事件产生的上下文。

修复提交 `1ba2e728c620f2a0f2abd2bd02109fc2f3057e95` 保持完整测试仍由影响选择器决定，
但让 4 个受保护 job 在所有非 Draft PR 上实际产生结果：需要全量时执行测试，不需要时只执行
明确的 non-full receipt。Fast、Integration、Cost Lab 的选择规则和生产测试合同未改变。
该提交按 `.github/workflows/** -> FULL_SUITE` 规则执行了完整 PR CI，run
`44860645182` 全部通过。

## 2. Release Scope

Preview.10 的核心变更是：

- SQLite 生产支持统一为 `SQLite v14 ONLY`。
- 删除 v13 自动升级、离线升级、升级 CLI、Schema 与升级成功路径测试。
- v13 数据库与旧升级 Marker 采用非破坏性拒绝。
- 旧 JSON Authority 提示以稳定错误退役，不恢复 JSON 读写路径。
- 删除无引用的 ZCode 3.18.0 patch 资产。
- CI 增加同 PR 过期运行取消、Draft/Ready 分流、Cost Lab 独立门禁、
  Test Impact 精确化和 Windows 两路分片。
- Preview 的认证、Official Host、SQLite v14、Task/Attempt/Recovery、
  Cleanup/Release 和 Cost Lab 合同保持不变。

## 3. P1 Risk Disposition

### F-01 `pumpFailure` 会话内不可恢复

状态：`FIXED`

未预期 Pump 异常仍立即关闭新派发入口，但 Manager 现在安排一次 250 ms 有界延后的自动
`recoverTasks()`。恢复成功时清空闩锁并从 SQLite 持久 queued Attempt 恢复派发；恢复再次
失败时保留闩锁，不创建无限后台重试。Shutdown 会清理 retry timer。

定向回归覆盖：

- 首次 Pump 失败后，一次自动 Recovery 成功并重新派发持久 Attempt。
- 自动 Recovery 再次失败后，状态继续 fail closed，且不产生第二次派发。

### F-02 Stable/Preview Recovery 语义与 ADR-037 编号分叉

状态：`FIXED`（Preview release scope）

[ADR-044](../decisions/ADR-044-preview-lifecycle-recovery-reconciliation.md) 冻结编号映射：
Preview `ADR-037` 继续表示官方认证复用；Stable Host Recovery 文件在后续跨分支对账时使用
`ADR-044`。本发布不机械 cherry-pick Stable `d9e24a0f2`，而以当前 Preview 的同一 Manager
重复 Recovery、active run 延后、Operation-scoped Hold 和既有测试作为语义证据。

## 4. Verification

最终验证针对同一个候选代码树执行；不重复运行没有新增价值的完整套件。

| Gate | Result |
|---|---|
| Typecheck | PASS |
| Core + plugin build | PASS |
| Plugin validator | PASS |
| Test inventory | PASS, 896 declarations / 99 mapped files |
| F-01/F-02 focused scheduler regression | PASS, 7/7 |
| Generated artifacts | PASS, 10 files |
| Clean entrypoints | PASS, 4/4 |
| Test impact selector | PASS, changed tree selected `FULL_SUITE` |
| Final local complete regression | PASS, 962 tests / 960 PASS / 0 FAIL / 2 SKIP / 20m28.398s |
| PR #109 CI | PASS, run `44856268724` |
| PR #109 post-merge Preview CI | FAIL, run `44857084790`; Cost Lab platform gate defect reproduced |
| PR #110 CI | PASS, run `44857443617` |
| Final Preview Push CI | PASS, run `44858240150`, commit `22fc7a64f1e79c2c555cb7069183e83795959f99` |
| Release report PR #111 full PR CI | PASS, run `44860645182`, commit `1ba2e728c620f2a0f2abd2bd02109fc2f3057e95` |

已有候选证据仍按各自 PR 报告保留，不把候选分支的 PASS 冒充本集成树已经完成验证。

首轮 `npm run test:affected -- --base origin/preview` 在 27.8 分钟内运行 962 项测试，
结果为 958 PASS、2 FAIL、2 SKIP。两项失败均已定位到集成树兼容问题：

1. Windows 分片计划仍引用 SQLite 退役时已删除的
   `test/sqlite-v14-upgrade.test.mjs`。修复为删除该分片项并同步估算值。
2. Windows root-exit 正向测试在全量负载下可能遇到生产扫描器对已退出 PID 被复用或仍保留
   live parent edge 的保守拒绝。测试现在使用至多三个全新的受控 root，只有真实原生扫描返回
   `verified` 时才断言成功；生产扫描器、失败语义和断言均未放宽。

修复后的定向证据：

- Shard plan test：PASS。
- 对应 Windows root-exit 正向测试：PASS。
- `dist-test/test/zcode-app-server-adapter.test.js` 完整文件：38/38 PASS。

包含这两项修复的最终代码树 `7886d42903f0c0f6dc8baa77d6df758a86bb2666` 已重新执行
`npm run test:affected -- --base origin/preview`，模式为 `FULL_SUITE`。结果为
962 项、960 PASS、0 FAIL、2 SKIP，耗时 20 分 28.398 秒；Typecheck、Build、Plugin
Validator、Generated Artifacts 与 `git diff --check` 同样通过。后续仅允许追加报告事实，
不得借发布收尾修改生产代码。

PR #110 的第一次 Windows SQLite 门禁出现一次资源竞态失败：
`interaction request was not observed for mvp-stream-stress-...`。相同测试代码在该提交上
本地连续运行 3 次均为 PASS（合计约 87 秒），随后仅重跑失败的 GitHub Actions failed job，
整个 run `44857443617` 通过。该事件没有伴随超时放宽、断言删除、SKIP 或生产代码修改，因此
记录为一次未复现的 Windows 资源竞态，而不是产品修复或稳定成功。

PR #111 首次同 SHA 全量 workflow dispatch `44859303456` 的 Windows SQLite matrix 又出现一次
不同表面的并发失败：八个 Admission 中一个子进程返回 `EPERM`，而测试只接受
`root_writer_busy`。失败 Job `136708733895` 的原始日志已保存；同一提交本地完整
`npm run test:stress` 连续 3 次 PASS（32.975s / 33.247s / 31.431s）。随后只重跑该失败 Job，
run attempt 2 全部通过。该事件继续归类为 Windows 文件句柄/并发资源时序风险，未通过修改
测试预期、增加 SKIP 或删除断言处理。

## 5. Compatibility Matrix

| 能力 | Preview.10 状态 |
|---|---|
| Windows x64 + Node.js `24.16.0` | 支持边界 |
| ZCode Desktop `3.18.2.10443` | 历史真实 E2E + 合成回归；本机新鲜 3.18.2 E2E `NOT_RUN` |
| ZCode Desktop `3.19.0.10774` | `EXPERIMENTAL`；不提升为 VERIFIED |
| Coding Plan | 历史真实执行与约 `0.67x` 计费证据保留；本发布不发起新模型请求 |
| Start Plan | `DEFERRED / NO_ACTIVE_PLAN`；不声明当前 live 兼容 |
| SQLite | v14 ONLY；existing v14 历史数据保留 |
| JSON Authority | 旧配置稳定拒绝，不读写 JSON Authority |
| v13 DB / old marker | 非破坏性拒绝 |

## 6. Release Identity

本节在 Preview 推送与要求 CI 通过后替换为最终事实。

```text
PREVIEW_VERSION: 2.0.0-preview.10
PREVIEW_CODE_HEAD: 22fc7a64f1e79c2c555cb7069183e83795959f99
PREVIEW_CODE_TREE: a323611036698c338d573662d372a9b33f3d0c40
RELEASE_COMMIT: ASSIGNED AFTER FINAL REPORT MERGE
RELEASE_TREE: ASSIGNED AFTER FINAL REPORT MERGE
TAG: codex-zcode-bridge-preview-v2.0.0-preview.10
RELEASE_URL: https://github.com/Sandyzzx/codex-zcode-bridge/releases/tag/codex-zcode-bridge-preview-v2.0.0-preview.10
ZIP_SHA256: PENDING
```

发布资产必须从 Tag 指向的提交独立生成，不复用 Preview.9 ZIP。资产包含插件 ZIP 与
`.sha256` 文件，并在隔离目录验证 Manifest、clean entrypoint、MCP 初始化、工具列表和版本。

## 7. Repository Closeout

清理只在 Release 与产物验证成功后执行。清理前记录 Worktree、本地分支、远程分支、磁盘占用
和受保护 WIP；只移除干净、已合入 Preview、无活跃进程的 Worktree。主工作区
`M AGENTS.md` 与 `?? $null` 保持不变，PR #100 Worktree 的 vendored keyring 删除因 dirty
状态保留。

```text
WORKTREES_BEFORE: 43
WORKTREES_AFTER: PENDING
LOCAL_BRANCHES_BEFORE: 42
LOCAL_BRANCHES_AFTER: PENDING
REMOTE_BRANCHES_BEFORE: 19
REMOTE_BRANCHES_AFTER: PENDING
ROOT_WIP_PRESERVED: YES
PRODUCTION_SQLITE_UNTOUCHED: YES
```

## 8. Known Gaps

- 本机当前安装 ZCode 3.19.0；没有以新鲜 3.18.2 安装证明发布时回归。
- Start Plan 没有 active plan，真实 live E2E 继续 `DEFERRED`。
- 3.19.0 Coding Plan 倍率仍 `INCONCLUSIVE`。
- 真实 OAuth refresh/账户轮换和一般 Desktop Main 独立性仍不是本发布新增证据。
- GitHub Actions runner-minutes 的官方账单值未测得；CI 报告只使用可核实的 Job 墙钟与
  近似 runner-minutes。
- PR #110 首轮 Windows SQLite 资源竞态在相同代码上未复现，失败 Job 重跑通过；保留为
  Windows runner 资源时序风险，不宣称已经修复。

## 9. Final Status

```text
GOAL: PREVIEW_RELEASE_AND_REPOSITORY_CLOSEOUT

V13_RETIREMENT: MERGED
LEGACY_RETIREMENT: MERGED
CI_OPTIMIZATION: MERGED

PREVIEW_VERSION: 2.0.0-preview.10
ALL_REQUIRED_CI: PASS ON CODE HEAD 22FC7A64
RELEASE_ASSET_VERIFICATION: PENDING
CLEAN_INSTALL: PENDING
STABLE_UNCHANGED: YES

UNMERGED_WORK_PRESERVED: YES
ROOT_WIP_PRESERVED: YES
PRODUCTION_SQLITE_UNTOUCHED: YES

FINAL_VERDICT: PENDING
```
