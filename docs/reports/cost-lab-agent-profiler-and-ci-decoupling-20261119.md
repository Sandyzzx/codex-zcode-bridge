# Cost Lab Agent Token Profiler、Web 双语与 CI 解耦报告

> 状态：RESEARCH
> 日期：2026-11-19
> 分支：`codex/cost-lab-agent-profiler-20261119`
> 基线：`f5390897978be995b3a942feaeaac0170e8849fa`
> 生产 Bridge：未修改
> 真实模型请求：0

## 1. 结论

本轮在 `tools/cost-lab/` 内完成了三类工作：

1. 新增只读 Agent Token Profiler，用于关联 Codex rollout、Bridge SQLite、MCP 调用和响应级 Usage。
2. Cost Lab Web UI 新增 English / 中文切换，并将所有界面文案与证据状态分离。
3. CI 将 Cost Lab 与测试执行契约拆成独立 track，避免每次 Cost Lab 变更都触发 Bridge/Fast 全量回归。

本轮没有发起模型请求，没有修改生产 Bridge 认证、路由、Worker、SQLite Authority、Plugin Bundle、Master Skill 或 Start Plan 执行链。

## 2. Agent Token Profiler

### 2.1 数据范围

Profiler 只读取：

- Codex rollout JSONL / Zstd rollout；
- Bridge SQLite 的任务、attempt、事件和结果元数据；
- 观测到的 response-level Usage；
- MCP 工具调用时间、字节数和调用结果分类。

Profiler 不保留：

- Prompt、reasoning 或源码正文；
- MCP 参数和工具输出正文；
- 凭据、Authorization Header、Cookie 或 OAuth 内容；
- 未观测到的 Token 估算为 Provider Usage。

### 2.2 归因规则

- `OBSERVED`：Codex 或 Bridge 实际报告的 response/worker Usage。
- `ATTRIBUTED`：由时间、工具名、父子关系和 dispatch ID 推导出的阶段或 MCP 关系。
- `ESTIMATED`：本地内容字节到 Token 的估算，不能当作 Provider Usage。
- `UNKNOWN`：缺失 Usage 或无法可靠归因的字段，保持未知。

Cached input 不被重复加入 input。每个 provider/model 分组独立汇总，不把不同计费单位合并。

### 2.3 时间范围修复

时间范围筛选不能再复用 Agent 整段会话的 cumulative `usage`。本轮修改为：

- 区间内只使用 response-level Usage 重新聚合；
- 不截断或推算 cumulative checkpoint；
- 无时间戳的 context item 不进入时间范围统计；
- rollout 和 Bridge context item 新增 `observed_at`，仅保留时间元数据；
- 工具区间按与筛选窗口重叠判断，避免边界遗漏。

新增回归测试验证：完整 660 Token 的合成会话在选中两个响应后只输出 220 Token，且阶段守恒仍为 `CONSERVED`。

### 2.4 本地历史分析

以下数据来自已存在的本地 rollout 和 Bridge SQLite，仅用于验证 Profiler，不产生新模型调用。

| 范围 | 总 Token | Responses | Cache | Compactions |
| --- | ---: | ---: | ---: | ---: |
| Bridge/MCP 管理任务 | 141,589,709 | 891 | 94.38% | 8 |
| 完整 Goal | 35,698,218 | 204 | 94.62% | 1 |

完整 Goal 的 MCP 轮询为 `9,904,385` Token，占 Master 的 `27.74%`。主要优化证据：

- MCP dispatch/result 与等待/轮询产生显著 Master 开销；
- `zcode_events` 等多轮状态查询存在可归因轮询；
- 大 MCP 返回值和重复工具调用可由 Profiler 统计；
- Failure/Retry 可被独立标记，不被并入正常实现或测试阶段。

这些是本地用量归因，不是新的官方账单结论。

## 3. Web UI 中英文切换

新增共享词典 `tools/cost-lab/web/i18n.mjs`：

- 支持 `en` 与 `zh-CN`；
- 使用 `cost-lab-language` 保存在浏览器本地；
- 首次访问按已保存语言，否则使用浏览器语言，未知语言回退英文；
- 更新 `<html lang>`、页面标题、按钮、表头、帮助文案、空状态和 Toast；
- 日期和整数按当前 locale 格式化。

技术证据状态保持原值，不进行本地化或语义改写：

```text
PASS
FAIL
UNKNOWN
OBSERVED
ATTRIBUTED
ESTIMATED
FRESH
EXPIRED
STALE
```

开始计划比较中的 reason code 只在 UI 层映射为可读文案，技术数据不变。

Session timeline 默认折叠，标题提供可访问的展开/收起按钮；同一报告切换
语言时保留当前展开状态，加载另一份报告时恢复默认折叠。时间线支持导出
脱敏 JSON，包含报告与 Snapshot 标识、Agent 范围、时间线元数据及已知事件
字段，不导出任意正文、提示词、工具结果、推理文本或凭据字段。

浏览器验证覆盖：

- `EN` → `中文` → 页面重载后仍保持中文；
- Dashboard、Environment、Coding Plan、Billing & Usage、Token Profiler、History 六个页面；
- Profiler 实际已存储报告的正常渲染；
- Session timeline 首次加载为折叠状态，展开/收起与 `aria-expanded` 同步；
- 时间线展开时切换语言，文案更新且展开状态保留；
- 时间线 JSON 导出返回 360 个事件，首条事件不含任意 `content` 字段；
- Billing 页面本地 Start Plan 状态渲染，页面加载未调用官方账单 API；
- 390 × 844 移动端布局，语言切换按钮可见、导航可横向滚动；
- 浏览器控制台无 error/warning。

## 4. CI 解耦

新增或调整：

- `.github/workflows/ci.yml`
- `scripts/ci-select-impact.mjs`
- `scripts/test-impact-selector.mjs`
- `scripts/validate-ci-workflow.mjs`
- `test/test-impact-map.json`
- `test/test-impact-selector.test.ts`

CI 现在显式区分：

```yaml
impact:
fast:
cost_lab:
integration:
release:
sqlite-stress:
```

Cost Lab 变更只进入 Cost Lab track，不再无条件触发 Bridge Fast 或 SQLite stress。未知执行路径仍 fail-safe 到完整回归。

## 5. 验证

| 验证 | 结果 |
| --- | --- |
| Cost Lab 专项测试 | `115/115 PASS` |
| TypeScript typecheck | `PASS` |
| Core + Plugin build | `PASS` |
| Test build | `PASS` |
| Impact selector isolated tests | `20/20 PASS` |
| CI workflow validator | `CI_WORKFLOW_VALIDATION_PASS` |
| Affected regression | `TARGETED_TESTS_PASS` |
| Affected regression 明细 | `22 PASS / 0 FAIL / 1 existing SKIP` |
| `git diff --check` | `PASS` |
| Web 零模型 Smoke | `PASS` |
| 浏览器控制台 | `0 error / 0 warning` |

Affected regression 的 skip 是 `test/teardown-retry.test.ts` 中已有的 ENOTEMPTY 注入测试；本轮没有删除测试、增加全局 skip 或降低断言。

压力测试不适用于本轮变更：

```yaml
STRESS_TESTS_NOT_APPLICABLE
```

## 6. 资源与边界

- Cost Lab Smoke 使用 `127.0.0.1:3448`。
- 验证完成后端口 3448 无 listener。
- 本轮模型请求为 0。
- Browser localStorage 仅保存语言偏好，不保存凭据或账单正文。
- 根工作区已有的 `M AGENTS.md` 和 `?? $null` 未修改。
- 功能 Worktree 内由错误 shell 语法生成的本地空 `$null` 文件已删除。
- 功能分支已推送至 `origin/codex/cost-lab-agent-profiler-20261119`。
- 未创建 PR，未 Merge，未发布 Preview。

## 7. 独立审计

独立审计首先返回 `BLOCKED_NOT_READY`。已关闭的问题包括：

- P1：增量采集在单个工具尚未完成时可能丢失跨批次完成事件。Rollout 与
  Bridge SQLite 现在会从最早的未完成 `call_id` / event cursor 重扫，并合并
  已有工具状态。
- P2：`timeline_meta` 仍可能透传非白名单字段。导出已改为显式字段白名单，
  测试注入任意正文并确认不会出现在响应中。
- P2：同一时间戳的 checkpoint 使用字符串顺序，可能造成不稳定排序。现改为
  数值 source ordinal。
- P2：存在未知 Usage 时仍可能显示 `RECONCILED`。现降级为 `PARTIAL`，并避免
  未知响应重复计数。
- P2：未知 Token 或缓存字段可能被显示为零。Phase share、scope totals 和 cache
  聚合在字段不完整时保持 `null` / `UNKNOWN`。
- P3：导出文件名使用未规范化 ID；现仅使用已通过十六进制正则约束的 report ID。
- P3：切换语言可能覆盖临时环境或账单状态文案；现保存翻译 key 与参数并在
  语言切换后重新应用。
- P3：Start Plan 的 loading/captured/error 状态在语言切换与刷新完成后可能被
  旧 freshness 或提前格式化的时间覆盖。现使用独立状态渲染模块，保留原始
  `captured_at` 并在每次语言切换时按当前 locale 格式化，同时增加直接调用
  `refreshStartPlan()` 的应用级状态流转测试。

修复后，`115/115` Cost Lab 测试通过，包含 Rollout 与 Bridge 增量工具完成、
未知 Usage、时间戳稳定排序、导出白名单，以及 Start Plan 的
`LOADING -> FRESH`、中英文切换和本地读取失败状态回归。

最终复核结论：

```yaml
INDEPENDENT_AUDIT: READY_FOR_COMMIT
P0_OPEN:
P1_OPEN:
P2_OPEN:
P3_OPEN:
```

## 8. 剩余工作

- 完整 CI/Release gate 按原 Goal 约束暂时延后；
- Profiler 的分析质量仍受缺失 Usage、无法回看 hidden reasoning 和小时/会话边界的限制；
- Web 双语文案由静态测试覆盖 key 完整性，新增 UI 文案时必须同步更新词典；
- 本轮不进入正式自动提交策略、PR 或 Preview 发布。
