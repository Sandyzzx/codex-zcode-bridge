# Preview.17-C Task Workspace Evidence

> Status: IMPLEMENTED — TARGETED / REAL AUTHORITY + BROWSER, SYNTHETIC WORKER
> Date: 2026-11-25（Asia/Shanghai）
> Baseline: `origin/preview` `6af69b55d7ecb660c2ad2c923888cf7f1e8886c8`
> Implementation snapshot: Preview.17 Task Workspace 第二版（Owner 参考稿收紧）

## 目标与结论

本工作线把 Operations Console 从“内部系统面板”重构为单页 Task Workspace。首屏
先回答三个问题：任务现在处于什么状态、为什么需要处理、下一步可以做什
么。Wake、Cleanup、Release 与完整 Events 降为证据层，不再占据首屏。

实现保持既有 Authority、Executor Control、HTTP 和 SQLite v14 合同不变。没有
新增公共 MCP 工具、第二套状态机、第二份 Task 缓存、Cost Lab 独立页面或
Runtime 主导航。

## 信息架构

| 区域 | 内容 |
|---|---|
| 顶栏 | 原始 Z 图标（直接使用插件 `icon.png` 字节）、Bridge Task Console、低干扰 Experimental 胶囊、弱化 Active、Diagnostics、Language、Theme |
| 首屏 | 左栏 `Tasks` 标题与一句任务说明；右栏 Running / Needs attention / Completed 三个可点击数字卡 |
| 左栏（约 40%） | `Task inbox`：搜索框 + All tasks 筛选 + Attention 优先的 inbox 行，不是宽表格 |
| 右栏（约 60%） | `Task workspace`：Overview → Available actions → Acceptance/Attention → Attempt timeline → Result → Execution usage → Execution facts → Events |
| Diagnostics | 二级 dialog；保留 Runtime 检查与成本证据入口，不占主导航 |

### Task inbox

每行包含 Task 名称、Task ID、状态、Attempt、Model、Plan、Workspace、更新时间、
Usage/Discount 摘要与 Attention 摘要。搜索按名称、Task ID、Workspace 与目标过滤；
三个数字卡与 All tasks 下拉共用同一 bucket 状态。`Needs attention` 行优先排序并
使用轻背景和左侧标记；具体原因直接显示在行内，不藏在最后一列。已完成 Task 显示
Review ready / Awaiting review / Review blocked，区分 Worker 完成与 Master 验收状态。

### Task workspace

1. **Overview**：名称、目标、状态、Attempt、Workspace、执行阶段、创建/更新时间。
2. **Available actions**：只渲染服务端 capability 允许的动作；Continue 与关联
   返工在证据之前出现。
3. **Acceptance and attention**：Result issues 与 Result failed 优先显示，
   并明确二者都不是 Master 验收结论；Completed not accepted、Hold、Pending
   Interaction、未知 Reply Outcome 和阻塞原因按真实 Authority 状态显示。
4. **Attempt timeline**：默认展开，历史 Attempt 只读。
5. **Result**：默认展开。
6. **Execution usage**：默认展开，Plan/Discount/Model/Effort 与
   Worker/Master 分栏。
7. **Execution facts**：Wake/Cleanup/Release，默认折叠。
8. **Events**：默认折叠，按当前 Attempt 完整分页。

## 交互与动作逻辑

- 三个统计卡是真实筛选器；点击后列表只保留对应 bucket，再点一次清除筛选。
- 搜索框按 Task 名称、Task ID、Workspace 与目标实时过滤；All tasks 下拉与统计卡
  双向同步，筛选只改变本地投影，不发起额外 Authority 写操作。
- 选择 Task 更新 `?task_id=`；窄屏选择后自动滚到 Task workspace。
- 选择 Attempt 只切换当前详情和 Usage，不改变 Task 或创建新 Attempt。
- Continue 仅在服务端 `action_capabilities.can_continue=true` 时渲染；表单创建
  下一 Attempt，原 Attempt、Result Digest、Cleanup/Release 与 Wake 历史保留。
- Create related rework 仅在 `can_rework=true` 时渲染；创建继承目标的新 Task，
  原 Task/Attempt 不被覆盖。
- Recover Cleanup 仅在 `can_recover_cleanup=true` 时渲染；界面使用普通用户
  语言，后端仍调用既有 `zcode_cancel` Recovery 状态机，不原地清除 Hold。
- Reply 仅在存在 pending permission request 时渲染；未知 Reply Outcome 只
  显示警告，不自动重发。
- Request cancel 仅在 queued/running 时渲染；取消请求不强制 Release。
- 页面不存在 Accept、Force release、Clear Hold 或任何绕过状态机的按钮。
- Continue/Rework/Cleanup 失败时显示可读原因；无法确认 Worker identity 时
  明确说明“未验证 Cleanup，没有执行 Release”，不把失败伪装为成功。

## 数据绑定与成本口径

- 列表读取 `/api/tasks`，详情读取 `/api/tasks/:id/console`；页面没有静态任务
  假数据，也没有独立的 UI Task 缓存。
- 顶栏品牌图标直接嵌入发布资产 `plugins/codex-zcode-bridge/assets/icon.png` 的
  原始 PNG 字节；单元测试校验解码后的 SHA-256 为
  `4C657714FE423243DA63191AE949FBF2DADC37FC8F994A6432FC1F92E2C4D1CC`，浏览器
  测试校验图片实际解码成功，不再使用 `B/` 文字占位。
- 状态、Attempt、Result、Attention、Wake、Cleanup、Release 与 Usage 全部来自
  同一 SQLite Authority 的 Console projection。
- 真实零 Token 保持 `0`；整套 Usage 缺失显示 `Not observed`，不显示 `0`。
- Plan 只按 provider kind 投影，不按模型名猜套餐。
- Discount 只使用 Applied / Not applied / Not observed / N/A，不使用固定
  `0.67` 倍率。
- Worker Usage 与 Master Usage 分栏；Master 未记录时明确未观测。
- Provider 实际成本没有逐 Attempt settlement 时显示 `Not observed`，不把预计
  成本冒充实际成本。
- Effort 来自 Result 的 effective/requested reasoning level 或 Task 请求，不从
  模型名推导。

## Evidence Boundary

浏览器 E2E 使用真实 `IsolatedAdmissionStore`、真实 SQLite Authority、真实
Executor Control Server/IPC、真实 loopback HTTP 和真实 Chromium。测试中的
Worker、Result、Wake 与 Usage 是 **SYNTHETIC WORKER / NOT REAL MODEL**；不能
作为真实模型、真实 Desktop、真实 Queue Wake 或真实 Provider/Billing 证据。

## Result Matrix

| 检查 | 状态 | 证据 |
|---|---|---|
| Task inbox、非表格结构、Attention 优先排序 | `PASS — TARGETED` | Chromium E2E 列表断言、筛选 3/5 行、Attention 行 |
| 搜索与 All tasks 筛选 | `PASS — TARGETED` | 搜索 `wake` 只剩 1 行；清空恢复 5 行；下拉 attention 3 行 |
| 原始图标字节绑定 | `PASS — TARGETED` | base64 解码 SHA-256 等于 `4C657714…`；Chromium `naturalWidth >= 32` |
| Completed-not-accepted 区分 | `PASS — TARGETED` | Review ready / Review blocked 行标签 |
| 详情八段顺序与折叠证据层 | `PASS — TARGETED` | `data-section` 顺序断言；Execution facts/Events 默认关闭 |
| Available actions 仅按 capability 渲染 | `PASS — TARGETED` | done、cleanup、attention、queued、wake-unknown 五类页面 |
| Continue 创建下一 Attempt | `PASS — SYNTHETIC WORKER` | 真实 SQLite/IPC/HTTP/Chromium，Attempt 3 出现 |
| Related rework 新建 Task | `PASS — TARGETED` | POST 回执 `context_only`，原 Task/Attempt 保留 |
| Cleanup 未验证时失败关闭 | `PASS — TARGETED` | Continue/Rework 不存在，只剩 Recover Cleanup；identity 不可验证时不 Release |
| 危险动作不存在 | `PASS — TARGETED` | 无 Accept / Force release / Clear Hold 按钮 |
| 真实零 Token 与未观测区分 | `PASS — TARGETED` | Attempt 1 Input=0；无 Usage 显示 Not observed |
| Plan/Discount/Effort/Worker/Master 分栏 | `PASS — TARGETED` | Start Plan、N/A、low、两列 usage、Provider cost 未观测 |
| 真实 SQLite Authority + IPC + HTTP + Chromium | `PASS — TARGETED` | `test/web-console-browser.test.ts` |
| 历史 Attempt 切换、Result、Events >=245 | `PASS — TARGETED` | Attempt 1/2/3、Result 切换、完整分页到 All Events loaded |
| 双语、明暗主题、窄屏无横向溢出 | `PASS — HEADLESS CHROMIUM` | localStorage、390px viewport、截图与 scrollWidth 断言 |
| Diagnostics 无自动 Runtime/Billing 请求 | `PASS — TARGETED` | 请求记录无 `/api/runtime`、`/api/cost-lab` |
| 真实模型 / 真实 ZCode/Codex Desktop | `NOT_RUN` | 本轮没有真实模型或 Desktop |
| 真实 Queue Wake / Desktop fully exited / notLoaded | `NOT_RUN` | synthetic fixture 不提升为 Host 生命周期证据 |
| Master Usage / 真实逐 Attempt settlement | `NOT_OBSERVED` | Authority 没有记录；界面明确未观测 |
| 完整 Windows/Ubuntu CI 与 Release Gate | `PENDING` | 在 Preview.17 集成阶段执行并单独记录 |

## Screenshots

以下截图由真实 Authority + IPC + HTTP + headless Chromium E2E 生成：

- [Task workspace, desktop light](screenshots/tasks-desktop-light.png)
- [Task workspace, desktop dark](screenshots/tasks-desktop-dark.png)
- [Task workspace, Chinese](screenshots/task-detail-attempts.png)
- [Cleanup blocked and safe action](screenshots/cleanup-blocked.png)
- [Diagnostics](screenshots/diagnostics.png)
- [Narrow layout](screenshots/tasks-narrow.png)

## 与旧候选相比的改进

- 删除宽表格列压缩，改为可扫描的 inbox 行；Attention 与验收状态前置。
- 详情从“证据优先”改为“结论/动作/证据/事件”四层。
- Cleanup recovery 从 Cleanup 证据区移到 Available actions，且只显示安全入口。
- 新增 Effort 投影，Usage 明确 Plan/Discount/Model/Effort 与 Master/Worker 分栏。
- 删除顶部内部机制文案、网格背景、重阴影和多页面导航。
- 顶部改为真实 Z 图标 + 低干扰 Experimental 胶囊；删除 `B/` 文字占位。
- 首屏按参考稿把概况卡放到详情列上方，左栏增加搜索与 bucket 下拉。
- 增加 390px 窄屏 Attempt 自动换行与选择后滚到详情。
- 失败原因改为普通用户语言，同时保留真实阻塞原因与未观测状态。

## Commands and Results

最终 WebUI 定向验证：

```text
npm run typecheck
npm run build
npm run build:test
node --test dist-test/test/web-console.test.js dist-test/test/web-console-browser.test.js
```

结果：

```text
tests 13
pass 13
fail 0
skipped 0
```

真实 Authority + IPC + HTTP + Chromium E2E 用时约 14 秒并通过。完整
`npm run test:affected -- --development`、完整 `npm test`、Windows/Ubuntu CI
在 Preview.17 集成门禁中继续执行；本报告不把定向 E2E 写成完整发布门禁。

## Modified Areas

- `src/web/console-ui.ts`：信息架构、inbox 列表、详情顺序、动作区、Usage 面板、
  双语文案、响应式与视觉层级。
- `src/task-list.ts`：`ConsoleTaskModelProjection.effort` 加性字段。
- `src/manager/sqlite-lifecycle-mcp-authority.ts`：从 Result/Task 请求读取
  Effort，不从模型名推导。
- `test/web-console.test.ts`、`test/web-console-browser.test.ts`：结构、顺序、
  filters、capability、Usage 与安全动作断言。
- `docs/WEB_CONSOLE.md`、ADR-062、PROJECT_STATE、docs index 与本报告。

## NOT_RUN / Remaining Risk

- 没有真实 ZCode/Codex 模型调用、真实 Desktop UI、真实 Queue Wake 或真实
  Desktop 可见性证据。
- 没有真实 Master Usage、逐 Attempt Coding Plan settlement 或 discount 金额。
- 没有完整 Windows/Ubuntu CI、压力矩阵或 Release Gate；在集成阶段完成。
- 截图是 headless Chromium 的视觉证据，不替代人工 UI/UX 或 DPI 验收。
- 真实模型 Skill 遵循率与 Token Cache 效率不在本工作线验证范围。
