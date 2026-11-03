# ZCode Path Discoverer 修复报告（2026-11-03）

> Status: REPORT（待 Master 复审）
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
| 最终 HEAD | 本报告作为后续 docs commit 提交后，由交付回复记录；未 push/merge/tag/release |

`c95b9c42` 是 `git mv` 的 ADR 文件 rename；由于后续显式 `git add` 的旧 pathspec 已不存在，该暂存 rename 被独立提交。未 amend、未 reset、未 cherry-pick。`c505c24` 包含全部修复内容与测试，保留原始实施提交。

## 修改文件

- `plugins/codex-zcode-bridge/hooks/configure-runtime.ps1`：新增完整 Windows 绝对路径判定；PS5.1/PS7 统一 UTF-8 读取；dataBaseDir、HOME、显式路径和输出拼接均不再依赖 `IsPathRooted`。
- `src/runtime/paths.ts`：新增 `isWindowsAbsolutePath`、`isAbsolutePathForPlatform`、`isPermissionDeniedCode`；HOME 与 `dataBaseDir` 使用同一完整绝对路径规则；EPERM 与 EACCES 都归类 permission denied。
- `src/runtime/resolver.ts`：Windows 拒绝 drive-relative 的 `ZCODE_DATA_BASE_DIR`/`ZCODE_HOME`；POSIX 语义保持不变。
- `src/runtime/doctor.ts`：验证显式 runtime 文件；报告实际生效 dataBaseDir 和来源；相对 `dataBaseDir` warning；EPERM/EACCES error；报告 automatic discovery 与 explicit runtime 的关系；不输出配置正文或凭据。
- `docs/decisions/ADR-020-zcode-path-discovery.md` -> `docs/decisions/ADR-021-zcode-path-discovery.md`：改号并补充完整路径规则。
- `docs/ZCODE_RUNTIME.md`、`docs/decisions/README.md`、原始交付报告：同步 ADR-021 与复审状态。
- `test/zcode-paths.test.ts`：ADR 引用同步。
- `test/zcode-path-repair.test.ts`：新增 4 个修复矩阵测试。
- `plugins/codex-zcode-bridge/dist/bridge.mjs`、`plugins/codex-zcode-bridge/worker/worker-main.mjs`：生产构建同步。

## PowerShell 对照证据

新增定向测试 `PowerShell 5.1 and 7 match TypeScript...` 同时调用 `powershell`（PS5.1）和 `pwsh`（PS7），对以下 setting.json 场景逐字段比较 `settingStatus`、`configuredDataBaseDir`、`dataBaseDir`、`dataBaseDirSource`、`zcodeDataDir`、`zcodeV2Dir`：

1. `C:foo`：PS5.1/PS7 与 TS 都忽略并回退默认用户目录。
2. `D:\foo bar`：PS5.1/PS7 与 TS 都接受 drive-absolute 路径。
3. `\\127.0.0.1\share\foo`：PS5.1/PS7 与 TS 都接受 UNC 绝对路径。
4. `Q:\中文 目录\zcode-data`：setting.json 以 UTF-8 无 BOM 写入，PS5.1/PS7 与 TS 都得到同一非 ASCII 迁移路径。

`\foo`、`C:`、`C:foo` 的分类由 TypeScript 单元测试固定为非完整绝对路径；PS1 使用等价 `Test-WindowsAbsolutePath`。显式 override 与显式 conflict 测试对 PS5.1/PS7 各执行一次：override 输出 effective explicit data base 且与 `NodeRuntimeResolver` personal 配置一致；conflict 返回非零并报 `ZCODE_HOME ... ZCODE_DATA_BASE_DIR ... conflict`；`-WhatIf` 与 `-PrintPathDiscovery` 后 runtime-config.json 不存在。

定向修复测试结果：4 tests，4 pass，0 fail，0 skipped。

## Doctor 证据

新增 doctor 测试覆盖：

- 显式 `ZCODE_BRIDGE_ZCODE_CJS` 指向不存在文件：`zcode_install=error`，summary 明确 not a readable file。
- 显式 runtime 与 `ZCODE_WINDOWS_APP_INSTALL_DIR` 自动发现并存：summary 同时报告 explicit runtime 派生安装与 auto-discovery 候选。
- 显式 `ZCODE_DATA_BASE_DIR` 与 setting.json 不一致：`zcode_data_dir` 报告显式路径及 `explicit ZCODE_DATA_BASE_DIR` 来源。
- `dataBaseDir=C:foo`：`desktop_settings=warning`，说明 relative path 被忽略；effective data directory 回退用户目录。
- 注入 `EPERM`：`desktop_settings=error`。
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
| `npm test`（先执行 `build:test`） | 696 tests：694 pass，0 fail，2 skipped，duration 1,167,933.815 ms |
| `git diff --check` | PASS |

原审查候选为 692 tests（690 pass，2 skipped）。本修复新增 4 tests，因此总数为 696；skip 仍为同 2 项，无原有断言、timeout 或测试数量减少。

## 构建一致性

修复后的生产 bundle 连续两次成功构建，SHA256 完全一致：

- `plugins/codex-zcode-bridge/dist/bridge.mjs`：`907E777BA42CF82AB2CEE205C962F03CB010A76E7B211F5530B17FB83565A128`
- `plugins/codex-zcode-bridge/worker/worker-main.mjs`：`8BDEDE6FBAC217CDFCFF0BB5360690C85069BEFEB2C7C73830A56236A1EF8798`

第一次复验尝试在 `scripts/build-core.mjs:33` 出现一次 Windows `EPERM rename .build-core-KYnjXB\src -> dist\src`；未修改命令或重试逻辑，随后同一命令连续两次成功。该错误与既有 Ledger rename 环境抖动同类，未在本轮修复范围中改变构建脚本。

## 未解决问题

1. Windows 构建/文件 rename 的偶发 EPERM 仍存在环境性残留；本轮无新增自然复现数据，也未扩大修复范围。
2. `createWorkerEnv` 返回普通对象后再次解析时，非规范大小写 key 的注入边界仍大小写敏感；真实 Windows `process.env` 链路保持正确，此项属此前审查的 P2 备注，不在本次 WP 明确修复列表内。

## 结论

PASS——审查要求的 P1、ADR-021 与 P2 doctor 修复已实现并通过完整回归；最终合并由 Master 复审决定。
