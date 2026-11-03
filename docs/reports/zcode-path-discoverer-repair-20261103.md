# ZCode Path Discoverer 修复报告（2026-11-03）

> Status: REPORT（本轮复审完成；等待最终候选 CI）
> Branch: `codex/zcode-path-discoverer-20261103`
> Worktree: `D:\codex-zcode-bridge\.run\zcode-path-discoverer-20261103`

## 提交与身份

| 项 | 值 |
|---|---|
| 原始实施 Commit | `c39909a5718396f463de08b1a812cf309f3a1616` |
| 原始 Tree | `5858fb9bfe5b7adf2cf2cd19d594bcf7529d5640` |
| Base | `58947ad770353b62ca3efccb2c6fd47c00e56894` |
| Repair rename-only Commit | `c95b9c42ab9a236c9e723a4e63f9dae09cf1cacb` |
| Repair implementation Commit | `c505c240f8bb21d9b7417d8c7a8c4f3323e0b633` |
| Repair implementation Tree | `62601d4f98afe0d6f6ced2c8ada42b71929b57c9` |
| 本轮修复前 HEAD | `eec76db22110b2cbd3f3854dd614f0efbde4eb24` |
| 本轮修复前 Tree | `2b0f4d4151dcb00f476ecdf7fd735d0a68ad823c` |
| 本轮 Doctor 修复提交 | `4282b8fc64c97399416d8a9a9d53e59bc799cb67` |
| Doctor 修复提交 Tree | `21700367bda13fa5c98a3ceba89a88745493957c` |
| 平台大小写修正提交 | `8fad454b4d4f78d82b75fbbbdee3c049346fb26a` |
| 平台大小写修正 Tree | `b283e73164712a575c54b450e8cc355090c48043` |
| 报告更新 | 独立文档提交，位于平台大小写修正之后 |
| PR | `#54`，open；远程旧 HEAD 的 Ubuntu CI 通过、Windows CI 在锁 rename EPERM 失败；本轮提交后需重新验证 |

`c95b9c42` 是 `git mv` 的 ADR 文件 rename；由于后续显式 `git add` 的旧 pathspec 已不存在，该暂存 rename 被独立提交。未 amend、未 reset、未 cherry-pick。`c505c24` 包含全部修复内容与测试，保留原始实施提交。

## 修改文件

- `plugins/codex-zcode-bridge/hooks/configure-runtime.ps1`：新增完整 Windows 绝对路径判定，并与 TypeScript 的规范 UNC 分隔符规则一致；PS5.1/PS7 统一 UTF-8 读取；dataBaseDir、HOME、显式路径和输出拼接均不再依赖 `IsPathRooted`。
- `src/runtime/paths.ts`：新增 `isWindowsAbsolutePath`、`isAbsolutePathForPlatform`、`isPermissionDeniedCode`；Windows HOME 与 `dataBaseDir` 使用完整 Windows 绝对路径规则，POSIX `dataBaseDir` 使用 POSIX 规则；EPERM 与 EACCES 都归类 permission denied。
- `src/runtime/resolver.ts`：Windows 拒绝 drive-relative 的 `ZCODE_DATA_BASE_DIR`/`ZCODE_HOME`；POSIX 语义保持不变。
- `src/runtime/doctor.ts`：验证显式 runtime 文件；报告实际生效 dataBaseDir 和来源；相对 `dataBaseDir` warning；通过 `stat` 将 ENOENT 作为缺失 warning、EPERM/EACCES 作为权限 error；报告 automatic discovery 与 explicit runtime 的关系；不输出配置正文或凭据。
- `docs/decisions/ADR-020-zcode-path-discovery.md` -> `docs/decisions/ADR-021-zcode-path-discovery.md`：改号并补充完整路径规则。
- `docs/ZCODE_RUNTIME.md`、`docs/decisions/README.md`、原始交付报告：同步 ADR-021 与复审状态。
- `test/zcode-paths.test.ts`：ADR 引用同步；Windows 规则测试改用虚拟文件系统，使其可在 POSIX runner 执行；新增 POSIX dataBaseDir 迁移覆盖。
- `test/zcode-path-repair.test.ts`：新增 4 个修复矩阵测试。
- `plugins/codex-zcode-bridge/dist/bridge.mjs`、`plugins/codex-zcode-bridge/worker/worker-main.mjs`：生产构建同步。

## PowerShell 对照证据

新增定向测试 `PowerShell 5.1 and 7 match TypeScript...` 同时调用 `powershell`（PS5.1）和 `pwsh`（PS7），对以下 setting.json 场景逐字段比较 `settingStatus`、`configuredDataBaseDir`、`dataBaseDir`、`dataBaseDirSource`、`zcodeDataDir`、`zcodeV2Dir`：

1. `C:foo`、`C:`、`\\foo`：PS5.1/PS7 与 TS 都忽略并回退默认用户目录。
2. `D:\foo bar`：PS5.1/PS7 与 TS 都接受 drive-absolute 路径。
3. `\\127.0.0.1\share\foo`：PS5.1/PS7 与 TS 都接受 UNC 绝对路径；混合分隔符的 UNC 形式均拒绝。
4. `Q:\中文 目录\zcode-data`：setting.json 以 UTF-8 无 BOM 写入，PS5.1/PS7 与 TS 都得到同一非 ASCII 迁移路径。

`\foo`、`C:`、`C:foo` 的分类由 TypeScript 单元测试固定为非完整绝对路径；PS1 使用等价 `Test-WindowsAbsolutePath`。显式 override 与显式 conflict 测试对 PS5.1/PS7 各执行一次：override 输出 effective explicit data base 且与 `NodeRuntimeResolver` personal 配置一致；conflict 返回非零并报 `ZCODE_HOME ... ZCODE_DATA_BASE_DIR ... conflict`；`-WhatIf` 与 `-PrintPathDiscovery` 后 runtime-config.json 不存在。

定向 PowerShell/Doctor 修复测试结果：4 tests，4 pass，0 fail，0 skipped。PowerShell 场景逐项覆盖 `C:foo`、`C:`、`\\foo`、规范 UNC、混合分隔符 UNC、绝对盘符路径及 Unicode；PS5.1 与 PS7 均通过。

## Doctor 证据

新增 doctor 测试覆盖：

- 显式 `ZCODE_BRIDGE_ZCODE_CJS` 指向不存在文件：`zcode_install=error`，summary 明确 not a readable file。
- 显式 runtime 与 `ZCODE_WINDOWS_APP_INSTALL_DIR` 自动发现并存：summary 同时报告 explicit runtime 派生安装与 auto-discovery 候选。
- 显式 `ZCODE_DATA_BASE_DIR` 与 setting.json 不一致：`zcode_data_dir` 报告显式路径及 `explicit ZCODE_DATA_BASE_DIR` 来源。
- `dataBaseDir=C:foo`：`desktop_settings=warning`，说明 relative path 被忽略；effective data directory 回退用户目录。
- 注入 `EPERM`：`desktop_settings=error`。
- Worker 与主进程目录比较使用平台文件系统规则：Windows 大小写不敏感，POSIX 大小写敏感；对应 `sameFileSystemPath` 单测覆盖两种语义。
- 设置 JSON 中注入 `TOKEN_DO_NOT_LEAK`：doctor JSON 序列化结果不包含该 token。doctor 不启动 AppServer、不执行真实模型请求。

## ADR-021 核对

- ADR-020 仅在改号说明和旧文件名迁移记录中出现，表示 Attention/Thin Waiter 保留该编号；Path Discoverer 决策编号均为 ADR-021。
- Path Discoverer 本体、索引、源码注释、测试注释、合同和报告引用均已使用 ADR-021。
- 未修改 Attention/Thin Waiter 分支。

## 完整回归

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | PASS |
| `npm run validate:plugin`（仓库的 validate 命令） | PASS |
| `npm test`（先执行 `build:test`） | 697 tests：695 pass，0 fail，2 skipped，duration 1,365,822.545 ms |
| `git diff --check` | PASS |

原审查候选为 692 tests（690 pass，2 skipped）。修复新增 5 tests，因此总数为 697；skip 仍为同 2 项，无原有断言、timeout 或测试数量减少。Ubuntu CI 首轮暴露 Windows 路径单测错误使用 POSIX 临时路径，随后暴露解析器无条件采用 Windows dataBaseDir 规则；最终 PowerShell 审查又补齐了严格 UNC 分隔符和 `C:`/`\\foo` 测试。

本轮独立重跑的完整 Windows `npm test` 为 695 pass、2 skipped、0 fail。PR 旧 HEAD `eec76db` 的 Windows CI 单独失败于 `test/process-lock.test.js` 的真实跨进程锁竞争，错误为 pending lock rename 的 `EPERM`；同一 run 的 Ubuntu CI 成功，Windows typecheck/build 在该失败前均成功。本轮未触碰锁实现或断言。原审查已完成基线与候选各 5 次对照；不重复压力复跑。新提交仍须取得其自身 CI 结果。

## 构建一致性

本轮 Doctor 代码变更后的完整构建成功；其后一次重复构建遇到 `scripts/build-core.mjs:33` 目录 rename `EPERM`，未进入 plugin bundle 阶段，再下一次完整构建成功。平台大小写修正后构建又遇到两次同类 `EPERM`，随后完整构建成功。最后一次成功构建已将平台感知路径比较打入 bundle；该修正前后的 bridge bundle 哈希因此不同。当前最终产物 SHA256：

- `plugins/codex-zcode-bridge/dist/bridge.mjs`：`B1E575FC1D896E6BC974A35EFC1E41CB41239BDF5CDA85C82021F66877138AD8`
- `plugins/codex-zcode-bridge/worker/worker-main.mjs`：`0FB4426C2F039E298041F4EBCAF850DF254D3948ABE9FD29B5B06978FDD9CED3`

Windows `scripts/build-core.mjs:33` 的目录 rename 偶发 `EPERM` 仍可复现。未修改构建命令、脚本或重试逻辑。旧远程 HEAD 的 Windows CI build 步骤通过；新提交的 CI 仍待完成。

## 未解决问题

1. Windows 构建/文件 rename 的偶发 EPERM 仍存在环境性残留；本轮观察到多次间歇失败，其间连续成功构建且产物哈希稳定。未修改构建脚本或增加重试。
2. `createWorkerEnv` 返回普通对象后再次解析时，非规范大小写 key 的注入边界仍大小写敏感；真实 Windows `process.env` 链路保持正确，此项属此前审查的 P2 备注，不在本次 WP 明确修复列表内。

## 结论

PASS（本地修复验收）——P1、ADR-021 与 P2 Doctor 修复已实现；PS5.1/PS7 对照、697 项完整回归及最终构建产物证据通过。Doctor 修复提交为 `4282b8fc64c97399416d8a9a9d53e59bc799cb67`；平台大小写修正提交为 `8fad454b4d4f78d82b75fbbbdee3c049346fb26a`。旧 HEAD `045bdf15` 的双平台 CI 通过；本次平台修正的新 HEAD CI 尚未运行。未合并，未触发 release-please。
