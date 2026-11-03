# ZCode Path Discoverer 交付报告（2026-11-03）

> Status: REPORT（待 Master 独立审查）
> Worktree: `D:\codex-zcode-bridge\.run\zcode-path-discoverer-20261103`
> Branch: `codex/zcode-path-discoverer-20261103`
> Baseline: `58947ad770353b62ca3efccb2c6fd47c00e56894`（origin/master，v1.3.0，含 SQLite 集成候选 `5527800a`）
> Baseline Tree: `5285f5fbb40ad22a1d92f1d0e5a3fec6d48743a0`

## 基线核对（开发前）

- 本地 `D:\codex-zcode-bridge` `master` @ `6f0d7d3b63a93052cc83882658329b6f1b84ba4b`，**不是**最新 SQLite 集成基线：它不包含 `5527800a`，且与 `origin/master` 分叉（本地含未合并的 scoped-authorization/artwork 工作）。
- `5527800a`（SQLite 集成候选）已包含于 `origin/master`；其上有 `0ebd9830`（bootstrap lock 加固）、`196eb171`（bootstrap lock handoff 修复）、`460b6f13`/`26f7be80`/`58947ad7`（v1.3.0 发布）。远端与本地 `ls-remote` 一致为 `58947ad7`。
- WP 写明"不使用落后的远程 master 替代本地基线"，但现场核对结果相反：本地 master 落后且分叉，最新 SQLite 生产集成代码在 `origin/master` @ `58947ad7`。因此本 worktree 以 `58947ad7` 为基线；本地 master 的未合并工作未被替代或覆盖。
- 本地 `master` 工作区保留原有未提交 WIP（`.gitignore` 修改、ADR-009、start-plan/provider-capabilities 等未跟踪文件），本任务未触碰。

## 参考来源

Magpie `yetone/magpie` v0.1.2127 `internal/appdir/zcode.go`（`ZCodeHome`/`ZCodeHomeOn`/`ZCodeDataIn`）——仅作行为参考并独立重新实现（Windows HOME 判定、`dataBaseDir` 有效性），未复制其代码；其认证、私有 API、凭据解密、模型请求协议与自动重试一律未移植。

## 修改文件清单

| 文件 | 变更 |
|---|---|
| `src/runtime/paths.ts` | 新增：统一路径发现纯函数（用户目录、setting.json/dataBaseDir、安装发现、同安装派生） |
| `src/runtime/resolver.ts` | 接入统一发现：`ZCODE_HOME`×`ZCODE_DATA_BASE_DIR` 显式冲突报错；自动发现同安装校验；显式 runtime 派生同安装 builtin；personal 候选顺序统一 |
| `src/runtime/child-env.ts` | Windows 子进程 `HOME` 归一为 Bridge 解析的用户目录（可注入 platform） |
| `src/runtime/doctor.ts` | 新增 `user_home`、`desktop_settings`、`zcode_data_dir`、`zcode_install`、`worker_env_consistency` 检查 |
| `plugins/codex-zcode-bridge/hooks/configure-runtime.ps1` | 同规则发现（`Resolve-UserHomeDirectory`/`Get-ZCodePathDiscovery`）、显式冲突检查、`Find-DefaultRuntime` 同安装要求、`-PrintPathDiscovery` JSON 输出 |
| `test/zcode-paths.test.ts` | 新增：WP 测试矩阵 + PowerShell 跨实现一致性测试 |
| `docs/decisions/ADR-020-zcode-path-discovery.md` | 新增决策记录 |
| `docs/decisions/README.md` | ADR 索引补充 |
| `docs/ZCODE_RUNTIME.md` | 新增"路径发现合同"一节 |
| `plugins/codex-zcode-bridge/dist/bridge.mjs`、`worker/worker-main.mjs` | 由 `npm run build` 同步重建 |

MCP 公开工具 schema、SQLite Authority、Admission、Worker 生命周期、Start Plan、JSON 历史数据均未修改。

## 旧逻辑与新逻辑差异分析

| 场景 | 旧行为 | 新行为 |
|---|---|---|
| Windows `HOME` | 完全忽略（仅 `os.homedir()`） | 采用 Magpie 原则：`HOME` 与 `USERPROFILE` 同目录且为绝对路径时采用，否则忽略并记录冲突 |
| `setting.json` 读取位置 | `homedir()` | 统一发现的用户目录（含 `HOME` 判定） |
| `dataBaseDir` | 仅作为 personal 配置候选之一，静默忽略无效值 | 统一发现结果的一个来源；无效值回退并在 doctor 报告原因 |
| 显式 `ZCODE_HOME` 与 `ZCODE_DATA_BASE_DIR` 冲突 | 静默忽略 `ZCODE_DATA_BASE_DIR` | 报 `provider_config_invalid` |
| 自动发现 runtime/builtin | 各自独立选根，可能混用两个安装 | 必须同一安装根；显式 runtime 时 builtin 从同安装派生 |
| Windows Worker `HOME` | 不透传（缺失） | 归一为 Bridge 解析的用户目录 |
| PS1 personal 候选顺序 | `ZCODE_DATA_BASE_DIR` → `desktopDataBase`（可为相对路径） → `$HOME` | 显式 base → `setting.json` 绝对 `dataBaseDir` → 用户目录，与 TS 一致并有一致性测试 |
| PS1 `Find-DefaultRuntime` | 第一个有 `zcode.cjs` 的根 | builtin 未显式配置时要求同根 builtin |

冻结合同未变：`ZCODE_HOME`/`ZCODE_DATA_BASE_DIR` 语义、`ZCODE_BRIDGE_NODE`/`ZCODE_BRIDGE_ZCODE_CJS` 优先级、MCP 工具 schema、personal provider 验证规则（空 stub 拒绝、不读凭据内容）均保持。

## 路径发现优先级表

| 项 | 优先级 |
|---|---|
| 用户目录（Windows） | 显式无；`HOME`（=绝对且等于 `USERPROFILE`） → `USERPROFILE` → 注入回退 |
| 数据基础目录 | 显式 `ZCODE_HOME`（父目录，须与显式 `ZCODE_DATA_BASE_DIR` 一致） → 显式 `ZCODE_DATA_BASE_DIR` → `setting.json` 的绝对 `dataBaseDir` → 用户目录 |
| 安装目录 | `ZCODE_BRIDGE_ZCODE_CJS`（显式 runtime） → `ZCODE_WINDOWS_APP_INSTALL_DIR` → `%LOCALAPPDATA%\Programs\ZCode` → `%ProgramFiles%\ZCode`（自动发现要求同根 builtin） |
| Node | `ZCODE_BRIDGE_NODE` → PATH（合同不变） |

## 真实环境只读验证（ZCode Desktop 3.16.3.8992）

环境：Windows，Node 24.16.0（生产基线）。全部为只读检查，未执行模型请求、未登录、未复制凭据、未修改任何用户数据。

- `C:\Users\Sandy\AppData\Local\Programs\ZCode\ZCode.exe` ProductVersion = **3.16.3.8992**（CONFIRMED）。
- 安装发现：经 `%LOCALAPPDATA%\Programs\ZCode` 命中；`resources/glm/zcode.cjs`（15,242,397 bytes）与 `resources/config/provider/zcode-builtin.json`（键：`schemaVersion,revision,config`）来自同一安装根（CONFIRMED）。
- 用户目录：`C:\Users\Sandy`（来源 `USERPROFILE`，无 `HOME` 冲突）（CONFIRMED）。
- `C:\Users\Sandy\.zcode\v2\setting.json` 存在且合法；`dataBaseDir = D:\Program Files` → 迁移数据目录生效，`zcodeV2Dir = D:\Program Files\.zcode\v2`（CONFIRMED）。该真实迁移场景正是本 WP 的动机问题。
- Worker 一致性：`createWorkerEnv(process.env)` 后用户目录、数据目录、personal 候选与主进程完全一致；worker 环境无任何 TOKEN/SECRET/KEY/PASSWORD/CREDENTIAL 键（CONFIRMED）。

## 回归与验证结果

### 验收统计

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` | PASS（`dist/bridge.mjs`、`worker/worker-main.mjs` 与源码同步重建） |
| `npm run validate:plugin` | PASS（结构有效） |
| `npm test`（完整回归） | 692 tests：686 pass，4 fail，2 skipped，0 cancelled（约 30 分钟） |
| `git diff --check` | PASS（暂存前后均干净） |

### 完整回归中 4 个失败的处置

1. `runtime-resolver.test`："missing runtime raises runtime_not_found"——断言旧错误信息 `zcode.cjs was not found`，新信息为 `zcode.cjs with a same-install zcode-builtin.json was not found`（同安装校验的预期内变化）。已更新断言，复跑 PASS。
2. `ledger-core.test` C3 与 `ledger-bridge-review.test` C3-05：Windows `EPERM rename snapshot.json.tmp -> snapshot.json`（`writeTextAtomic` 处）。隔离复跑两个文件均 PASS（44/45 通过，唯一失败为下一项）。判定为长负载下的环境性 EPERM 竞争，与本任务改动无代码交集（ledger 存储/快照路径未修改）。CONFIRMED：隔离通过；根因（Defender/索引器类干扰）UNVERIFIED。
3. `runtime-remediation.test`："a real worker delivers a permission reply and exits"——reply 后 5 秒窗口内 worker 未退出（`'hung' !== 0`）。处置证据：基线 worktree（`58947ad7`，无本任务改动）同名单测 PASS（9.1s）；本 worktree 同名单测 PASS（8.5s）；本 worktree 整文件隔离复跑 7/7 PASS（95s）。基线整文件与全量套件复跑 NOT RUN。结论：负载相关的超时窗口竞争，非确定性回归；在满负载下是否与 `HOME` 归一化存在弱交互 UNVERIFIED——残留风险，建议 Master 用单独窗口复跑该文件确认。

`test/zcode-paths.test.ts` 在完整套件与本 worktree 中 16/16 PASS，含 PowerShell×TypeScript 一致性测试（powershell.exe 实际子进程比对）。

## 遗留问题

1. **负载类 flake（非本任务引入的证据不完整）**：ledger EPERM rename 与 worker 5 秒退出窗口在满负载下偶发；隔离复跑均通过。已按证据等级标注，未修改这些测试或其超时窗口。
2. **临时数据**：参考用 Magpie 克隆残留在 `%TEMP%\magpie-ref-677425e2`（删除命令被沙箱策略拦截）；内容为公开仓库 v0.1.2127 检出，可随时手动删除。
3. **ADR-020 编号冲突风险**：本分支 ADR-020 为路径发现；`codex/attention-state-research-20261102` 研究分支另有未合并的 ADR-020（attention）。合并顺序需 Master 协调，后合方需改号。
4. **ADR-020 状态**：按 WP 授权实施，标注"待 Master 独立审查确认"；未 push/merge/tag/release。

## 最终结论

**PASS（待 Master 独立审查）**——实现、合同文档、测试矩阵、PowerShell 一致性、doctor 诊断与真实环境只读验证完成；四项验收命令通过；完整回归失败项已逐项处置并标注证据等级。无未处理的 BLOCKED 项。
