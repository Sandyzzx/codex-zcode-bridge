# ADR-020: 统一 ZCode 路径发现（Path Discoverer）

> Status: DECISION — Accepted（依据 2026-11-03 WP「ZCode Path Discoverer 路径发现器开发」的Owner 授权实施，待 Master 独立审查确认）
> Date: 2026-11-03
> Scope: Bridge 的 ZCode 用户目录、数据目录、安装目录路径发现、验证与诊断
> Related: ADR-016, ADR-017, ADR-019

## Context

Windows 下 ZCode Desktop 的安装路径、用户目录与数据目录各有多个来源：`HOME`/`USERPROFILE`、
`<userHome>/.zcode/v2/setting.json` 的 `dataBaseDir`（Desktop 数据迁移）、
`ZCODE_WINDOWS_APP_INSTALL_DIR`/`%LOCALAPPDATA%\Programs\ZCode`/`%ProgramFiles%\ZCode`。
此前 Bridge 中路径逻辑分散在 `resolver.ts`、`configure-runtime.ps1`、`child-env.ts`，
存在以下问题：

1. Windows `HOME` 未按 ZCode 自身的判定原则处理。参考 Magpie
   `internal/appdir/zcode.go`（v0.1.2127，独立重新实现）：ZCode（Node 应用）在 Windows 上
   只在 `HOME` 为有效绝对路径且与 `USERPROFILE` 指向同一用户目录时采用 `HOME`；
   测试目录、WSL 目录不得覆盖真实用户目录。
2. Desktop 数据迁移（`setting.json` 的 `dataBaseDir`）只被读取为 personal provider 配置
   候选之一，未形成统一的发现结果；PowerShell 与 TypeScript 的读取顺序存在差异。
3. 自动发现可能把不同安装目录的 `zcode.cjs` 与 `zcode-builtin.json` 混用。
4. 显式 `ZCODE_HOME` 与显式 `ZCODE_DATA_BASE_DIR` 冲突时被静默忽略其一。
5. Worker 环境在 Windows 上不转发 `HOME`，而 ZCode 自身优先读 `HOME`，
   可能出现主进程与 Worker/子进程解析出不同数据目录。

冻结合同保持不变：`ZCODE_HOME` 指 `.zcode` 目录本身，`ZCODE_DATA_BASE_DIR` 指其父目录；
两者都不是 Magpie `ZCodeHome()` 返回的用户目录，语义不得混淆。

## Decision

1. 新增 `src/runtime/paths.ts` 作为唯一路径发现模块，全部使用可注入环境与
   文件系统读取的纯函数；PowerShell hook 使用相同规则独立实现，
   并通过 `-PrintPathDiscovery` 输出 JSON 供跨实现一致性测试比对。
2. 用户目录采用 Magpie 判定原则（Windows）：`HOME` 仅在非空、绝对路径、
   且清理后与 `USERPROFILE` 相同（Windows 大小写不敏感）时采用；否则回退 `USERPROFILE`，
   并保留冲突原因供诊断。`setting.json` 永远从该用户目录读取。
3. 数据目录：`dataBaseDir` 只有在非空且为绝对路径时生效，否则回退用户目录。
   `userHome`、`settingFile`、`dataBaseDir`、`zcodeDataDir`（`dataBaseDir/.zcode`）、
   `zcodeV2Dir`（`dataBaseDir/.zcode/v2`）是五个独立字段，不得合并为一个 `ZCODE_HOME`。
   Bridge 不创建、不迁移任何 ZCode 数据目录。
4. 显式配置优先于自动发现。显式 `ZCODE_HOME` 与 `ZCODE_DATA_BASE_DIR` 同时存在且
   不满足 `ZCODE_HOME == <ZCODE_DATA_BASE_DIR>/.zcode` 时报配置错误，不再静默择一。
5. 自动发现安装时，`resources/glm/zcode.cjs` 与 `resources/config/provider/zcode-builtin.json`
   必须来自同一安装根，按固定优先级
   `ZCODE_WINDOWS_APP_INSTALL_DIR` → `%LOCALAPPDATA%\Programs\ZCode` → `%ProgramFiles%\ZCode`
   取第一个同时满足的根；显式 `ZCODE_BRIDGE_ZCODE_CJS` 时 builtin 从该 runtime 所在安装派生。
   Node 入口仍按既有 `ZCODE_BRIDGE_NODE`/PATH 合同，不改变。
6. Windows 子进程环境（`createMinimalOsEnv`/`createWorkerEnv`）把 `HOME` 归一为
   Bridge 解析出的用户目录，`USERPROFILE` 原样保留；不新增任何凭据或任意父进程变量透传。
7. Doctor 增加用户目录来源与冲突、setting.json 状态、数据目录来源与迁移、
   安装目录来源与同安装校验、Worker 环境一致性检查；只输出路径与来源，
   不输出 credentials、JWT、API Key 或配置文件正文。

## Consequences

- 显式 `ZCODE_BRIDGE_ZCODE_CJS` 指向的安装若无 builtin 配置，此前可能从其他安装
  混入 builtin，现在报 `provider_config_missing`；这是行为收紧，不是合同变更。
- 自动发现要求同根后，"runtime 在 A 安装、builtin 在 B 安装"的畸形环境会失败，
  错误信息列出每个候选根的 runtime/builtin 存在性。
- 运行时配置持久化（runtime-config.json）仅保存显式配置来源的
  `ZCODE_HOME`/`ZCODE_DATA_BASE_DIR`；来自 `setting.json` 的发现值不持久化，
  保证 Desktop 后续迁移数据目录时 Bridge 能跟随。
- Magpie 代码仅作行为参考，未复制其源码；其认证、私有 API、凭据解密、
  模型请求协议与自动重试均不移植。
