# 机器观测与宿主报告

> Status: AUTHORITATIVE
> Last updated: 2026-11-15
> Last verified: 2026-11-15，核对 Preview.6 后的 SQLite-only 字段、Runtime Usage、Events Summary、`zcode_feedback` 机器投影与默认 13 工具面；真实 Host 文案消费和模型缓存收益未执行 A/B。
> Verified against: `7e717621c1de0fb56b3ac19e22e242d856445db4` + Preview.6 post-audit candidate

## 事实来源

Bridge 面向机器 Host。默认 MCP 工具面、Task/Result 字段和 SQLite 持久事实是产品接口；Skill 不再要求生成固定人类 Markdown transcript、A4 表格或 Codex Rollout token 报告。

- `zcode_status` 提供当前 Task/Attempt、Worker/Runtime 观测、Result、Cleanup 与 Attention 的机器字段。
- `zcode_events(view="summary")` 合并同一 Attempt 内连续的安全模型文本片段，并保留单调 `next_seq`、`max_bytes`、Attention 屏障与 Raw 模式。
- `zcode_feedback` 是当前 Attempt 的简洁机器投影。它不替代 `zcode_status`、`zcode_events` 或 `zcode_result`，也不要求 Host 再渲染人类表格。
- `zcode_result` 是持久 Result；32 MiB canonical Result 合同保持不变。

Host 向用户说明结果时，可直接根据这些机器事实组织当前对话所需的文字，但不得把 Bridge 状态、Worker 自报、独立验收、Cleanup 和 Release 混成一个 PASS。

## Usage

Runtime Usage 只采用官方 Runtime 提供的值：

- `cached_input_tokens` 映射官方 Cache Read。
- 可选 `cached_write_input_tokens` 映射官方 Cache Write，不与 Cache Read 混合。
- 缺失值保持 `null`；真实零保持 `0`。
- `source`、`scope`、`finality` 与 `conflict` 随 Usage 一起保留。
- 同一 Session 的累计统计不得重复累加；不明 Scope 不得改写为单次 Usage。
- 不从字符数、Duration、账号额度或历史 Task 推算 Token。

没有可用的 Codex Host Token 采集链。Bridge 不再读取 Rollout、扫描其他会话或运行 `codex-master-token-usage.mjs`。

## 模型与验收

模型身份只采用 Runtime 事件或 Result 中的 `provider_id`、`model_id` 与 reasoning 证据。请求值可以单独标注，不能冒充实际执行值。

AgentReport 是 Worker 结构化输出，不是独立验收。Host 应分别说明：

1. Bridge Task/Attempt 状态。
2. Result 是否已持久化。
3. Worker/AppServer/helper 生命周期与 Cleanup。
4. SQLite Release CAS 是否完成。
5. 当前 Host 是否实际检查了 diff、文件 hash 或测试输出。

权限、凭据、JWT、Cookie、Authorization Header、Device Mid 与原始 Provider 请求不得进入公开报告。
