# Preview.17-C Task Workspace Evidence

> Status: IMPLEMENTED — TARGETED / REAL AUTHORITY + BROWSER, SYNTHETIC WORKER
> Date: 2026-11-25（Asia/Shanghai）
> Baseline: `origin/preview` `6af69b55d7ecb660c2ad2c923888cf7f1e8886c8`
> Integration snapshot: Preview.17 final Task Workspace UI freeze

## 目标与结论

本工作线把 Operations Console 从“内部系统面板”收敛为单页 Task Workspace。
用户首先看到任务、问题和下一步安全动作，而不是 Authority、Executor、Wake、
Cleanup 或 SQLite 读取路径。最终冻结版本只保留一个 Tasks 页面，不新增导航、
功能页、第二套 Task 缓存或成本页面。

本轮完成第二轮减法与最终微调：隐藏内部标识和缺失字段；把 Result 合并回
Attempt 历史；明确 Execution completed 不是 Master Accepted；Workflow 原语
与完整证据继续位于默认折叠的 Technical details。

## 信息架构

| 区域 | 最终内容 |
|---|---|
| 顶栏 | 原始 Z 图标、`Bridge Task Console`、低干扰 Experimental、Diagnostics、Language、Theme |
| 页面首屏 | `Tasks`、一句任务说明、Running / Needs attention / Execution completed 单行计数 |
| 主区域 | 桌面约 40% 任务列表 / 60% 任务详情；窄屏上下排列 |
| 任务列表 | 无表头与重复栏目标题；每项最多三行 |
| 任务详情 | Task header → Problem and actions → Work history → Execution → 折叠 Technical details |
| Diagnostics | 次级 dialog；Runtime、成本证据和 Auto Wake 设置保留，不占主导航 |

### 任务列表

每项最多三行：

1. Task 名称和一个主要状态标签。
2. 实际观测到的 Workspace 简称、Model、Plan、Attempt 与更新时间。
3. 仅需要处理时显示失败原因或 Attention 摘要。

列表不显示内部 Task ID、`wake-unknown`、`attention`、`cleanup`、`done`、
`queued` 等工作流类型标识、完整 Workspace 路径、独立 Usage 行或重复状态。
缺失的 Workspace、Model、Plan 与时间字段直接隐藏，不渲染连续
`Not observed`。完整路径只在任务详情中按需展开。

Attention 行优先排序，并使用轻微背景和左侧标记。执行完成 Task 使用
`Execution completed · Awaiting review` 或
`Execution completed · Review blocked`，不把 Worker 完成显示成 Master
已验收。

### 任务详情

详情固定为 Task header 与四个区域：

1. **Task header**：Task 名称、Attempt、Workspace 简称与 Updated。完整
   Workspace 路径默认折叠；普通视图不显示内部 Task ID。
2. **Problem and actions**：合并问题、Attention 与合法的下一步动作。当前
   Attempt 的 Result failed / Result issues、Pending Interaction、Hold、
   Cleanup 或 Queue 风险先于技术证据出现。Continue、Create related rework、
   Recover Cleanup、Reply 与 Request cancel 只在服务端 capability 允许时
   渲染。
3. **Work history**：保留 Attempt timeline，并在其下直接显示所选 Attempt
   的 Result summary、变更文件数和测试摘要。删除重复的 Result 标题、
   Attempt 编号与 Result 状态标签；完整 Result 和文件列表按需展开。历史失败
   Attempt 不继承当前 Task 的验收说明。
4. **Execution**：默认只显示
   `Model · Plan · Discount · Total tokens`。展开后显示观测到的
   Input / Output、Cache read / write、Reasoning、Effort、Provider 实际
   成本、Worker Usage 与 Master Usage。缺失字段隐藏，并只生成一条
   `Not observed: …` 汇总。
5. **Technical details**：Wake、Cleanup、Release 与 Events 默认折叠；展开
   Events 时才读取当前 Attempt 的完整分页历史。

当前 SQLite Authority 不提供 Master acceptance 字段。页面显示
“Worker execution completed. Master acceptance is not recorded.”，不会从
Task status、Result、Wake 或 UI 自行推断 Accepted；未来若权威 projection
提供显式 `master_accepted`，界面只消费该事实。

## 动作与安全边界

- Running / Needs attention / Execution completed 是同一 bucket 状态的可点击
  筛选；再点当前项可清除筛选。搜索按 Task 名称、Task ID、Workspace 与目标
  过滤，只改变本地 projection。
- 选择 Task 更新 `?task_id=`；刷新后保留 Deep Link。选择历史 Attempt 只切换
  只读详情，不改变 Task、Attempt、Workspace 或 Result。
- Continue 仅在服务端 `action_capabilities.can_continue=true` 时显示；真实
  POST 创建下一 Attempt，原 Attempt、Result Digest、Cleanup/Release 与全部
  Wake Event 保留。
- Create related rework 仅在 `can_rework=true` 时显示；真实 POST 创建继承
  原目标与验收边界的新 Task，回执关系为 `context_only`，原 Task/Attempt
  不被覆盖。
- Recover Cleanup 仅在 `can_recover_cleanup=true` 时显示；后端仍进入既有
  `zcode_cancel` Recovery 状态机。Worker identity 无法确认时 fail closed，
  不执行 Release，也不原地清除 Hold。
- Reply 只对 pending interaction 显示；未知 Reply Outcome 只显示对账警告，
  不自动重发。Request cancel 只对 queued/running Attempt 显示，不直接写
  Release。
- 页面不存在 Accept、Force release、Clear Hold 或其他绕过状态机的操作。
- Executor 不可用时显示低干扰诊断；不启动第二个 Worker，也不自动重提交
  未知 Queue。

## 数据绑定与执行消耗

- 列表读取 `/api/tasks`，详情读取 `/api/tasks/:id/console`，Events 读取
  `/api/tasks/:id/events`。页面没有静态任务假数据或独立 UI Task 缓存。
- 顶栏品牌图标直接嵌入 `plugins/codex-zcode-bridge/assets/icon.png` 的原始
  PNG 字节；解码后 SHA-256 为
  `4C657714FE423243DA63191AE949FBF2DADC37FC8F994A6432FC1F92E2C4D1CC`。
- 状态、Attempt、Result、Attention、Wake、Cleanup、Release 与 Usage 全部
  来自同一 SQLite Authority 的 Console projection。
- 真实零 Token 保持 `0`。缺失字段不渲染为 `0`；整套缺失在展开 Execution
  时合并为一条未观测说明。
- Plan 只按 provider kind 投影，不根据模型名推断套餐。
- Discount 只使用 Applied / Not applied / Not observed / N/A，不使用固定
  `0.67` 倍率。
- 执行消耗按所选 Attempt 读取，页面不把多个 Attempt 做可能重复计数的 Task
  汇总。Worker Usage 与 Master Usage 只在已观测时分栏。
- 没有可靠 Provider settlement 时不创建金额字段，只在未观测汇总中列出一次；
  不把预计成本冒充实际成本。
- Effort 来自 Result 的 effective/requested reasoning level 或 Task 请求，
  不从模型名推导。

## 截图

截图由真实 SQLite Authority、真实 Executor Control IPC、真实 loopback HTTP
和 headless Chromium 生成。任务、Worker、Result、Wake 与 Usage 是测试夹具，
明确标记为 `SYNTHETIC WORKER / NOT REAL MODEL`：

- [桌面 Light](screenshots/tasks-desktop-light.png)
- [桌面 Dark](screenshots/tasks-desktop-dark.png)
- [中文界面](screenshots/tasks-zh.png)
- [390 px 窄屏](screenshots/tasks-narrow.png)
- [Running + Pending interaction](screenshots/task-running.png)
- [Queued + Request cancel](screenshots/task-queued.png)
- [历史 Attempt：Result failed](screenshots/task-review-failed.png)
- [Execution completed · Review blocked / Queue 未知](screenshots/task-review-blocked.png)
- [Cleanup 未验证与安全恢复入口](screenshots/cleanup-blocked.png)
- [Executor unavailable 恢复提示（合成状态覆盖）](screenshots/executor-unavailable.png)
- [Execution 展开](screenshots/execution-expanded.png)
- [Technical details / 完整 Events](screenshots/technical-details.png)
- [Diagnostics](screenshots/diagnostics.png)

`executor-unavailable.png` 使用显式 synthetic Executor status override；页面
数据 API 仍是真实 Authority projection。截图不替代真实模型、真实 Desktop、
真实 Queue Wake、Windows DPI 或人工 UI/UX 验收。

## 验收结果

| 检查 | 状态 | 证据 |
|---|---|---|
| 单页、无多页导航、无 Cost Lab / Runtime 主导航 | `PASS — TARGETED` | 页面结构与 HTTP 断言 |
| 内部 Task/工作流标识不出现在普通视图 | `PASS — TARGETED` | 可见文本与 Task/Attempt 详情断言 |
| 缺失字段隐藏且未观测只汇总一次 | `PASS — TARGETED` | Workspace/Model/Plan/Usage/Provider 断言 |
| 单行概况计数可作为筛选 | `PASS — TARGETED` | Chromium 点击 3/5 行与清除筛选 |
| 任务列表最多三行、Attention 前置 | `PASS — TARGETED` | 行结构、无表头、无完整路径、无 Usage 行 |
| Attempt timeline 与 Result 合并且无重复标题/编号/状态 | `PASS — TARGETED` | Work history DOM 与截图 |
| Execution completed 与 Master Accepted 分离 | `PASS — TARGETED` | 当前 Task 只显示一次未记录说明；历史失败 Attempt 不继承 |
| Workspace 默认简称、完整路径按需展开 | `PASS — TARGETED` | Task header `<details>` 与可见文本 |
| Continue / related rework 仅按 capability 显示 | `PASS — TARGETED` | done、cleanup、attention、queued、wake-unknown 五类状态 |
| Continue 创建下一 Attempt | `PASS — SYNTHETIC WORKER` | 真实 SQLite/IPC/HTTP/Chromium；Attempt 3 出现 |
| Related rework 新建 Task | `PASS — TARGETED` | 真实 POST，回执 `context_only`，原 Task 保留 |
| Cleanup 未验证时 fail closed | `PASS — TARGETED` | 无 Continue/Rework；identity 不可验证时不 Release |
| 危险动作不存在 | `PASS — TARGETED` | 无 Accept / Force release / Clear Hold |
| 真实零 Token 与缺失区分 | `PASS — TARGETED` | Attempt 1 Input=0；缺失字段不显示为 0 |
| Plan / Discount / Effort / Worker / Master 分栏 | `PASS — TARGETED` | Execution 展开与单次未观测汇总 |
| 真实 Authority + IPC + HTTP + Chromium | `PASS — TARGETED` | `test/web-console-browser.test.js` |
| 双语、明暗主题、窄屏无横向溢出 | `PASS — HEADLESS CHROMIUM` | localStorage、390 px viewport、截图与 scrollWidth 断言 |
| Diagnostics 不自动请求 Runtime/Billing | `PASS — TARGETED` | 请求记录无自动 `/api/runtime` 或 `/api/cost-lab` |
| 真实模型 / 真实 Desktop / 真实 Queue Wake | `NOT_RUN` | 本轮夹具不等于真实 Host 证据 |
| 真实 Master Usage / 逐 Attempt settlement | `NOT_OBSERVED` | Authority 没有记录，界面不伪造 |
| 完整 `npm test` / Windows / Ubuntu CI | `PENDING` | 必须在 Preview.17 最终集成门禁执行 |

## 与上一版候选相比的改进

- 删除 `Task inbox` / `Task workspace` 重复栏目标题、独立 Overview 卡片、
  独立 Available actions 和 Acceptance 卡片。
- 三张大型统计卡压缩为一行可点击计数；`Completed` 改为
  `Execution completed`。
- 任务列表从多列宽表改为最多三行的 inbox 行；删除内部 ID、完整路径、
  独立 Usage 行和缺失字段占位。
- 详情从八段压缩为四段，技术证据默认折叠。
- Task header 只保留 Attempt、Workspace 与 Updated；完整路径可展开。
- Work history 删除 Result 重复标题、Attempt 编号与状态标签。
- Execution 删除逐字段 `Not observed`，改为单条未观测汇总。
- 当前 Task 的验收说明只显示一次；历史失败 Attempt 不再继承。
- 型号与套餐缺失时隐藏，不重复 `Not observed`。
- 失败原因、接受语义和合法动作前置；按钮只来自服务端 capability。
- 顶栏换成发布 `icon.png` 原始字节；Light / Dark 均降低网格、边框和装饰噪声。

## 定向验证

最终冻结 UI 的定向入口：

```text
npm run typecheck
npm run build:test
node --test dist-test/test/web-console.test.js dist-test/test/web-console-browser.test.js
```

结果为 `13/13 PASS`，其中包含真实 SQLite Authority、IPC、HTTP 与
headless Chromium 的完整页面交互。完整 `npm test`、完整 Build、Plugin
Validation、Generated Freshness、Windows/Ubuntu CI、安装后 UI 与真实 Host
E2E 在 Preview.17 最终集成报告中继续执行；本报告不把定向结果写成完整发布
门禁或真实模型证据。

## 修改范围

- `src/web/task-console-ui.ts`：单页布局、CSS、双语、Workspace 展开、详情
  四段、隐藏字段、单次未观测汇总、动作与技术证据折叠。
- `src/web/console-ui.ts`：嵌入真实插件图标并组合单页页面。
- `test/web-console-browser.test.ts`、`test/web-console.test.ts`：结构、动作、
  数据绑定、主题、语言、窄屏、技术证据与内部标识断言。
- `docs/WEB_CONSOLE.md`、ADR-062、PROJECT_STATE、README 中英文与本报告。

## 未运行与剩余风险

- 没有真实 ZCode 模型调用、真实 Desktop UI、真实 Queue Wake 或真实
  Desktop 可见性证据。
- 当前 Authority 没有 Master acceptance、真实 Master Usage 或逐 Attempt
  Provider settlement；界面明确未记录，不做推断。
- 截图是 headless Chromium 视觉证据，不替代人工 UI/UX、Windows DPI 或
  Marketplace/Codex 安装后的品牌刷新验收。
- 真实模型 Skill 遵循率、Token Cache 效率与真实 Host 自动返工闭环不在本
  工作线验证范围。
