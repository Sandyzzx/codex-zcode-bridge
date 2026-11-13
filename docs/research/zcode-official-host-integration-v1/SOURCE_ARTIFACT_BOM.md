# 官方 Host 制品 BOM 与来源

> Status: RESEARCH — FIXED WINDOWS X64 ARTIFACT / LICENSE REVIEW PARTIAL
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对 `BUILD_PROVENANCE.json`、`ARTIFACT_BOM.json` 和当前两次构建产物
> Verified against: Bridge candidate `ba25f837` + documentation changes；upstream ZCode `3.18.0`

## 固定来源

| 项目 | 值 |
|---|---|
| ZCode version | `3.18.0` |
| Commit | `b95ebaffeab641907b38652f45c1502bd762972d` |
| Tree | `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d` |
| AppServer | `0.17.1` |
| Platform | Windows x64 |
| Node | `24.16.0` |
| user Desktop install as input | `NO` |
| tracked source modified by build | `NO` |

构建使用有序 patch；`ARTIFACT_BOM.json` 与运行时 validator 均要求顺序和哈希一致。

## Patch

| Order | Patch | Bytes | SHA-256 |
|---:|---|---:|---|
| 1 | `0001-stdio-max-frame-bytes.patch` | 16,290 | `80E77CA5D322141B93D6B035BDB8A7903F575BF78012FABA5B701B0541B29844` |
| 2 | `0002-oauth-refresh-coordination.patch` | 49,456 | `7AD85F0403CFA6AE55DAFDACE79FBB26C8970E758CEBE2496C4344A2108C651F` |
| 3 | `0003-account-runtime-header-coordination.patch` | 21,461 | `BD0A891EC19AD98571CEE053930BA9A45DFE879204436B377C5D56D66F5EC35D` |

Aggregate patch diff SHA-256：

```text
39D980C47C553B39D91F73748B63B794FAB18360B008728233B4C5BA70D7495F
```

## 主要 shipped files

| Path | Bytes | SHA-256 |
|---|---:|---|
| `app-server/zcode.cjs` | 30,999,438 | `DF4637F2E31AEDE37DB15B3E4E8D8BE35F59BF756E4EECFFC0A6A6B1EEDB4F2E` |
| `app-server/provider/zcode-builtin.json` | 265,884 | `BC760A3B0C6D096EA07EE4E963471F135AE75AB207DB6ED4C372E1B183C856CD` |
| `app-server/THIRD-PARTY-NOTICES.md` | 3,465,209 | `C4CC6DC747EB6026E41D2CEFC6679392C33E1192629EA96DC0DC702BCFE7C51C` |
| `official-host-runtime.mjs` | 1,821,168 | `3F481AAE16EFF9912DAF17178B49491BD64E67C4419BFFDB59EB4B78E85EB537` |
| `zcode-runtime-host.exe` | 167,424 | `04E1794F8325B3C46D4159420CDD04041E9AFC58516E03FC3DC8E78576EEFC24` |
| `ARTIFACT_BOM.json` | 7,260 | `B9A7104DAB3B10250CA93899324C0B33966E64C0BE02F279A1353BABBA8F129C` |

完整 inventory 还包括 ZCode LICENSE、Node-API keyring binding 及其 package/license metadata，以及 BOM 中逐文件记录的其它依赖。pre-review 发现顶层 `node_modules/` ignore 会让 6 个 BOM 文件缺席 Git；根工作区已加入精确例外，以下文件已纳入本地候选提交：

```text
node_modules/@napi-rs/keyring/LICENSE
node_modules/@napi-rs/keyring/index.js
node_modules/@napi-rs/keyring/package.json
node_modules/@napi-rs/keyring-win32-x64-msvc/LICENSE.third-party.md
node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node
node_modules/@napi-rs/keyring-win32-x64-msvc/package.json
```

提交后的 clean checkout 已通过路径解析、native 加载、BOM hash 与安装包结构验证；完整动态资源闭包与逐项 license 审查仍不能据此标为 `PASS`。权威机器文件位于：

```text
plugins/codex-zcode-bridge/worker/vendor/official-host/
  win32-x64-node24.16.0-zcode3.18.0-b95ebaff/ARTIFACT_BOM.json
```

## 验证结果

- 当前两次同固定 source-tree 构建成功，输出、BOM 和 provenance 哈希一致。
- `official-host-runtime.mjs` 两次各 1,821,168 bytes，byte-identical。
- runtime/plugin validator 校验 manifest、patch 顺序、shipped files、哈希和 Worker bundle 的官方 Host 标记。
- 提交后的 clean checkout 中 6 个 keyring BOM 条目均存在，bytes 和 SHA-256 与 `ARTIFACT_BOM.json` 一致，native binding 可加载。
- `userDesktopInstallationUsedAsInput` 为 false；本次证据未启动 Desktop Main 作为输入。

## 不能推导

same-source-tree repeatability 不等于从全新环境下载依赖仍可复现，也不证明所有 native/resource 文件、许可证义务和安装机器上的可选依赖都已闭合。跨 clean install reproducibility、完整 native/resource closure 和逐项 redistribution review 仍为 `PARTIAL`。
