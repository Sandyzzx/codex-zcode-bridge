# Preview.17-C Task Console Evidence

> Status: IMPLEMENTED — TARGETED / REAL AUTHORITY + BROWSER, SYNTHETIC WORKER
> Date: 2026-11-25（Asia/Shanghai）
> Baseline: `origin/preview` `6af69b55d7ecb660c2ad2c923888cf7f1e8886c8`
> Integration snapshot: Preview.17 second-round Task Workspace simplification

## 目标与结论

本工作线把 Operations Console 从“内部系统面板”收敛为单页 Task Workspace。
首屏只回答任务现在是什么状态、为什么需要处理、下一步可以安全做什么。
Wake、Cleanup、Release 和完整 Events 保留为默认折叠的技术证据，不再先于
失败原因和恢复动作出现。

本轮是减法整改：没有新增主导航、标签页、公共 MCP 工具、第二套状态机、
第二份 Task 缓存或独立成本页面。所有任务事实继续来自既有 SQLite v14
Authority 的 Console projection。

## 新的信息架构

| 区域 | 最终内容 |
|---|---|
| 顶栏 | 原始 Z 图标、`Bridge Task Console`、低干扰 Experimental、Diagnostics、Language、Theme |
| 页面首屏 | `Tasks`、一句 `Review task status, results, and recovery actions.`、Running / Needs attention / Completed 单行计数 |
| 主区域 | 桌面约 40% 任务列表 / 60% 任务详情；窄屏上下排列 |
| 任务列表 | 无 `Task inbox` 重复标题，无传统宽表头；每项最多三行 |
| 任务详情 | Task header → Problem and actions → Work history → Execution → 折叠 Technical details |
| Diagnostics | 次级 dialog；Runtime、成本证据和 Auto Wake 设置保留，不占主导航 |

### 任务列表

每项任务固定为最多三行：

1. Task 名称和一个主要状态标签。
2. Workspace 简称、Model、Plan、Attempt、更新时间。
3. 仅需要处理时显示失败原因或 Attention 摘要。

列表不显示完整 Workspace 路径、独立 Usage 行、重复更新时间或重复状态。
Model 与 Plan 同时未观测时合并为一个 `Model and plan not observed`，避免
在主视图中连续重复 `Not observed`。完整路径只出现在任务详情。

需要处理的行优先排序，并用轻微背景和左侧标记强调。已完成 Task 使用
`Completed · Awaiting review` 或 `Completed · Review blocked`，不把 Worker
完成显示成 Master 已验收。

### 任务详情

详情从八个区块压缩为四段，另有一个不作为独立卡片的 Task header：

1. **Task header**：名称、Task ID、Attempt、Model / Plan、更新时间与完整
   Workspace。不再创建独立 Overview 卡片。
2. **Problem and actions**：合并 Acceptance、Attention 与 Available
   actions。先显示普通用户可理解的阻塞原因，再紧接合法动作；不渲染无效
   按钮，不提供强制释放或清除 Hold。
3. **Work history**：合并 Attempt timeline 与 Result。显示历史/当前
   Attempt、Result 摘要、变更文件数和测试摘要；详细 Result 与文件列表按需
   展开。Worker Completed、Master Review Pending 和 Master Accepted 保持
   语义区分；Bridge 没有记录 Master 验收时明确显示未记录。
4. **Execution**：默认一行
   `Model · Plan · Discount · Total tokens`；展开后显示 Input / Output、
   Cache read / write、Reasoning、Effort、Provider 实际成本、Worker Usage
   与 Master Usage。
5. **Technical details**：Wake、Cleanup、Release 与 Events 合并为一个默认
   折叠区。展开 Events 时才按当前 Attempt 分页读取完整历史。

## 交互与动作逻辑

- Running / Needs attention / Completed 是同一 bucket 状态的可点击筛选；
  再点当前项可清除筛选。
- 搜索按 Task 名称、Task ID、Workspace 与目标过滤；搜索、下拉筛选和计数
  筛选只改变本地投影，不写入 Authority。
- 选择 Task 更新 `?task_id=`；刷新后保留 Deep Link。窄屏选择后自动滚到
  详情。选择历史 Attempt 只切换只读详情，不改变 Task 或创建 Attempt。
- Continue 仅在服务端 `action_capabilities.can_continue=true` 时显示；
  真实后端创建下一 Attempt，原 Attempt、Result Digest、Cleanup/Release 和
  Wake 历史全部保留。
- Create related rework 仅在 `can_rework=true` 时显示；真实后端创建继承
  原目标与验收边界的新 Task，原 Task/Attempt 不被覆盖。
- Recover Cleanup 仅在 `can_recover_cleanup=true` 时显示；后端仍进入既有
  `zcode_cancel` Recovery 状态机。Worker 身份无法确认时 fail closed，不
  执行 Release。
- Reply 仅在存在 pending permission request 时显示；未知 Reply Outcome
  只显示对账警告，不自动重发。
- Request cancel 仅在 queued/running 时显示；取消请求不原地清除 Hold。
- 页面不存在 Accept、Force release、Clear Hold 或任何绕过状态机的操作。
- Executor 不可用时显示低干扰恢复提示；不会启动第二个 Worker，也不会
  自动重提交未知 Queue。

## 数据绑定与执行消耗

- 列表读取 `/api/tasks`，详情读取 `/api/tasks/:id/console`，Events 读取
  `/api/tasks/:id/events`；页面没有静态任务假数据，也没有独立 UI Task
  缓存。
- 顶栏品牌图标直接嵌入发布资产
  `plugins/codex-zcode-bridge/assets/icon.png` 的原始 PNG 字节；解码后
  SHA-256 为
  `4C657714FE423243DA63191AE949FBF2DADC37FC8F994A6432FC1F92E2C4D1CC`。
- 状态、Attempt、Result、Attention、Wake、Cleanup、Release 与 Usage 全部
  来自同一 SQLite Authority 的 Console projection。
- 真实零 Token 保持 `0`；整套 Usage 缺失显示 `Not observed`，不显示 `0`。
- Plan 只按 provider kind 投影，不根据模型名推断套餐。
- Discount 只使用 Applied / Not applied / Not observed / N/A，不使用固定
  `0.67` 倍率。
- 执行消耗按选中的 Attempt 读取，页面不把多个 Attempt 再做可能重复计数的
  Task 汇总。
- Worker Usage 与 Master Usage 分开；Bridge 未记录 Master Usage 时明确
  未观测。
- Provider 实际成本没有逐 Attempt settlement 时显示 `Not observed`，
  不把预计成本冒充实际成本。
- Effort 来自 Result 的 effective/requested reasoning level 或 Task
  请求，不从模型名推导。

## 截图

以下截图由真实 SQLite Authority、真实 Executor Control IPC、真实 loopback
HTTP 和 headless Chromium 生成。任务、Worker、Result、Wake 与 Usage 是
测试夹具，截图和数据均在报告中标记为 synthetic：

- [桌面 Light](screenshots/tasks-desktop-light.png)
- [桌面 Dark](screenshots/tasks-desktop-dark.png)
- [中文界面](screenshots/tasks-zh.png)
- [390 px 窄屏](screenshots/tasks-narrow.png)
- [Running + Pending interaction](screenshots/task-running.png)
- [Queued + Request cancel](screenshots/task-queued.png)
- [历史 Attempt：Review failed / Worker failed](screenshots/task-review-failed.png)
- [Completed · Review blocked / Queue 未知](screenshots/task-review-blocked.png)
- [Cleanup 未验证与安全恢复入口](screenshots/cleanup-blocked.png)
- [Executor unavailable 恢复提示（合成状态覆盖）](screenshots/executor-unavailable.png)
- [Execution 展开](screenshots/execution-expanded.png)
- [Technical details / 完整 Events](screenshots/technical-details.png)
- [Diagnostics](screenshots/diagnostics.png)

`task-review-failed.png` 展示的是失败的第一 Attempt，不是虚构的 Task 级
Master 验收结论。`executor-unavailable.png` 使用显式 synthetic Executor
status override；页面数据 API 仍是真实 Authority projection。所有测试 Worker
均为 `SYNTHETIC WORKER / NOT REAL MODEL`。

## 验收结果

| 检查 | 状态 | 证据 |
|---|---|---|
| 单页、无多页导航、无 Cost Lab / Runtime 主导航 | `PASS — TARGETED` | 页面结构与 HTTP 断言 |
| 单行概况计数可作为筛选 | `PASS — TARGETED` | Chromium 点击 3/5 行与清除筛选 |
| 任务列表最多三行、Attention 前置 | `PASS — TARGETED` | 行结构、无表头、无完整路径、无 Usage 行 |
| 未观测 Model/Plan 不重复显示 | `PASS — TARGETED` | 合并标签与 Chromium 精确断言 |
| 四段详情顺序与默认折叠证据 | `PASS — TARGETED` | `data-section` 顺序、Execution 与 Technical details 初始关闭 |
| Completed-not-accepted 区分 | `PASS — TARGETED` | Awaiting review / Review blocked 标签与未记录文案 |
| Continue / related rework 仅按 capability 显示 | `PASS — TARGETED` | done、cleanup、attention、queued、wake-unknown 五类状态 |
| Continue 创建下一 Attempt | `PASS — SYNTHETIC WORKER` | 真实 SQLite/IPC/HTTP/Chromium；Attempt 3 出现 |
| Related rework 新建 Task | `PASS — TARGETED` | 真实 POST，回执 `context_only`，原 Task 保留 |
| Cleanup 未验证时 fail closed | `PASS — TARGETED` | 无 Continue/Rework；identity 不可验证时不 Release |
| 危险动作不存在 | `PASS — TARGETED` | 无 Accept / Force release / Clear Hold |
| 真实零 Token 与未观测区分 | `PASS — TARGETED` | Attempt 1 Input=0；无 Usage 显示 Not observed |
| Plan / Discount / Effort / Worker / Master 分栏 | `PASS — TARGETED` | 展开 Execution 与 Provider 成本未观测文案 |
| 真实 Authority + IPC + HTTP + Chromium | `PASS — TARGETED` | `test/web-console-browser.test.ts` |
| 双语、明暗主题、窄屏无横向溢出 | `PASS — HEADLESS CHROMIUM` | localStorage、390 px viewport、截图与 scrollWidth 断言 |
| Diagnostics 不自动请求 Runtime/Billing | `PASS — TARGETED` | 请求记录无自动 `/api/runtime` 或 `/api/cost-lab` |
| 真实模型 / 真实 Desktop / 真实 Queue Wake | `NOT_RUN` | 本轮夹具不等于真实 Host 证据 |
| 真实 Master Usage / 逐 Attempt settlement | `NOT_OBSERVED` | Authority 没有记录，界面明确未观测 |
| 完整 `npm test` / Windows / Ubuntu CI | `PENDING` | 在 Preview.17 集成门禁中执行并记录 |

## 与上一版候选相比的改进

- 删除 `Task inbox` / `Task workspace` 重复栏目标题、独立 Overview 卡片、
  独立 Available actions 和 Acceptance 卡片。
- 三张大型统计卡压缩为一行可点击计数。
- 任务列表从多列宽表改为最多三行的 inbox 行；删除完整路径和独立 Usage 行。
- 详情从八段压缩为四段，技术证据默认折叠。
- Execution 默认只显示一行，展开后才显示逐项 Token、Effort、Provider 成本
  与 Worker/Master 分栏。
- 型号与套餐同时未观测时合并展示，避免主视图重复 `Not observed`。
- 失败原因、接受语义和合法动作前置；按钮只来自服务端 capability。
- 顶栏换成发布 `icon.png` 原始字节；Light / Dark 均降低网格、边框和装饰噪声。

## 命令与证据边界

已执行的定向入口：

```text
npm run typecheck
npm run build:test
node --test dist-test/test/web-console.test.js dist-test/test/web-console-browser.test.js
```

最终结果在提交前以工作树日志为准。完整 `npm test`、完整 Build、Plugin
Validation、Generated Freshness、Windows/Ubuntu CI 和真实 Host E2E 必须在
Preview.17 集成阶段继续执行；本报告不把定向 Chromium 结果写成完整发布门禁。

## 修改范围

- `src/web/task-console-ui.ts`：最终单页布局、CSS、双语、详情四段、动作与
  技术证据折叠。
- `src/web/console-ui.ts`：嵌入真实插件图标并组合单页页面。
- `test/web-console-browser.test.ts`、`test/web-console.test.ts`：结构、动作、
  数据绑定、主题、语言、窄屏与技术证据断言。
- `docs/WEB_CONSOLE.md`、ADR-062、PROJECT_STATE、README 中英文与本报告。

## 未运行与剩余风险

- 没有真实 ZCode 模型调用、真实 Desktop UI、真实 Queue Wake 或真实
  Desktop 可见性证据。
- 没有真实 Master Usage、逐 Attempt Coding Plan settlement 或 discount
  金额。
- 截图是 headless Chromium 视觉证据，不替代人工 UI/UX 或 Windows DPI 验收。
- 真实模型 Skill 遵循率与 Token Cache 效率不在本工作线验证范围。
