# SQLite Stage 2 v2 隔离预演报告

> Status: RESEARCH
> Last updated: 2026-11-01
> Last verified: 2026-11-01
> Verified against: `46cd3a541bc3c13ec7528d86d530afcb3f75686e`
> Scope: ADR-016 v2 的隔离预演、完整 JSON 原始归档、空 SQLite Authority、新任务真实生命周期；不包含生产切换

## 当前结论

ADR-016 v2 已把迁移合同收缩为“SQLite 负责未来、JSON 保留过去”：旧 JSON 只做完整、只读的原始归档，SQLite 从空数据库开始管理切换后的新任务。当前固定快照已完成隔离预演、真实新任务执行、Cleanup/Release、Continue/恢复的组合验证和正式构建；独立 Reviewer 已对证据包给出 `APPROVED`，此前唯一 P1（缺少当前快照的 typecheck / build:test 证据）已经关闭。

```text
ADR_016_V2: COMPLETE
README_USER_WARNING: COMPLETE
FULL_HISTORY_ARCHIVE: PASS
EMPTY_SQLITE_AUTHORITY: PASS
NO_HISTORICAL_SQLITE_PROJECTION: PASS
REAL_SQLITE_SINGLE_TASK_E2E: PASS
CONTINUE_AND_RESTART_COMPOSITION: PASS
INJECTED_FILE_RECOVERY: VERIFIED
STAGE_2: PASS
WORKSPACE_ADMISSION: CLOSED UNDER ADR-017 TRUSTED-LOCAL BOUNDARY
SQLITE_PRODUCTION_READINESS: BLOCKED
FULL_G6: NOT RUN
HISTORICAL_G6_ROOT_CAUSE: UNKNOWN
INDEPENDENT_REVIEW: APPROVED
READY_FOR_STAGE_3_OWNER_AUTHORIZATION: YES
PRODUCTION_AUTHORITY: JSON_ONLY
PRODUCTION_SQLITE: DISABLED
```

## 固定快照与证据边界

| 项目 | 值 |
|---|---|
| Worktree | `D:\codex-zcode-bridge\.run\sqlite-mainline-integration-20261031` |
| Branch | `codex/sqlite-mainline-integration-20261031` |
| HEAD | `46cd3a541bc3c13ec7528d86d530afcb3f75686e` |
| Tree | `a71717888527aafd260ca1cc315c7fa859a6d9f7` |
| Worktree index | `D:\codex-zcode-bridge\.git\worktrees\sqlite-mainline-integration-20261031\index` |
| Git index SHA-256 | `BE55711C3C5B2F482900F1AC7559588F795EBB346053F557D07567854686E5B6` |
| Node | `v24.16.0` |
| npm | `11.13.0` |

该快照是 `HEAD + 当前工作树 WIP`，不是纯 Commit Checkout。当前 WIP 包含 ADR/README、迁移实现、测试、正式 Bundle 和运行证据。本轮没有 staging、commit、push、merge、tag 或 release，没有修改生产 `.tasks` 或用户原始 Provider 配置，也没有切换生产 Authority。真实 ZCode E2E 使用隔离 HOME 中的配置副本和独立工作区。

## 合同文档

### ADR-016 v2

`docs/decisions/ADR-016-stop-the-world-json-to-sqlite-cutover.md` 的当前有效合同为：

- 停机停止 admission 和生产 writer，正常结束或安全处置已知 Worker。
- 对 `.tasks` 做完整原始字节归档，记录文件、目录、链接元数据和内容摘要；不跟随 Workspace 链接目标。
- 发布全新空 SQLite，不导入旧 Task、Attempt、Result、Event、Interaction、Workspace 或 Artifact 投影。
- `authority_switch` 绑定 source、archive、runtime roster 与 migration/cutover identity。
- staging 回读、marker 和原子发布失败时 fail closed。
- SQLite 接受新写入后不得恢复切换前的 JSON 快照。

v1 与 2026-10-31 的三处历史 Result 异常政策继续保留为可追溯历史记录，但 v2 的 raw archive 路径不再解析或投影旧生命周期数据。

### README 用户提醒

`README.md` 与 `README.zh-CN.md` 已加入停机迁移提醒：升级前完成或保存 `queued`、`running`、`waiting_for_master` 任务所需工作；旧任务不会自动恢复、续接或在 SQLite 中 Continue；SQLite 接受写入后不得恢复旧 JSON。

## 完整历史归档

权威全量预演为 r7。源数据从真实 `.tasks` 的隔离副本生成，不以之前 31 Task 的样本或 r5/r6 的旧证据代替。

| 项目 | 值 |
|---|---|
| 证据根 | `D:\codex-zcode-bridge\.run\stage2-v2-r7-20261101` |
| 源 Task 目录 | 697 |
| 源文件 | 17,387 |
| 源字节 | 1,700,845,874 |
| Reparse point | 0 |
| `--prepare` | `status=sealed`、`sealed=true`、`blockers=[]`、退出码 0 |
| `--apply` | `status=published`、退出码 0、无 staging residual |
| Source root digest | `f28c27fa4448805ef9e8860b5c0fa2f13c12f3c305a116e54741bbbacb516588` |
| Source Manifest digest | `ec957abe68e8754de2f78645cd4d542bbe2aa9056663b6cdce4c9b6636d5b4e3` |
| Archive Manifest SHA-256 | `2F0DBA8D3525A49EEDE026794D1309D9AA2BAE094B8282C918E01472BB3F2731` |
| Published DB SHA-256 | `68391835AE21E32B616AB67748FCD06D08A181BA9CE646CB96E97A7185225B7A` |
| Publication receipt SHA-256 | `37F2735E56706B17F0605D2456E5E198D0B39D3311B32238996D42604222C3B1` |

Archive Manifest 共 20,319 个文件和目录条目，其中源文件数与源字节数分别绑定为 17,387 和 1,700,845,874。完成 r10 后再次只读枚举归档 payload，并在跳过 reparse point 的条件下得到相同的 17,387 个文件与 1,700,845,874 字节，Manifest 的 2,932 个目录条目以及 0 个其他类型条目也与结构一致。该次数量核验位于 `.run/stage2-v2-r10-20261101/e2e-r10/evidence/archive-count-verification.json`。

清单中实际包含：

| 历史异常 | 数量 | 关键证据 |
|---|---:|---|
| 三处历史 Result 身份异常 | 3 | 三个原始 Result 均在归档中，SHA-256 与隔离副本逐一相同 |
| 旧格式 Interaction 文件 | 3 | 原始 Interaction JSON 保留，不进入 SQLite |
| `respawn.claim` | 7 | 原始文件全部保留，不作为 SQLite Claim 导入 |
| `worker-stderr-repro.log` | 1 | 原始替代 stderr 文件保留 |
| Workspace 历史内容 | 3,798 个清单条目 | 作为原始目录和文件归档；未遍历或修改外部链接目标 |

三处 Result 的归档哈希分别为：

- `CAD2BIM_FULL_AUDIT_RM02_001/attempts/3/result.json`：`539C76D236155688FEB906A8DFB9764F92A2F76FF8E16B97E6177C2E7BD95530`
- `CAD2BIM_FULL_AUDIT_RM02_001/attempts/4/result.json`：`EC6FAEA33C6B3B7C299B2C4A6094C431B670D807E00398ED03364EC5A1C61CD3`
- `PROJECT-ALIGNMENT-DOC-HYGIENE-CLOSE-1-COMMIT-20260930/result.json`：`494235A230178FE2AEB0128210BBA0CF8FEC5029202B07B0A1B3648476D3E12E`

## 空 SQLite Authority

对 r7 发布的数据库进行了只读完整性查询，结果如下：

- `PRAGMA integrity_check = ok`
- `tasks = 0`
- `attempts = 0`
- `json_artifacts = 0`
- `migration_runs = 1`
- `authority_switch = 1`
- `manager_operations = 1`

Apply 输出中的 `artifact_count=17387` 表示归档中收到的原始源文件数量；在线 `json_artifacts` 表为 0。旧 Task、Attempt、Result、Event、Interaction 和 Workspace 数据没有进入 SQLite 在线生命周期。

## 构建与定向验证

当前源码与编译测试、正式产物身份一致：

| 产物 | SHA-256 |
|---|---|
| Manager source | `2717DC1996CB4585E3D482E1A8219B191AB6CC2C19C9B7BD00DBB5EF93E70053` |
| Manager compiled test input | `6ABBBB261D023FEFBB470FB3AE4FC4526DAC3B122BCC81A584DC43B26A65C0C8` |
| Composition test source | `8A82A07EEEC1B69CEFA8988B038D43F9AE11FBE3CACD0E1068EA83415F887DB7` |
| Composition compiled test | `2D851DAEB63EEEF7EA05A6F40DBB5CA5956F1E85B54C76D782CF7E998CF1BE85` |
| Bridge Bundle | `6D2E1FF104865780362D474946C2C93E1317EBF437DB615B1758D2C144D28AE6` |
| Worker Bundle | `DE2924CDEBBD367B968C788F4794745BBBDF3638B1B624CFB40B788678BBE6A4` |
| Browser host | `B750AEFF5CAE48D6CDB71E068B0B8D96592CBA52B57A514FEDAD515615C55B4E` |

构建证据位于 `.run/stage2-v2-r9-20261101/build-and-plugin/identity.json`。`npm run build` 与 `npm run validate:plugin` 的 r9 原始证据退出码均为 0。为关闭独立复审指出的证据缺口，又在本报告最终快照上各执行一次：

| 命令 | 开始 UTC | 耗时 | 退出码 | 证据 |
|---|---:|---:|---:|---|
| `npm run typecheck` | `2026-11-01T00:50:37.577Z` | 8,092.772 ms | 0 | `.run/stage2-v2-r9-20261101/build-and-plugin/missing-command-evidence-20261101/typecheck/` |
| `npm run build:test` | `2026-11-01T00:50:45.747Z` | 10,252.840 ms | 0 | `.run/stage2-v2-r9-20261101/build-and-plugin/missing-command-evidence-20261101/build-test/` |

两条命令都保存了实际 argv、cwd、stdout/stderr 和 execution JSON。命令前后 HEAD、Tree、Index、Manager 源码/编译件、Composition 源码/编译件以及三个正式 Bundle 的 SHA-256 均未变化，记录在 `.run/stage2-v2-r9-20261101/build-and-plugin/missing-command-evidence-20261101/preflight.json` 与 `postflight.json`。

### Shutdown race 修复验证

Manager 现在会区分“Result 已终态但 Cleanup/Release 仍在 active run 内完成”和“任务仍未终态需要取消”：

- 目标用例 `formal MCP Host shutdown lets a committed Result finish Cleanup without cancelling the terminal Attempt`：1/1 PASS，退出码 0。
- 完整 Composition 文件：28/28 PASS，0 FAIL，0 CANCELLED，0 SKIP，退出码 0，耗时 124,258.8955 ms。

该文件在同一编译快照上覆盖 Create/Worker/Result/Continue/Events/Feedback、Host shutdown 前后 Continue、queued/running Cancel、重启 Recovery、Cleanup/Release 和 SQLite Authority 空启动。

## 真实隔离 SQLite E2E

权威当前真实 E2E 为 r10：

`D:\codex-zcode-bridge\.run\sqlite-mainline-integration-20261031\.run\stage2-v2-r10-20261101\e2e-r10`

| 项目 | 实际值 |
|---|---|
| Runner | 隔离的 graceful MCP SQLite runner |
| Runner SHA-256 | `CE362869FE64D59501A08A595CB35C272710A991E7E056F87095B0E1F95D4F51` |
| Provider | `account:bigmodel-individual-coding-plan` |
| Model | `GLM-5.3-Flash` |
| Task | `sqlite_v2_e2e_r10_20261101` |
| Attempt | 1 |
| Runner exit code | 0 |
| Task 终态 | `completed` |
| Worker result exit code | 0 |
| Result digest | `666b08bad5aed99f2945c62d07c9d4f73f957f1fda146e191df3c1c975db40c6` |
| Interaction | 3 records；包含允许的 Write、被精确 allowlist 拒绝的 Bash、允许的原样验证 Bash |
| 事件终态 | `result_committed → cleanup_pending → cleanup_verified → released` |
| Operation | revision 23，`phase=released` |
| DB SHA-256 | `01F1EC33BBB1C3B3B1810F5CFF668C618455C7E8D569F3610568EC1EF279C17C` |
| SQLite integrity | `ok` |
| Shutdown observer | `timed_out=false`、`exit_code=0`、`signal=null`、`stderr_cleanup_failure=false` |

Bridge stderr 记录本次运行的 Bridge/Worker SHA-256，与当前正式 Bundle 一致，并显示 SQLite Authority 正常启动；没有 Cleanup failure 或 EOF shutdown retained 警告。

第一次 Bash 请求添加了额外 shell 逻辑，由精确 allowlist 正确拒绝。随后只执行任务指定的验证命令并成功。这是安全拒绝行为，不是失败被忽略。

Result API 的 `status.execution_observation` 保留 Result commit 时的时间点快照 `cleanup_held`；之后权威生命周期事件继续到 `cleanup_verified` 和 `released`。最终 Operation 回读为 `released`，不能把较早的 observation 快照解释为最终未释放。

### Continue 与 Host 重启

r10 是单 Attempt 的真实 ZCode E2E，没有在此次 Provider 运行中创建第二 Attempt。Continue 和 Host 重启由同一最终编译快照上的正式 MCP Composition 覆盖：

- `formal MCP Manager routes SQLite Create/Worker/Result/Continue/Events/Feedback without JSON writes`
- `startup dispatches only the persisted current queued Attempt and resumes its untouched reserved Operation`
- `formal MCP Continue survives Manager shutdown before Spawn and is dispatched once by the restarted Manager`
- `stdio Host restart keeps a persisted active Operation Root-held without replay`
- `formal SQLite MCP stdio shutdown closes only after verified Cleanup and Release`

这些是受控集成证据，不冒充第二次真实 Provider 执行。报告分别保留真实单任务 E2E 与受控 Continue/重启证据的边界。

## 本次事故与恢复

r9 的 E2E 预检期间，PowerShell 的只读 `$HOME` 使两个测试 Authority 文件被写到用户目录。E2E 尚未启动，也没有访问生产 `.tasks` 或真实 Provider 相关操作。

Owner 明确批准删除两个测试注入文件。删除后核验：

- `C:\Users\Sandy\.codex\codex-zcode-bridge\authority.json`：不存在
- `C:\Users\Sandy\.codex\codex-zcode-bridge\trusted-local-policy.json`：不存在

原 ZCode 配置未被修改：

| 文件 | SHA-256 | Last write UTC |
|---|---|---|
| `config.json` | `8E23382A84395BB6AC46FBC34F94E1A7148CBF239F0B1185A401F56EF280A0BD` | `2026-09-17T10:42:15.0918762Z` |
| `provider_config.json` | `E7C11299DE23CCB948F162D0373C8C1D8F3012DFBFD1BCCE87B3F955256D95` | `2026-10-31T04:47:45.2946021Z` |

事故记录与删除后核验分别位于：

- `.run/stage2-v2-r9-20261101/e2e-r9/PRECHECK_INCIDENT.json`
- `.run/stage2-v2-r10-20261101/e2e-r10/evidence/injected-file-recovery-verification.json`

## 进程审计

在 r10 完成后重新使用 Windows `Win32_Process` 对 Node、npm、npx、PowerShell 和 pwsh 进行命令行归属审计：

- 已识别本工作树、Stage 2 证据根、隔离 Runner、真实 Adapter 或 E2E runner 的可归属测试进程：0
- 未终止任何未知或真实 Codex/Bridge 进程
- 审计未声称能够从 Windows CIM 推断所有进程的当前工作目录

审计结果位于 `.run/stage2-v2-r10-20261101/e2e-r10/evidence/process-audit-after.json`。

## 未完成与阻断

- Workspace Admission 的阻断已按 ADR-017 的单用户可信本地边界关闭：生产 SQLite 启动要求 Host 发放能力并加载 Owner policy；路径必须位于已配置的本地盘符根内，并在使用前重新解析。旧 WP6D 的原生稳定文件身份、完整祖先链和同账户路径替换竞态保护仍未实现，明确不在 v1 信任边界内。
- 本轮没有运行完整 G6；定向测试、构建、归档预演和 E2E 不能替代完整回归。
- 本轮没有执行真实生产 `--prepare`、`--apply`、Authority 切换或生产数据迁移。
- 历史 G6 的根因仍为 `UNKNOWN`。
- 生产 Authority 仍为 `JSON_ONLY`，生产 SQLite 仍为 `DISABLED`。

## 下一门禁

独立 Reviewer 已对固定源码/WIP、ADR/README、r7 完整归档、空 Authority 回读、r9 定向验证和 r10 真实 E2E 给出 `APPROVED`。新增的 `npm run typecheck` 与 `npm run build:test` 证据均为退出码 0，且绑定同一 HEAD/Tree/Index、源码、编译测试和正式 Bundle 身份；这关闭了此前唯一 P1。

因此 Stage 2 已达到通过条件，可以请求 Owner 单独授权 Stage 3。Stage 2 代表单用户可信本地边界下的 Workspace Admission 规划已由 ADR-017 明确，不等于完整 G6 通过，也不等于生产 SQLite 切换获准。
