# ADR-063：Original E 插件素材来源与固定校验

> Status: DECISION
> Date: 2026-11-25
> Decision: Accepted（Owner 于 2026-11-25 以原始附件和纠正确认唯一目标）
> Baseline: `origin/preview` `6af69b55d7ecb660c2ad2c923888cf7f1e8886c8`
> Related: [Preview.17 D 线报告](../reports/preview17-d-icon-20261125.md)

## Context

“Original E”不是字母 E，也不是带浅色圆角底板的方案 E。Owner 提供的唯一
正确母版是 848×776 PNG：

- SHA-256：`61C3BAB2AD4C1DF6024CCA97C22D8ECD40AF19585C3204D8CC81650E7252CADB`
- PNG：8-bit RGB，无 alpha，白色背景
- 图形：紫到蓝渐变的双 Z 连续描边，左上一个带白色中心孔的紫色端点，
  右下一个带白色中心孔的蓝色端点，无外层容器

历史提交 `7d66c2dad` 的 `assets/icon.png` 与 `assets/logo.png` 是该母版
按目标宽度等比缩放、垂直居中并补白到方形画布的导出。视觉检查和重采样
误差均支持这一来源关系，因此直接使用历史 blob，不重新创作或重新生成。

此前把 `fb5c0a0a9` 的蓝色圆角双 Z 容器方案当成目标，是错误判断。该方案
的 logo blob 是 `4fb37d823ed963e1c3efae24f4377989bdf418dd`，不属于
`7d66c2dad`，不得恢复。

## Decision

### 1. 唯一素材身份

插件发布素材固定为：

| 文件 | Git blob | 尺寸 | PNG | 字节数 | SHA-256 |
|---|---|---:|---|---:|---|
| `assets/icon.png` | `783561004e952b7ad60a7bd3c7ff62239f99d031` | 128×128 | 8-bit RGB，无 alpha | 5,315 | `4C657714FE423243DA63191AE949FBF2DADC37FC8F994A6432FC1F92E2C4D1CC` |
| `assets/logo.png` | `5b9c7e08422817c1f51f414193e3e69d9ae4aaa0` | 512×512 | 8-bit RGB，无 alpha | 47,354 | `E97F3C292BE9A91A6F2E5BD01B04268D1EB36877921D856873F9070C1F34C5A0` |

两个 blob 均来自 `7d66c2dad`。白底是图像内容，不是透明 alpha；不得把
白底改成透明，也不得添加圆角容器。

### 2. Manifest 与发布链

- `plugin.json` 与 `.codex-plugin/plugin.json` 的 `logo` 固定引用
  `./assets/logo.png`，`composerIcon` 固定引用 `./assets/icon.png`。
- WebUI 顶栏品牌标必须嵌入同一份 `assets/icon.png` 的 PNG 字节（测试校验
  解码后 SHA-256），不得使用 `B/` 文字、近似图案或另行重绘。WebUI 是插件
  资产的消费者，不是新的素材来源。
- Marketplace 包、Release ZIP 和安装后的 Codex cache 必须包含上述同一
  份资产；安装缓存不能成为新的素材来源。
- 只有新的 Owner 决策可以替换素材。相似图案、重新绘制或不同导出包不得
  通过“看起来接近”覆盖固定资产。

### 3. 防回归门禁

`scripts/validate-plugin.mjs` 固定两个 manifest 引用、PNG 尺寸、文件
字节数与 SHA-256。真实 validator 测试注入合法 PNG 结构但改变像素，要求
固定哈希校验拒绝该素材。素材路径同时纳入 CI/release 影响域。

## Non-Changes

- 不修改插件 manifest schema、MCP 接口、任务状态或发布流程。
- 不改变 128×128 与 512×512 的目标尺寸。
- 不把 848×776 母版直接放入运行插件；它只作为来源证据。

## Verification

- 通过 Node `child_process.execFileSync("git", ["cat-file", "blob", ...])`
  二进制安全导出并目视核对两个历史 blob。
- 附件按目标宽度缩放并垂直补白后，`icon` 平均通道误差 `0.166`，
  `logo` 平均通道误差 `0.073`；未做重新生成。
- `npm run validate:plugin` 通过；负向素材测试通过。
- Preview.16 既有 Release ZIP 与已安装 Codex cache 均包含相同 blob 和
  SHA-256。
- 完整回归、跨平台 CI 与新的 Release 制品属于后续发布门禁，本 ADR 不把
  本地定向验证提升为发布通过。
