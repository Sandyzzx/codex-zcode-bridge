# Node、pnpm 与 Native ABI 兼容性

> Status: RESEARCH
> Date: 2026-11-11
> 结论：基础 Mock 路径 `PASS_FOR_MINIMAL_MOCK`；Windows runtime-host helper 已有固定 x64 制品并通过验收；完整 native/resource closure 仍为 `PARTIAL / NOT_RUN`

## 已实测环境

| 项 | 值 |
|---|---|
| Node | `v24.16.0` |
| Node module ABI | `137` |
| N-API | `10` |
| OpenSSL | `3.5.6` |
| SQLite | `3.53.0` |
| pnpm | `10.33.2` |
| 平台 | Windows 11 x64 `10.0.26100` |

官方 root 要求 Node `>=24.0.0`，`mise.toml` 固定 `24.14.0`；Bridge SQLite gate 为 `>=24.16.0 <25`。本轮使用 Bridge 侧已安装的 `24.16.0`，没有为了源码构建额外引入第二套 Node，也没有把版本号满足误写为 ABI 全验证。

## 实证

源码构建和隔离 AppServer Mock 都使用 Node `24.16.0` 成功运行。基础路径没有观察到 `ERR_DLOPEN_FAILED`、ABI mismatch 或 N-API 加载错误。

因此：

```text
COMMON_NODE_RUNTIME: PASS_FOR_MINIMAL_MOCK
NODE_MODULE_ABI_137_BASIC_PATH: PASS
FULL_NATIVE_MODULE_MATRIX: NOT_RUN
WINDOWS_RUNTIME_HOST_HELPER_ARTIFACT_RUNTIME: PASS
WINDOWS_RUNTIME_HOST_HELPER_OFFICIAL_SCRIPT_REPRODUCIBILITY: PARTIAL
```

## 安装时未构建的原生组件

官方 install 中有两个 optional 失败：

- `cpu-features`: 编译器识别失败
- `ssh2` optional crypto binding: 缺少 Windows SDK `10.0.26100`

基础 AppServer Mock 未依赖它们。`ssh2` 的 pure JS/native fallback 行为、远端 SSH 能力和安全属性没有在本轮验证。

## 动态加载、不代表固定依赖

`zcode.cjs` 中可见以下条件加载：

- `@napi-rs/keyring`
- `playwright-core`
- `koffi`
- `@zcode/tui`

这些字符串只能证明 bundle 存在加载入口，不能证明每次 AppServer 启动都加载它们。基础隔离制品没有源码 `node_modules` 仍完成了 Mock，说明这些模块不在该最小场景的强制启动闭包中。对应真实能力仍为 UNKNOWN/PARTIAL。

## 选择

当前证据支持在 POC/实现中优先采用“Worker 与官方 AppServer 共用同一 Node 24.16.0 运行时”。只有出现具体 ABI、动态链接或依赖冲突时，才考虑独立 Node Runtime。

## Windows runtime-host helper

Windows helper 是独立 x64 PE，不是 Node addon，因此它的成功运行不能替代 `FULL_NATIVE_MODULE_MATRIX`。本轮已有以下证据：

```text
HELPER_PATH: .run/official-host-poc/runtime-host-build-nuget-r5/zcode-runtime-host.exe
CANONICAL_ARTIFACT: .run/official-host-poc/runtime-host-artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/zcode-runtime-host.exe
HELPER_BYTES: 167424
HELPER_SHA256: 04E1794F8325B3C46D4159420CDD04041E9AFC58516E03FC3DC8E78576EEFC24
HELPER_ACCEPTANCE: PASS
```

acceptance harness 覆盖 graceful、tree、root exit、control loss、helper loss、cancel，以及 ownership failure 时拒绝 CLI 执行。r7/r9 随后在官方 `ZCodeAgentProcessManager` 路径中启动和关闭两代 helper，目标 helper/AppServer PID 均在关闭后不可见；详见 [MINIMAL_HOST_ASSEMBLY.md](MINIMAL_HOST_ASSEMBLY.md)。

`BUILD_PROVENANCE.json` 同时明确：官方 `build-windows-runtime-host.mjs` 没有被直接执行。构建使用相同的固定 `CMakeLists.txt`、MSVC 和 Windows SDK NuGet packages 的等价 direct CMake 路径。因此：

- helper 制品和 Mock runtime：`PASS`；
- 官方构建脚本在标准 CI prerequisites 下的可重复性：`PARTIAL` 或本切片 `NOT_RUN`；
- 不能把 direct CMake 成功写成官方脚本已通过。

## 未关闭风险

- Windows runtime-host helper 的固定制品已通过 acceptance 和 r7/r9 正常路径，但 ProcessManager/Host 崩溃故障矩阵尚未运行。
- Browser、PTY、keyring、Koffi 和 native search 等按能力加载的模块未分别运行。
- 只验证 Windows x64；Windows arm64、Linux、macOS 不在本轮范围。
- 没有证明未来 Node 24 小版本的 ABI 行为完全一致；制品仍应固定实际 Node 版本或执行启动兼容门禁。
- 完整 Node native module matrix、官方 CI prerequisites 下的 helper rebuild 和 production Node distribution 仍为 `NOT_RUN`/`PARTIAL`。
