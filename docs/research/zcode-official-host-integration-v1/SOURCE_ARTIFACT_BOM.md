# 官方源码执行制品 BOM

> Status: RESEARCH
> Date: 2026-11-11
> 范围：G1 CLI 与最小 host module artifact、G2 Windows runtime-host helper 与隔离 Mock；不是完整 Desktop 发行 BOM

## 固定输入

| 类别 | 输入 | 身份 |
|---|---|---|
| Source | ZCode public source | commit `b95ebaffeab641907b38652f45c1502bd762972d` |
| Source tree | Git tree | `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d` |
| Product version | root `package.json` | `3.18.0` |
| AppServer CLI | `zcode.cjs --version` | `0.17.1` |
| Lockfile | `pnpm-lock.yaml` | SHA256 `392355F908297AFD0B7B169B603335F0543FCB752D5110B6016AEF51067C8F85` |
| Package manifest | `package.json` | SHA256 `9DAC0201C599D58C92713C6440DEC3FB7BA33093D07B1CBD4D60BDD32BD4AF1C` |
| Toolchain pin | `mise.toml` | SHA256 `515397FBFC021BDF347178B20FE2B776777F52DB06E8CBF933181E10CF8F231C` |
| Node | actual builder | `v24.16.0`, modules ABI 137 |
| pnpm | actual builder | `10.33.2` |
| Platform | tested artifact | Windows x64; Windows 11 `10.0.26100` |
| Helper source digest | `SHA256(main.cpp bytes || CMakeLists.txt bytes)` | `1E40EC438E4C37FFBEF09408574501130B52BEDD62409B61D4EF9F517672B93F` |
| Official helper build script | `scripts/build-windows-runtime-host.mjs` | SHA256 `0155D06E8D7DA4EBF725469A04BC9FC15138A734C13DAA33B3CF094FE69DCCC7`；`usedDirectly=false` |
| Helper compiler | CMake / MSVC | CMake `3.31.6-msvc6`；MSVC `19.44.35229 for x64` |
| Windows SDK packages | NuGet CPP + x64 | version `10.0.26100.4948` |
| Host module build script | local esbuild driver | `.run/official-host-poc/build-host-runtime-bundle.mjs` |
| Host module entries | fixed upstream exports | `ZCodeAgentProcessManager`, `ZCodeProtocolClient`, `ZCodeStdioTransport` |

SDK package hashes recorded by provenance:

| Package | SHA256 |
|---|---|
| `Microsoft.Windows.SDK.CPP` | `8C17F5BEB7616CBFB665F76F2E1AD74ECEAF7B97C8EF1D0BBC4CA2EB9E525413` |
| `Microsoft.Windows.SDK.CPP.x64` | `8150A2F0DC69FD2B2A3AFD6D66B38E3DBAB2B901CC5DC65DE42BE4836C3953F3` |

## 执行制品

| 文件 | 必需性 | Bytes | SHA256 |
|---|---|---:|---|
| `cli/zcode.cjs` | REQUIRED | 30,999,438 | `DF4637F2E31AEDE37DB15B3E4E8D8BE35F59BF756E4EECFFC0A6A6B1EEDB4F2E` |
| `cli/provider/zcode-builtin.json` | REQUIRED for provider registry | 265,884 | `BC760A3B0C6D096EA07EE4E963471F135AE75AB207DB6ED4C372E1B183C856CD` |
| `cli/THIRD-PARTY-NOTICES.md` | REQUIRED for review | 3,465,209 | `C4CC6DC747EB6026E41D2CEFC6679392C33E1192629EA96DC0DC702BCFE7C51C` |
| `cli/zcode.cjs.map` | DEVELOPMENT/DIAGNOSTIC | 57,001,458 | `205404F621D86A0D2B5A30C0A8F1392C4679133917CFC907F9D17D3F627FE29B` |
| `runtime-host-artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/zcode-runtime-host.exe` | REQUIRED on Windows for official ProcessManager | 167,424 | `04E1794F8325B3C46D4159420CDD04041E9AFC58516E03FC3DC8E78576EEFC24` |
| `runtime-host-artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/zcode-runtime-host-acceptance.exe` | ACCEPTANCE HARNESS | 190,976 | `33E70B20A430393081920225E6A2848A2F28CB68881B03E97EBF88ADEB8E70A3` |
| `runtime-host-module-artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/official-host-runtime.mjs` | REQUIRED for self-contained r8/r9 host path | 1,611,888 | `0DE82EB939F48F8D97E697BEFB7F937BA13723E965C27960DA2A4C5BCB8092DC` |
| `g2-process-manager-probe.compiled.mjs` | TEST PROBE for current r9 | 27,694 | `A00C35093E1A8421FD22C2B64A791E1F96AF561A0D95C51A2473B4C49B66EDE3` |

上面的 helper 和 acceptance harness 都位于项目 worktree 的 ignored `.run` 目录。r7 实际通过
`.run/official-host-poc/runtime-host-build-nuget-r5/zcode-runtime-host.exe` 启动 helper；该文件与
canonical artifact 的 SHA256 相同，均为 `04E1...FC24`。

## 自包含 host module artifact

路径：

```text
.run/official-host-poc/runtime-host-module-artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/official-host-runtime.mjs
```

```text
source commit/tree: b95ebaffeab641907b38652f45c1502bd762972d / d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d
source version: 3.18.0
bytes: 1611888
sha256: 0DE82EB939F48F8D97E697BEFB7F937BA13723E965C27960DA2A4C5BCB8092DC
external imports: Node builtins only; no external package import
repeat bundle identity: PASS
```

provenance：

```text
.run/official-host-poc/runtime-host-module-artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/BUILD_PROVENANCE.json
```

该 provenance 固定 source commit/tree/version、三个 entry exports、对应 upstream source files，以及输出路径、bytes 和 SHA256。构建入口是 `.run/official-host-poc/build-host-runtime-bundle.mjs`。以同一输入重复 bundle 得到相同字节；这不是跨 clean install 的 CLI byte identity 证明。

r9 用当前保留的自包含 probe：

```text
.run/official-host-poc/g2-process-manager-probe.compiled.mjs
bytes: 27694
sha256: A00C35093E1A8421FD22C2B64A791E1F96AF561A0D95C51A2473B4C49B66EDE3
```

以普通 Node 加载上述 host bundle 和 compiled probe，不经过 tsx 或 source `node_modules`。`process-manager-r9` 的 12/12 断言通过，并用新的 AppServer/helper 两代 PID 完成任务，证明该最小 module artifact 的子路径可执行。r8 在先前的同一路径上也曾 12/12 PASS，其 evidence 记录当时的 probe SHA256 为 `0B6728397DE8830C712308ED49E0DA8EC0F06466F169609330DC2B243C9D40B4`；当前同名文件已被 r9 覆盖。

## 已证实的最小运行闭包

将 CLI 制品前两项及 notice 复制到无源码 `node_modules` 的独立目录后，AppServer 完成了本地 Mock 的 session、官方 Read、工具后续推理、usage、resume、cancel 和关闭。随后官方 `ZCodeAgentProcessManager`、CLI 制品、固定 helper 和 localhost Mock 联合完成 r7 的 12 个结构化断言。r8/r9 又使用自包含 host module artifact、compiled probe、固定 CLI/helper 和 localhost Mock 各完成 12/12。

这只证明基础执行路径可在该隔离制品上运行。以下能力仍需要各自触发验证：

- Playwright/Browser
- terminal / node-pty
- keyring/真实账户
- koffi/Windows Job API
- MCP、插件、技能和文档工具
- macOS/Linux 制品

## 排除项

- 没有把 Desktop `app.asar`、Electron Main、Renderer、updater 或安装版 AppServer 计入源码制品 BOM。
- 没有把用户 Desktop 数据、凭据、日志或设备身份计入。
- 没有把实验用本地 Mock 服务打包。
- 没有因为源码 pnpm store 中存在某 native 包就宣称运行时一定需要或已经验证。
- 自包含 host module 的 builtins-only import 边界不等于完整 Desktop native/resource closure。
- 本 BOM 不构成正式发行许可或对外分发批准。

## Helper provenance 与 acceptance

固定 provenance：

```text
.run/official-host-poc/runtime-host-artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/BUILD_PROVENANCE.json
```

该记录包含 upstream commit/tree、helper source digest、toolchain、SDK packages、构建命令、输出 hash、PE architecture 和 acceptance 结果。它明确记录官方 `build-windows-runtime-host.mjs` 未直接执行，原因是没有脚本要求的 Visual Studio 17 2022 generator 和可发现的独立 Windows SDK。实际构建使用官方同版本 `CMakeLists.txt`、MSVC 和 `Microsoft.Windows.SDK.CPP` NuGet packages。

acceptance：

```text
command: zcode-runtime-host-acceptance.exe zcode-runtime-host.exe
status: PASS
scenarios: graceful, tree, root-exit, control-loss, helper-loss, cancel,
           ownership failure rejects CLI execution
result: .run/official-host-poc/runs/runtime-host-acceptance-r1/acceptance-result.json
log: .run/official-host-poc/runs/runtime-host-acceptance-r1/acceptance.log
```

这只证明该固定二进制通过 helper acceptance harness，并在 r7/r8/r9 的隔离 Mock 路径中运行。它不证明官方构建脚本可被当前机器直接执行，也不建立对外再分发许可结论。

## 未完成证据

- 完整 production dependency graph 的逐包许可清单与产物映射
- 官方 helper build script 在标准 CI prerequisites 下的可重复构建
- 跨 clean-install 的 CLI first-build byte identity
- 完整 native/WASM/resource closure
- 对外压缩包、签名、更新和回滚清单
- 最终发行材料清单、许可映射和法务/Owner 批准
