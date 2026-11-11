# G1：官方 ZCode 3.18.0 源码构建

> Status: RESEARCH
> Date: 2026-11-11，Asia/Shanghai
> Bridge baseline: `9710303397fe2d544c75698f783a8174404b2d51`
> Observed upstream: ZCode commit `b95ebaffeab641907b38652f45c1502bd762972d`，tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`，根版本 `3.18.0`
> 结论范围：源码构建通过；隔离制品的直接 AppServer Mock 冒烟通过。官方 ProcessManager、runtime-host helper 和最小 Host 的隔离 Mock 结果另见 [MINIMAL_HOST_ASSEMBLY.md](MINIMAL_HOST_ASSEMBLY.md)。

## 结论

官方公开源码已经在隔离目录中成功生成 CLI/AppServer 执行制品，且只复制该制品的 `dist` 内容、脱离源码 `node_modules` 后，仍完成了本地 Mock 场景。

```text
G1_OVERALL: PARTIAL
ZCODE_SOURCE_BASELINE: PASS
SOURCE_BUILD: PASS
MINIMAL_ARTIFACT_DIRECT_RPC_SMOKE: PASS
MINIMAL_HOST_MODULE_ARTIFACT: PASS
MINIMAL_HOST_MODULE_ARTIFACT_SCOPE: WINDOWS_X64_NODE_24.16.0_ZCODE_3.18.0_R9
HOST_MODULE_REPEAT_BUNDLE_BYTE_IDENTITY: PASS
NODE_ABI_COMPATIBILITY: PARTIAL
NATIVE_DEPENDENCIES: PARTIAL
RESOURCE_CLOSURE: PARTIAL
REDISTRIBUTION_REVIEW: PARTIAL
ARTIFACT_REPRODUCIBILITY: PARTIAL
```

这里的 `PASS` 不等于完整 Desktop 能力或真实账户能力。`zcode.cjs --version` 报告 `0.17.1`，root package version 为 `3.18.0`；报告同时记录两者，不能互相替代。

`ARTIFACT_REPRODUCIBILITY` 为 `PARTIAL`：同一 dependency tree 原地重复 build 与最初制品逐字节一致；但另一个 clean checkout 首次 install 后第一次 build 的 `zcode.cjs` 和 map 与最初制品不一致。不能把这两项事实合并写成完整 reproducibility PASS。

`MINIMAL_HOST_MODULE_ARTIFACT` 是另一条独立的 G1 证据：固定 g1r2 source 经 esbuild tree-shake 生成 1,611,888 bytes 的自包含 `official-host-runtime.mjs`，SHA256 为 `0DE82EB939F48F8D97E697BEFB7F937BA13723E965C27960DA2A4C5BCB8092DC`。除 Node builtins 外没有外部 import，同输入重复 bundle 字节一致，并在 r8/r9 中各通过 12/12 断言。该 PASS 只覆盖 Windows x64 / Node 24.16.0 / ZCode 3.18.0。

## 基线

| 项 | 实测值 |
|---|---|
| Source checkout | `D:\codex-zcode-bridge\.run\companion-runtime-validation-20261111\source` |
| Commit | `b95ebaffeab641907b38652f45c1502bd762972d` |
| Tree | `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d` |
| Root version | `3.18.0` |
| AppServer CLI version | `0.17.1` |
| Tracked worktree status before build | clean |
| Official freshness preflight | `node scripts/check-workspace-freshness.mjs` passed |

## 工具链与安装

| 项 | 实测值 | 结果 |
|---|---|---|
| 实际执行 Node | `v24.16.0` | 满足 root `>=24.0.0`，高于官方 mise 的 `24.14.0` |
| pnpm | `10.33.2` | 与 root `packageManager` 完全一致 |
| 官方 mise | Node `24.14.0` / pnpm `10.33.2` | Node 未被逐项等同 |

首次 `pnpm install --frozen-lockfile` 在 `vite/esbuild` 临时目录 rename 阶段失败：

```text
ERR_PNPM_ENOENT
```

使用同一个隔离 store、固定 pnpm 包装器和 `--child-concurrency=1` 重试后退出码为 `0`。因此：

```text
DEPENDENCY_LOCKFILE: PASS
FIRST_INSTALL_ATTEMPT: FAIL_ENOENT
FIXED_TOOLCHAIN_INSTALL_RETRY: PASS
```

安装期间有两个 optional native 组件未构建：

- `cpu-features`: `Unable to detect compiler type`
- `ssh2` optional crypto binding: 缺少 Windows SDK `10.0.26100`

基础 AppServer Mock 路径未依赖这两项，但不能据此宣称完整 native closure 通过。

## 构建

固定工作目录执行：

```powershell
pnpm --filter "@zcode/cli..." build
```

结果为退出码 `0`，构建范围 18 个 workspace package。构建生成：

- `apps/zcode-cli/packages/cli/dist/zcode.cjs`
- `apps/zcode-cli/packages/cli/dist/zcode.cjs.map`
- `apps/zcode-cli/packages/cli/dist/provider/zcode-builtin.json`
- `apps/zcode-cli/packages/cli/dist/THIRD-PARTY-NOTICES.md`

构建日志与哈希证据位于 worktree 内 ignored `.run/official-host-g1/`；Git tracked 源码没有因构建产生修改。

## g1r2：跨 install 重复构建

独立 checkout：

```text
D:\codex-zcode-bridge\.run\g1r2
```

其 HEAD/tree 仍为：

```text
HEAD: b95ebaffeab641907b38652f45c1502bd762972d
tree: d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d
```

`package.json`、`pnpm-lock.yaml` 和 `mise.toml` 的哈希与原 source checkout 相同。offline frozen install 最终 PASS；首次仍因本地 pnpm store 缺少 `@fontsource/noto-sans-sc@5.3.1` 失败，使用 `pnpm store add` 加入本地已下载 tarball 后，同一条 install 命令通过。

clean checkout 的首次 build 也 PASS，但 CLI 两个产物为：

| 文件 | Bytes | SHA256 |
|---|---:|---|
| `zcode.cjs` | 30,998,734 | `5EEEB739E646952D3DD2F1109006C7C0BA56CF2E406B5B8012686C5D1EA3140B` |
| `zcode.cjs.map` | 57,001,106 | `91EB5C8F90E46E1B452DCA32120C849B649633EF3672E538FC33CA51347DFF9A` |

随后在相同 dependency tree 原地执行第二次 build，命令 PASS。四个产物与最初 artifact 逐字节一致：

```text
zcode.cjs:               DF4637F2E31AEDE37DB15B3E4E8D8BE35F59BF756E4EECFFC0A6A6B1EEDB4F2E
zcode.cjs.map:           205404F621D86A0D2B5A30C0A8F1392C4679133917CFC907F9D17D3F627FE29B
provider/zcode-builtin.json: BC760A3B0C6D096EA07EE4E963471F135AE75AB207DB6ED4C372E1B183C856CD
THIRD-PARTY-NOTICES.md:  C4CC6DC747EB6026E41D2CEFC6679392C33E1192629EA96DC0DC702BCFE7C51C
```

diff 显示 clean-install 的首次构建选择了不同的 hoisted dependency path；原地第二次 build 后路径归一。由此只能得到：

```text
OFFLINE_FROZEN_INSTALL_AFTER_LOCAL_STORE_SEED: PASS
FIRST_BUILD_AFTER_CLEAN_INSTALL: PASS
SAME_DEPENDENCY_TREE_REPEAT_BUILD_BYTE_IDENTITY: PASS
CROSS_INSTALL_FIRST_BUILD_BYTE_IDENTITY: NOT_STABLE
ARTIFACT_REPRODUCIBILITY: PARTIAL
G1R2_TRACKED_STATUS: CLEAN
```

该结论表示构建可重复执行，但不同 install 后的首次 build 尚未达到逐字节稳定。由于第二次 build 会令路径归一，两份首次产物不能被合并为同一 reproducibility PASS。

证据：

```text
.run/official-host-g1/logs/g1r2-install.log
.run/official-host-g1/logs/g1r2-build.log
.run/official-host-g1/logs/g1r2-build-repeat.log
```

## 隔离制品冒烟

实验只复制 `dist` 到：

```text
.run/official-host-g1/artifact/win32-x64-node24.16.0-zcode3.18.0-b95ebaff/cli
```

该目录没有相邻源码 `node_modules` 可供普通模块回退。随后只允许访问 `127.0.0.1` 上的本地 OpenAI Chat Completions Mock，结果：

| 检查 | 结果 |
|---|---|
| AppServer 版本与启动 | PASS，`0.17.1`，退出码 0 |
| Session create | PASS |
| 模型选择 | PASS |
| 第一次本地 Mock 请求 | PASS |
| 官方 `Read` 工具 | PASS |
| 第二次请求携带 `tool` 结果 | PASS |
| Turn success | PASS，`resultType=success` |
| Token usage | PASS，2 次模型请求汇总 220 tokens |
| Event replay | PASS |
| AppServer 正常关闭 | PASS，code 0 |
| 顺序重启后 resume | PASS |
| Cancellation | PASS，`resultType=cancelled` |
| 最终关闭 | PASS，code 0 |

这个冒烟直接向 AppServer 发送固定 JSON-RPC，使用 `ZCodeAgentProcessManager` 的最小 Host 装配尚不能由本文件宣称通过。

后续 r7、r8 和 r9 已单独完成官方 ProcessManager 路径，各为 12/12 PASS，并使用本次构建的同一 `zcode.cjs` hash。r8/r9 进一步使用树摇后的自包含 host module artifact 和 compiled probe，以普通 Node 运行，不通过 tsx 或 source `node_modules`。r9 是当前保留的最新运行。它们都只覆盖 localhost Mock、单 workspace、单活动执行 AppServer；见 [MINIMAL_HOST_ASSEMBLY.md](MINIMAL_HOST_ASSEMBLY.md)。

## 制品身份

| Path | Bytes | SHA256 |
|---|---:|---|
| `zcode.cjs` | 30,999,438 | `DF4637F2E31AEDE37DB15B3E4E8D8BE35F59BF756E4EECFFC0A6A6B1EEDB4F2E` |
| `zcode.cjs.map` | 57,001,458 | `205404F621D86A0D2B5A30C0A8F1392C4679133917CFC907F9D17D3F627FE29B` |
| `provider/zcode-builtin.json` | 265,884 | `BC760A3B0C6D096EA07EE4E963471F135AE75AB207DB6ED4C372E1B183C856CD` |
| `THIRD-PARTY-NOTICES.md` | 3,465,209 | `C4CC6DC747EB6026E41D2CEFC6679392C33E1192629EA96DC0DC702BCFE7C51C` |

## 未完成

- 跨两次 install 的 first-build 逐字节可重复性：`PARTIAL`；同 dependency tree 的 repeat build 已 PASS，但 clean-install first-build 尚不稳定
- Minimal host module artifact：Windows x64 / Node 24.16.0 / ZCode 3.18.0 的 r8/r9 路径 `PASS`；同输入重复 bundle 字节一致
- Windows runtime-host helper：固定 helper 已构建并通过独立 acceptance 和 r7/r8/r9 Mock；官方 build script 未直接执行，CI 可重复构建仍 `PARTIAL`
- 全 native/WASM/资源闭包：`PARTIAL`；host module 仅依赖 Node builtins 的 bundle 边界不覆盖此闭包
- 对外再分发结论：`PARTIAL`，不构成法律意见
- 真实 Desktop/账户/Start Plan/Billing/模型 E2E：`NOT_RUN`
