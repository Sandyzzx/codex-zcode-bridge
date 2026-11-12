# G1：官方 ZCode 3.18.0 源码构建

> Status: RESEARCH — FIXED SOURCE BUILD PASS / CLEAN-INSTALL REPRODUCIBILITY PARTIAL
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对当前两次 fixed-source build、`official-host-repeatability-current.json` 和 artifact manifest
> Verified against: ZCode `b95ebaff` / tree `d7ebeb99`；Bridge candidate `ba25f837` + documentation changes

## 结论

固定 ZCode 3.18.0 源码、三个有序 patch、AppServer 0.17.1、Host module 和 Windows helper 已在 Windows x64、Node 24.16.0 环境中成功构建。两次在同一固定 source tree 上构建的主要输出 byte-identical，`official-host-runtime.mjs` SHA-256 均为：

```text
3F481AAE16EFF9912DAF17178B49491BD64E67C4419BFFDB59EB4B78E85EB537
```

这证明当前固定输入可在该 source tree 上重复，不证明全新依赖安装、不同机器、不同时间或第二个 clean checkout 都能得到相同结果。

## 工具链

- Build/validation Node: `24.16.0`
- Official mise Node pin: `24.14.0`（未被直接用作当前 Bridge 验证运行时）
- Official pnpm: `10.33.2`
- Validation pnpm: `11.25.0`
- esbuild: `0.28.2`
- MSVC: `19.44.35229` x64
- Windows SDK C++: `10.0.26100.4948`
- CMake generator: NMake Makefiles
- Runtime-host build type: Release

## Patch 与输入

1. `0001-stdio-max-frame-bytes.patch`
2. `0002-oauth-refresh-coordination.patch`
3. `0003-account-runtime-header-coordination.patch`

Patch 必须按序应用；字节数和 SHA-256 见 [制品 BOM](SOURCE_ARTIFACT_BOM.md)。构建不修改 tracked upstream source，不使用用户 Desktop 安装作为输入。

## 输出

- `app-server/zcode.cjs`
- `app-server/provider/zcode-builtin.json`
- `app-server/THIRD-PARTY-NOTICES.md`
- `official-host-runtime.mjs`
- `zcode-runtime-host.exe`
- `ARTIFACT_BOM.json`

BOM 还记录 LICENSE、Node-API keyring binding 和依赖 metadata。runtime 与 plugin validator 会校验 required files、hash、patch 顺序和 fixed entrypoint。pre-review 发现 6 个 BOM 文件被顶层 `node_modules/` ignore 排除；根工作区已加入精确例外并将它们纳入候选，提交后的 clean checkout 已证明文件复原、解析和 native 加载通过。

## 失败历史

构建过程中曾因 install/build 环境与官方 pin 不完全一致出现诊断；最终 fixed-source build 两次成功。旧失败尝试不能删除，也不能表述成最终 build PASS。当前结果以 `official-host-build-current-1.log`、`official-host-build-current-2.log` 和 `official-host-repeatability-current.json` 为准：两次输出均为 1,821,168 bytes、SHA-256 `3F481AAE...537`，BOM 为 7,260 bytes、`B9A7104D...129C`。

## 未完成

- fresh clean checkout + empty dependency cache 的可复现构建
- 不同机器与空 dependency cache 的 keyring/native/resource closure
- 其他 Windows patch/architecture/SDK 组合
- Linux/macOS helper/Host build
- 完整 optional native/resource 闭包
- 官方 Host 制品升级和回滚
- 发布包级 license conclusion

## 结论

```text
FIXED_SOURCE_ARTIFACT_BUILD: PASS
SAME_SOURCE_TREE_REPRODUCIBILITY: PASS
CROSS_CLEAN_INSTALL_REPRODUCIBILITY: PARTIAL
CROSS_PLATFORM_BUILD: NOT_RUN
```
