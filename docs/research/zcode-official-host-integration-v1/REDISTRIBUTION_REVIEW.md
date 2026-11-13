# 官方源码制品再分发审查

> Status: RESEARCH — BOM PRESENT / REDISTRIBUTION REVIEW PARTIAL
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对 BOM、ZCode/LICENSE、third-party notices、fixed artifact inventory 与候选提交
> Verified against: Bridge candidate `ba25f837` + documentation changes；upstream `b95ebaff` / 3.18.0

## 已确认

- 固定来源 commit/tree、source version、build toolchain、ordered patches、bytes 和 SHA-256 已记录。
- `ARTIFACT_BOM.json` 记录 shipped files、角色、bytes、hash 和 license metadata。
- `app-server/THIRD-PARTY-NOTICES.md` 与 ZCode LICENSE 包含在 fixed tree。
- 6 个 `@napi-rs/keyring` package/native/license 文件已通过精确 `.gitignore` 例外纳入候选；提交后的 clean checkout 已验证文件复原、解析与 native 加载。
- 构建 trace/manifest 标明实际修改和 patch 顺序。
- 本次没有把用户 Desktop 安装包作为构建输入或发布对象。

## 当前判断

```text
LOCAL_CANDIDATE_EVALUATION: ALLOWED WITHIN TASK SCOPE
PRODUCTION_REDISTRIBUTION: PARTIAL / NOT APPROVED
```

BOM 和 notices 足以进入完整许可审查，但不足以宣布“整个发布包可再分发”。仍需以最终实际打包集合逐项确认：

- ZCode first-party source 与保留的版权/NOTICE
- Node、Node-API keyring、native helper 和 Windows runtime
- AppServer 内所有第三方库
- 字体、WASM、plugin、browser/tool resources 与 generated assets
- MIT/BSD/Apache、CC-BY、EPL/GPL 双许可等组件的具体义务
- 修改文件、动态链接/静态打包方式、源代码提供义务与商标边界

`THIRD-PARTY-NOTICES.md` 往往是跨发行形态的保守并集；只根据某一行出现 GPL 既不能判定整个产品受 GPL，也不能忽略该组件自己的条款。

## 未完成

- 最终发布 bundle 的逐文件许可映射
- 版权与 NOTICE 完整性复核
- native helper/keyring 的实际链接与再分发方式
- 完整动态资源矩阵及逐项再分发的法律/Owner 批准
- 字体/WASM/复制资源的来源和许可结论
- 产品名称、图标、商标及官方背书的独立审查
- 与法律或 Owner 的发布批准

## 结论

当前制品可以按研究范围做本地候选验证；生产再分发审查保持 `PARTIAL`。keyring 文件已解除 ignore，且 clean checkout 的 Git/BOM/加载一致；该工程证明不是逐项再分发许可结论。
