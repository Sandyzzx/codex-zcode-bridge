# 官方源码制品再分发审查

> Status: RESEARCH
> Date: 2026-11-11
> 边界：工程与材料核对，不是法律意见；最终对外发布仍需 Owner/法务确认

## 已确认

固定源码根 `LICENSE` 标注 Apache License 2.0。源码提供：

- `NOTICE.md`
- `THIRD-PARTY-NOTICES.md`
- 各第三方包的原始许可文本与组件清单

构建同时生成 `dist/THIRD-PARTY-NOTICES.md`。这与源码根 notices 的 SHA256 相同：

```text
C4CC6DC747EB6026E41D2CEFC6679392C33E1192629EA96DC0DC702BCFE7C51C
```

Windows runtime-host helper 已生成固定 x64 PE：

```text
bytes: 167424
sha256: 04E1794F8325B3C46D4159420CDD04041E9AFC58516E03FC3DC8E78576EEFC24
```

它有固定的 `BUILD_PROVENANCE.json` 和 acceptance harness 结果，但官方 `build-windows-runtime-host.mjs` 未直接执行，构建使用等价的 direct CMake 入口。因此“二进制可追踪”不能替代“最终发行 BOM 完备”。

## 不能直接宣布完整可再分发的原因

1. Apache-2.0 不覆盖第三方、字体、图标、原生二进制和资源。
2. 265 KB builtin provider config、source map 和 bundle 的实际内容尚未逐项映射到 notice/inventory。
3. 当前 G1 只构建 CLI/AppServer，不包含官方 Desktop 的完整 runtime assets；发布闭包不是等价对象。
4. optional native 组件没有完整构建，相关平台能力不能凭源码存在推导为随包包含。
5. Windows runtime-host helper 的来源、输出 hash 和 acceptance 已记录，但 MSVC runtime 链接方式、SDK NuGet material、最终材料清单和官方脚本可重复构建仍未完成审查。
6. r7/r9 的 lifecycle reporter 和目标 PID 清理是 Mock runtime 证据，不是再分发材料，也不产生持久 Cleanup proof。
7. 真实品牌、商标、官方支持承诺和服务条款不在 Apache-2.0 文本中自动获得。

## 当前分发判断

```text
LOCAL_RESEARCH_USE: ALLOWED WITHIN TASK SCOPE
SOURCE_LICENSE_IDENTIFIED: PASS
NOTICE_MATERIAL_PRESENT: PASS
FULL_RUNTIME_ASSET_LICENSE_MAP: PARTIAL
WINDOWS_RUNTIME_HOST_ARTIFACT_IDENTITY: PASS
WINDOWS_RUNTIME_HOST_DISTRIBUTION_REVIEW: PARTIAL
PUBLIC_DISTRIBUTION_APPROVAL: NOT_GRANTED
```

因此本候选可保留为本地研究证据和隔离 Mock 验证制品，但不能把实验制品的“可运行”写成“可对外发布”。

## 发布前最低事项

- 生成与最终制品完全对应的 bundle/asset manifest。
- 将每个随包 native、WASM、helper、resource、font、icon 映射到许可和来源。
- 审计 helper 的 MSVC runtime 静态/动态依赖、Windows SDK NuGet material 和官方 build script 的 CI 可重复性。
- 保留 Apache-2.0 `LICENSE`、`NOTICE.md` 和对应第三方 notice。
- 检查修改过的文件并标注修改。
- 复核商标、服务条款、遥测、更新和官方端点使用边界。
- 对实际发行压缩包执行 clean-room 材料检查和哈希记录。
