# SQLite Doctor + Test Impact Gating 统一整合与最终验收

> Status: RESEARCH（隔离候选验收记录；不是发布记录）
> Date: 2026-11-03
> Baseline: origin/master `879568c211bac6233817acc90923e23d7861ca79`（1.4.0）
> Worktree: `D:\codex-zcode-bridge\.run\sqlite-doctor-test-gating-integration-20261103`
> Branch: `codex/sqlite-doctor-test-gating-integration-20261103`

## 裁决

**PASS — ISOLATED CANDIDATE（修订版）。**

两套工作已完整整合到同一未提交候选；SQLite doctor、Test Impact Gating 和
Windows close 稳定性修复通过修正后的完整 `npm test` 与其中的 B3-05。没有
提交、推送、合并、发布、替换安装插件或写生产 SQLite。Task78 Recovery Hold
没有释放。

## 修订记录

第一轮验收所称 713 项“完整回归”实际来自旧的顶层 glob
`dist-test/test/*.test.js`，没有执行嵌套目录中的 inventory-mapped integration
tests。因此它只能作为历史窄选证据保留，不能改写为完整 Inventory 回归。
独立复核后把默认入口扩大为 `dist-test/test/**/*.test.js` 并重跑。

第一次真正扩展回归为 **FAIL**：806 项，797 pass、7 fail、2 skip，耗时
1,531,883.027 ms；日志保留在
`.run/evidence/gate2-retry-full/test.log`。七项失败随后逐项修复并复测：

- `sqlite-fresh-install` 六项失败来自 Windows staging journal 达到 legacy
  MAX_PATH。fixture root 改为候选内较浅的
  `.run/sqlite-bootstrap/fresh-install-<uuid>`。
- `mvp-real-adapter` 一项失败来自 fake runtime 与生产布局不一致，导致
  `provider_config_missing`。entrypoint 与 builtin config 改到
  `resources/glm/`、`resources/config/provider/`。
- composition integration 的深 fixture root 改为 `.wp6i`，并同步更新过时的
  “JSON 默认 Host”断言为当前 SQLite Authority 绑定合同。

修正后的第二次扩展回归为 **PASS**：806 项，804 pass、0 fail、2 个既有
SKIP，耗时 1,395,494.5134 ms；日志与 SHA256 见最终门禁表。

发布 PR 的首次 Ubuntu CI 在 803 项中出现 32 个失败、717 pass、54 skip，
失败全部集中于 POSIX 不支持的 Windows exclusive-file-handle bootstrap 与
Windows-local Trusted Local Policy 路径。代码合同本身明确在 POSIX fail-closed；
修订后的测试 runner 在 POSIX 显式排除这 8 个 Windows-only 集成测试文件，并
打印排除清单。Windows runner 继续执行全部嵌套测试，覆盖全部 806 项。此次
平台分流不增加测试内 SKIP、不改断言，也不修改产品平台合同。

## 会话故障与对应修复

目标 LumeCAE Master 会话中，Task78 的原 Worker 进程已不存在，但 Bridge SQLite
仍记录 running；`zcode_cancel` 与 `zcode_interaction_reply` 返回
`recovery_latch_persisted`。安装版 `zcode_doctor` 打开 JSON TaskStore，因此误报
没有运行任务、没有恢复锁，无法解释 SQLite 权威中的 Hold。

ADR-022 让生产 Host 把同一个 SQLite Authority 的只读诊断回调绑定给 doctor。
同一只读事务提供 Task 投影、Operation、Recovery 分类、一致性结果和当前
Manager fence；读取失败或未绑定时输出 unknown/error，不回退 JSON。公共 MCP
输出形状不变。该修复直接覆盖会话中“SQLite running versus doctor empty”的矛盾。

## 源 Worktree 与原始证据

两个源 Worktree 在整合后复查仍未改变；均无 staged 内容，HEAD/Tree 与基线一致。

| 源 | HEAD | Tree | 状态摘要 |
|---|---|---|---|
| `.run/sqlite-recovery-doctor-20261103` | `879568c211bac6233817acc90923e23d7861ca79` | `20183f536292e4e790cca1da52413d198734e577` | 7 个真实 tracked diff + 5 个 untracked；无 staged |
| `.run/test-impact-gating-20261103` | `879568c211bac6233817acc90923e23d7861ca79` | `20183f536292e4e790cca1da52413d198734e577` | 7 个真实 tracked diff + 9 个 untracked；dist/vendor/worker 显示的状态脏项在 `git diff` 下无文本差异 |

源补丁快照保留在集成候选
`.run/source-snapshots/{sqlite,gating}-tracked.patch` 与 untracked manifest 中。
Fetch 后 `origin/master` 仍为 `879568c2`，没有共同基线之后的新提交。

## 集成候选

集成 Worktree HEAD/Tree 同样是基线 `879568c2` / `20183f536292e4e790cca1da52413d198734e577`；
全部候选工作保持未提交。真实整合包括：

- SQLite doctor：`src/runtime/sqlite-doctor.ts`、Authority `getDoctorChecks()`、
  Host 绑定、recovery snapshot `task_projections`、`test/sqlite-doctor.test.ts`、
  composition MCP doctor 断言、ADR-022。
- Test Impact Gating：`test:affected`、`test:stress`、`test:full`、
  `test:inventory`、selector/runner/stress/inventory 脚本、映射、Inventory、
  testing 合同、AGENTS/Skill 更新、build-core EPERM retry；`npm test` 默认
  glob 扩大为 `dist-test/test/**/*.test.js`，嵌套 integration tests 不再被
  静默排除。
- 集成修复：doctor 源与测试加入 `sqlite-persistence` 映射；新增
  `test/sqlite-doctor.test.ts` 条目；ADR-023 和 Windows completion-window
  cleanup helper prewarm；runtime-remediation 增加失败瞬间证据导出。

无文本冲突。`npm ci` 前一次失败的 build 曾用父仓依赖生成含
`../../node_modules` 路径的 bundle；安装本 Worktree 依赖并重建后，产物恢复为
仓库合同的 `node_modules` 路径。原始源 Worktree 未因此改动。

## Inventory 与 Test Impact Map

最终 Inventory：90 个映射文件、878 条声明，207 Unit / 670 Integration /
1 Stress。相对 Test Impact Gating 的 89/872/207/664/1 增加 1 个文件和 6 条
声明，全部来自新增 `test/sqlite-doctor.test.ts`。

`src/runtime/sqlite-doctor.ts` 与 `src/runtime/doctor.ts` 加入
`sqlite-persistence`；doctor 测试关联 `sqlite-persistence`、
`manager-lifecycle` 和 `mcp-host`。未映射生产源码仍强制 FULL_SUITE；未知
`src/**` 输出 `unknown-source:<path>`，未知测试基础设施输出
`unknown-test-infrastructure:<path>`。空变更集输出 `NO_TESTS_APPLICABLE`，
不作为 PASS。选择器单元测试 10/10 PASS。

## 最终门禁

完整原始日志在集成候选 `.run/evidence/`；此前两个源 Worktree 的日志未覆盖。
最终复核时间：2026-11-03T16:03:38Z。

| Gate | 结果 | 证据 |
|---|---|---|
| Typecheck | PASS | `.run/evidence/gate5-final-revised/typecheck.log` |
| Build / rebuild | PASS | `.run/evidence/gate5-final-revised/build.log`、`rebuild.log` |
| Plugin validation | PASS | `.run/evidence/gate5-final-revised/validate-plugin.log` |
| `git diff --check` | PASS | `.run/evidence/gate5-final-revised/git-diff-check.log` |
| Selector unit test | 10/10 PASS | `gate1-final/selector-isolated.log` |
| Inventory 生成与一致 | PASS，878/90 且复跑无 diff | `gate1-final/test-inventory.log`、`inventory-consistency.log` |
| `test:affected` 历史窄选首次 | FAIL：713 / 710 pass / 1 fail / 2 skip | `gate2/test-affected.log` |
| `test:affected` 历史窄选最终 | PASS：713 / 711 pass / 0 fail / 2 skip；1,186,016.8403 ms；不是完整 Inventory 回归 | `gate2-final/test-affected.log` |
| 扩展 `npm test` 首次 | FAIL：806 / 797 pass / 7 fail / 2 skip；1,531,883.027 ms | `.run/evidence/gate2-retry-full/test.log`；SHA256 `0312BE15622DDA413CD2764698BF5FABD6BF4F749EF930FD33B9A3BA3692E0AA` |
| 扩展 `npm test` 最终 | PASS：806 / 804 pass / 0 fail / 2 skip；1,395,494.5134 ms | `.run/evidence/gate2-expanded-final/test.log`；SHA256 `B7DB7A7C46FE0D1CEF66A5ACBA7FB35F884069A74E70D10FB5B25EF15DCBD882` |
| PR #56 首轮 Ubuntu CI | FAIL：803 / 717 pass / 32 fail / 54 skip；107,208.284869 ms；32 项均来自 Windows-only 文件 | GitHub Actions run `41672498692`；修复 runner 后等待新 head 的双平台 CI |
| B3-05 | PASS，1/1，0 skip；测试 358,234.8017 ms，wrapper 369,110 ms | `gate4-stress/test-stress.log`、`result.json` |
| 最终扩展运行中的 B3-05 | PASS，1/1；测试 357,143.5999 ms，32/10,000 setup 294,276 ms | `gate2-expanded-final/test.log` |
| Clean entrypoints | 4/4 PASS；5,004.5842 ms | `.run/evidence/gate5-final-revised/clean-entrypoints.log` |
| 产物重建一致性 | 8 个产物哈希前后一致 | `.run/evidence/gate5-final-revised/artifact-manifest.json` |

Windows 的最终 `test:affected` 选择报告为 FULL_SUITE，理由可追溯到：
`package.json`、`scripts/build-core.mjs`、三个 runner/map 脚本和
`test/test-impact-map.json`。共 33 个 changed files，涉及
appserver-adapter、ci-release-contract、manager-lifecycle、mcp-host、
sqlite-persistence、worker-launch 等 12 个域。没有静默窄选。

历史窄选中的 `runtime-remediation` 失败是 “real worker permission reply”
5 秒 close 等待，13.635 秒 `'hung' !== 0`；未增加 timeout。隔离复测一次也
失败（15.905 秒）。诊断显示 5 秒时 Worker 仍 running、runtime PID 已不在 OS
表中，随后约 2 秒自然 close 且 exit code 0。ADR-023 将 ADR-009 PowerShell
helper 在 `turn.completed` 处理窗口空预热，close 仍执行完整身份绑定终止或
recorded-tree claimant scan。修复后目标复现 10/10 PASS，runtime suite 连续
5/5 PASS；最终扩展运行中同一用例 10.106 秒通过。这证明当前候选通过，但不
宣称历史超时的所有根因已被证明消除。

B3-05 参数保持冻结：32 active、10,000 historical、setup budget 720 秒、
timeout 900 秒。实测 32/10,000 setup 296,701 ms；status p95 8.16 ms；
recovery 13,901.7 ms；cleanup 9,790 ms；1 pass / 0 fail / 0 skip。

## 产物哈希

最终重建前后一致。Bridge bundle 含 SQLite doctor；Worker bundle 含 ADR-023
cleanup prewarm；vendor 内容保持基线。

| 产物 | SHA256 | Bytes |
|---|---|---:|
| `plugins/codex-zcode-bridge/dist/bridge.mjs` | `f4f834cffc71e0ad248604720f06213ba5fbd6ebcf61eef7436457a05f6dffdd` | 1,744,987 |
| `plugins/codex-zcode-bridge/worker/worker-main.mjs` | `08a0206b3a76757e0014cc0b587b11a315fe49db4e5b0ed5206ab708dbb24d19` | 1,255,869 |
| `plugins/codex-zcode-bridge/worker/vendor/pkg/browser-host.cjs` | `b750aeff5cae48d6cdb71e068b0b8d96592cba52b57a514fedad515615c55b4e` | 7,335,238 |
| `plugins/codex-zcode-bridge/worker/vendor/browsers.json` | `2cfd419f71ac6475d81e1301fa86c34cf2a2a6bae2a0da4b5a2b18310216b6bf` | 1,135 |
| `plugins/codex-zcode-bridge/worker/vendor/package.json` | `1d6b6f80ffb0c52865af0f9fe01abf2140df019e49ae6ac134605e462d583f3a` | 876 |
| `plugins/codex-zcode-bridge/dist/schema.sql` | `14b44263fcc7909a782ec5574863ff7efef7f2d81c0d4d2317793df677577ac5` | 36,677 |
| `plugins/codex-zcode-bridge/dist/admin-abandonment.sql` | `e407455e08fb751d420ef0c92dfc38e83ddde170c0d30d671e3e072aa37e6a89` | 1,945 |
| Skill token script | `abd38d09f901ddceca9b77e072275d9363a4b81c430e0ba1e77eae3abd99f88c` | 28,729 |

`git diff --exit-code -- plugins/codex-zcode-bridge/worker/vendor` 为 0。
Bridge 和 Worker 的 tracked diff 是预期交付；候选源文件哈希见
`.run/evidence/final-candidate-source-hashes.json`。

## 生产安全

安装 1.4.0 插件未替换：installed Bridge
`b0a2cf8cbaa8734e0bab3e0a4e76dd34e2ab91e31352fe086da276ce925ea1f7`，
installed Worker
`4cef5244cb36aec79af370e96817a380c621d06c4b0244741e72b690387abfd1`。
2026-11-03T16:00:52Z 只读复查两者仍保持上述哈希与 1.4.0 安装路径。

Task78 `sqlite-676c38908c3289aa18a1ee323fbd73bd` 未行政结案，Hold 未释放；
未执行 `task78-recovery.ps1 -Execute`，未创建或伪造 Result，未重派任务。
本轮没有杀死 Codex/Bridge/Worker 进程，没有创建 LumeCAE 生产任务。

2026-11-03 10:31:32Z 的项目内生产快照记录 DB/WAL/SHM 前后哈希一致。本轮
22:20 只读 `Get-FileHash` 复查因当前 Host 正在使用三个生产 SQLite 文件而
无法读取；因此当前哈希为 **NOT VERIFIED**，既有快照仍是 CONFIRMED，不能把
二者混写为“刚刚再次证明不变”。生产 SQLite 未被打开或写入。

## 尚未解决

- 候选未提交，等待 owner 审查与显式授权；默认不 push、不合并、不发布。
- 旧的 713 项结果是修正 glob 前的窄选历史证据；不能用它的数量与当前 806 项
  结果直接比较。
- Task78 生产行政结案仍需独立停机授权、关闭 Host/Writer 后的新鲜检查。
- runtime close 历史失败在最终候选未复现，但仅一次历史通过不能证明原竞争
  已被完全根除；ADR-023 证据和 full-suite 通过是当前结论边界。
- 真实 provider/live E2E 未运行；Inventory 中的 runtime 字段仍为
  `NOT_MEASURED`。
