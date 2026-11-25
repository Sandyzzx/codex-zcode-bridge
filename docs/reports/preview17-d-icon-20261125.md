# Preview.17 D 线报告：Original E 插件素材恢复

> Status: RESEARCH（候选实现与验证记录）
> Date: 2026-11-25
> Worktree: `.run/preview17-d-icon-20261125`
> Branch: `codex/preview17-d-icon-20261125`
> Baseline: `origin/preview` `6af69b55d7ecb660c2ad2c923888cf7f1e8886c8`

## 1. Owner 确认目标

Owner 纠正后的唯一目标附件：

- 文件：`codex-clipboard-bb81676e-2b4d-4941-864f-61c517d9936c.png`
- 尺寸：848×776
- PNG：8-bit RGB，无 alpha，白色背景
- SHA-256：
  `61C3BAB2AD4C1DF6024CCA97C22D8ECD40AF19585C3204D8CC81650E7252CADB`
- 视觉：紫到蓝渐变的双 Z 连续描边；左上紫色端点、右下蓝色端点均带白色
  中心孔；无外层圆角容器

“Original E”指该 Owner 确认的方案，不是字母 E，也不是
`fb5c0a0a9` 的蓝色圆角底板方案。

## 2. 来源核对

使用 Node `child_process.execFileSync` 从 Git object database 二进制安全
导出历史 blob，再与附件逐像素统计和目视比对。

| 来源 | Git blob | 字节数 | SHA-256 | 结论 |
|---|---|---:|---|---|
| `7d66c2dad:assets/icon.png` | `783561004e952b7ad60a7bd3c7ff62239f99d031` | 5,315 | `4C657714FE423243DA63191AE949FBF2DADC37FC8F994A6432FC1F92E2C4D1CC` | Owner 目标 |
| `7d66c2dad:assets/logo.png` | `5b9c7e08422817c1f51f414193e3e69d9ae4aaa0` | 47,354 | `E97F3C292BE9A91A6F2E5BD01B04268D1EB36877921D856873F9070C1F34C5A0` | Owner 目标 |
| `fb5c0a0a9:assets/icon.png` | `5c59049c1a3829bc44fb055db04aa55eb64bb4e1` | 12,006 | `9D7F3DB2144C114C1363F3F7E35EE47DE3963EEE2A7BAAD8F58CBE0A4D8211E0` | 错误蓝色容器方案 |
| `fb5c0a0a9:assets/logo.png` | `4fb37d823ed963e1c3efae24f4377989bdf418dd` | 208,340 | `9627C97B31D52F49B49AD6945EE27618AB613D6E7CEAA95AA1C793CC80A8A2F2` | 错误蓝色容器方案 |

先前纠正消息中把 `4fb37d82…` 标为 `7d66c2dad` logo 候选有误；该 blob
实际属于 `fb5c0a0a9`。`7d66c2dad` logo 的准确 blob 是 `5b9c7e08…`。

附件按目标宽度等比缩放、垂直居中并补白到方形画布后，与历史导出的平均
绝对通道误差为：

| 导出 | 画布 | 图形高度 | 顶部偏移 | 平均通道误差 | 差异 > 5/765 像素 |
|---|---:|---:|---:|---:|---:|
| `icon.png` | 128×128 | 117.132 | 5.434 | 0.166 | 3.04% |
| `logo.png` | 512×512 | 468.528 | 21.736 | 0.073 | 1.44% |

差异集中在抗锯齿边缘，未发现图形、颜色、端点、留白或背景差异。无需
重新缩放或重新生成；恢复历史 blob 即可。

## 3. 实现

- `plugins/codex-zcode-bridge/assets/icon.png` 恢复为
  `783561004e952b7ad60a7bd3c7ff62239f99d031`。
- `plugins/codex-zcode-bridge/assets/logo.png` 恢复为
  `5b9c7e08422817c1f51f414193e3e69d9ae4aaa0`。
- 两个资产均为 8-bit RGB PNG、无 alpha 通道、白色背景；`icon` 为
  128×128，`logo` 为 512×512。
- `scripts/validate-plugin.mjs` 固定两个 manifest 引用、尺寸、字节数和
  SHA-256。
- `test/validate-plugin-root-pattern.test.ts` 增加真实 validator 负向
  用例：保留 PNG 结构但修改像素时必须失败。
- `test/test-impact-map.json` 将插件资产映射到
  `ci-release-contract`。
- 新增 [ADR-063](../decisions/ADR-063-original-icon-provenance.md)，并在
  决策索引登记。

## 4. Manifest、README、发布包与安装资源

| 检查 | 状态 | 证据 |
|---|---|---|
| 根 `plugin.json` 引用 | `PASS` | `logo=./assets/logo.png`，`composerIcon=./assets/icon.png` |
| `.codex-plugin/plugin.json` 引用 | `PASS` | 同上 |
| README 资产路径 | `PASS / NO_CHANGE` | README 不以额外路径重复声明素材 |
| Preview.16 既有 Release ZIP | `PASS` | ZIP 内 `assets/icon.png` 5,315 bytes / `4C6577…`；`assets/logo.png` 47,354 bytes / `E97F3C…` |
| 已安装 Codex Preview.16 cache | `PASS` | 两个资产与 ZIP、仓库目标同哈希 |
| 本地插件 `git archive` smoke | `PASS` | 包内两个资产与提交树同字节、同 SHA-256 |
| 新 Preview.17 Release ZIP | `NOT_RUN` | 本轮不 build/push/tag/release |
| 新候选重新安装后的图标刷新 | `NOT_RUN` | 需要后续集成与安装 |

## 5. 验证

| 命令/检查 | 结果 |
|---|---|
| Git blob 二进制安全导出与视觉核对 | `PASS` |
| 附件到历史导出的像素统计 | `PASS` |
| `npm run typecheck` | `PASS` |
| `npm run build` | `PASS` |
| `npm run validate:plugin` | `PASS` |
| `npm run check:generated` | `PASS` |
| validator 定向测试 | `PASS`，15/15 |
| `npm run test:affected -- --development` | `PASS`，52 pass / 0 fail / 1 platform skip；`FULL_SUITE_DEFERRED_TO_RELEASE_GATE` |
| 完整 `npm test` / Windows / Ubuntu CI | `NOT_RUN` |
| 新 Release 制品与全新安装 E2E | `NOT_RUN` |

通知类验证不替代真实 Codex UI 的图标缓存刷新；最终显示仍以重新安装候选
插件后的 Host 检查为准。
