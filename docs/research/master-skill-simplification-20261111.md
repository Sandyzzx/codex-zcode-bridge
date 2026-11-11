# Master Skill Accuracy Audit & Simplification — 2026-11-11

> Status: RESEARCH
> Last updated: 2026-11-11
> Base: `372e90622772b070357a278f1da3dea58fa42dee` (`origin/preview`)
> Scope: Skill 文本、离线评估与直接测试；不改变 Runtime、Schema、TaskPackage 或 Prompt Builder。

## 1. 准确性审计

依据为 Base 上的 `docs/PROJECT_STATE.md`、`docs/ARCHITECTURE.md`、`docs/INTERFACES.md`、ADR-010/015/016/024/025/026/027/028/029/031、`src/mcp/schemas.ts`、`src/mcp/server.ts`、`src/interfaces.ts`、`src/prompts/task-prompt.ts`、`src/runtime/model-routing.ts` 与 `src/runtime/trusted-local-profile.ts`。未把旧 Skill 文本当作事实来源。

| 审计项 | Base 结论 | 证据与处理 |
|---|---|---|
| Master/Worker 职责 | **ACCURATE / DUPLICATED** | ADR-010 与 Prompt Builder 均支持完整交付和 Worker 自主性；Base 在 root、delegation、monitoring、review 多处重复。新版 root 保留 P0，操作细节归 reference。 |
| 显式授权与持续 Goal | **ACCURATE / DUPLICATED** | ADR-015 支持“当前目标/会话/持续目标授权，Goal 本身不授权”。Base 在 root、delegation、dispatch、goal 四处重复。新版 root 唯一定义授权，goal 只管生命周期。 |
| `auto` / `whole_task` / `staged` | **ACCURATE / DUPLICATED** | `auto` 不是 schema 字段；`zcodeTaskInputSchema` 无该字段。Base 在 root、delegation、workflow、template 重复。新版 root 定义语义，task-dispatch 校验字段。 |
| TaskPackage 字段 | **STALE** | 五数组必填可空、`context`/`worktree_path`/`model`/`timeout_ms` 可选均正确；但 Base 模板要求用户指定模型时传 `provider_id`，未反映 ADR-031 后公开 `model.provider_id` 可选。新版 task-dispatch 更正。 |
| Provider/Model/Reasoning | **STALE / INCORRECT** | Base 有 Start Plan 别名规则，但缺少省略 provider 的普通模型一次性路由；monitoring 建议 `ZCODE_BRIDGE_MODE=build`，而当前生产 `local-build-v1` profile 固定映射 `yolo`。新版按 schema/ADR-031/profile 更正，并保留 runtime 事件为实际模型事实。 |
| SQLite Hold 与 `zcode_cancel` | **ACCURATE / DUPLICATED** | 当前接口确认 cancel 仅 `{ task_id }`、可能原身份终止、unknown fail-closed。Base root/review 重复长流程。新版 root 留 P0，review 留操作细节。 |
| `zcode_events(wait_for="attention")` | **ACCURATE** | Schema 只允许 literal `"attention"`；等待 Pending、终态或 Attempt 变化，普通事件不唤醒。新版 monitoring 保留。 |
| 独立验收与 `zcode_continue` | **ACCURATE / DUPLICATED** | `completed` 不是验收；Continue 只适用于 completed/failed/waiting_for_master 的返工、决定、恢复或报告修复。Base 多处重复且嵌入本仓库测试命令。新版分离项目测试要求。 |
| Codex 主会话 Token | **ACCURATE** | Base reporting 与 token 脚本一致：同 Thread Rollout `total` 快照差，缺失不估算。新版保留唯一详细定义。 |
| 旧 JSON/Host/Runtime 规则 | **ACCURATE（部分元数据 STALE）** | Base 正文已声明 SQLite-only、旧 JSON 不是恢复源、Host/Companion 不当已启用能力；但多处验证元数据停在旧候选。新版更新为 Preview.3 Base，并删除历史权限审批个案。 |

**不确定项**：Base 仓库未跟踪任何可直接调用的既有 Master Prompt 独立模型评估 harness；任务所述“现有评估体系”是否另存于仓库外不确定。本报告因此交付机器可读静态评估夹具，不宣称真实模型 A/B。

## 2. 文本规模

统计范围为 root `SKILL.md` 加全部 Markdown references，不含测试和本报告。

| 版本 | 文件 | 行数 | 字符 | UTF-8 bytes | 估算 tokens |
|---|---:|---:|---:|---:|---:|
| Base | 9 | 321 | 23,965 | 48,437 | 15,562 |
| New | 8 | 230 | 15,481 | 28,939 | 9,220 |
| 差异 | -1 | -91 | -8,484 | -19,498 | -6,342 |

Token 估算公式：CJK/fullwidth 标点按 1 token，其余字符按 3.5 字符/token 向上取整。这是文本估计，不是 Host/tokenizer 实测；真实节省 **UNMEASURED**。

## 3. 规则处理

**合并**：`dispatch-workflow.md` + `task-package-templates.md` → `task-dispatch.md`；Ready Gate、公开 schema、模型选择、预算、whole/staged 模板与提交规则归一处。

**删除或降重**：重复授权、Ready Gate、Hold Recovery、被动监控、独立验收、Worker 自主性、五字段 JSON 输出合同、`zcode_continue` 限制；root 中 SQLite 内部恢复细节；本仓库专属 `npm run test:affected` / `npm run test:full` / R4 / 压力测试命令；旧模型 provider 必填指引、`ZCODE_BRIDGE_MODE=build` 生产建议、历史权限审批实测个案和过时验证元数据。

**保留**：显式 Bridge 调用授权；Goal 不产生授权；Worker 重大决定升级；取消/额度/未授权停止；正常执行不干预；授权范围内 Worker 自主闭环；独立验收；路径/worktree 非 OS 沙箱；未确认清理不绕过 Hold；可能终止 Worker 的 Recovery 先获用户明确授权；Attention 等待语义；Token/模型来源区分；SQLite-only 与旧 JSON 退役事实。

### P0 等价性矩阵

| P0 | Base | New | 结论 |
|---|---|---|---|
| 新独立任务需 Bridge 调用授权 | root + 多 reference 重复 | root 唯一主定义 | EQUIVALENT |
| Skill/历史任务/Goal 不产生授权 | root + delegation + goal | root 主定义，goal 仅生命周期 | EQUIVALENT |
| Worker 不擅自决定重大未决事项 | root + runtime + prompt | root + Prompt Builder 既有合同 | EQUIVALENT |
| 取消、额度耗尽、未授权操作停止 | root + review | root + review 终态处理 | EQUIVALENT |
| Master 不干预正常内部执行 | root + monitoring + review | root P0 + monitoring 操作 | EQUIVALENT |
| Worker 授权范围内自主闭环 | root + delegation + template | root + delegation | EQUIVALENT |
| Master 独立验收 | root + review + reporting | root + review + reporting 来源区分 | EQUIVALENT |
| Worktree/路径不是 OS 沙箱 | root + runtime + template | root + task-dispatch + runtime | EQUIVALENT |
| 未确认清理不得绕过 SQLite Hold | root + review + runtime | root P0 + review/runtime 细节 | EQUIVALENT |
| 可能终止存活 Worker 的恢复先获明确授权 | root + review | root P0 + review 操作 | EQUIVALENT |

## 4. 离线配对评估

机器可读夹具：`test/fixtures/master-skill-evaluation-20261111.json`；测试入口：`test/skill-policy.test.ts`。相同 19 个场景由人工静态评审分别作用于 Base 与 New 文本，四项指标（规划责任、边界质量、验收质量、效率）各 0–2 分。自动测试只检查元数据、场景覆盖、评分范围/总分和 forbidden 规则覆盖，不自动推理 Skill 行为。

- 覆盖任务要求的 14 个必选场景，另加用户指定执行器、未知进程身份、权限请求、模型路由冲突、报告修复。
- Base：19 场景 127/152；`model-routing-conflict` 4/8，另有多处效率扣分。
- New：19 场景 152/152；每场景 8/8，四项均无 0。
- 未出现越权派发、额度耗尽后续作、Worker 报告当验收、`auto` 当 MCP 字段或无意义阶段门。

这是人工静态配对评估；未调用独立模型，未使用相同模型/推理档位执行真实输出 A/B，因此 **真实模型 A/B PASS 不能声称**。

## 4.1 Review 定向修订

根据 PR #78 的独立审查意见，本轮追加修正且不改变报告制度或 Runtime 合同：

- Root 恢复“用户明确选择 ZCode/Bridge 时，不得仅因 Master 自认为更快而擅自自做”的执行器优先规则。
- `task-dispatch.md` 固化四类 `task_id` 处理：相同内容幂等重放、不同内容 `TASK_ID_CONFLICT`、回执丢失/结果未知先查原 ID、已失败任务按 Result/Cleanup/Hold 决定 Recovery 或 `zcode_continue`。
- Recovery 授权限定为当前明确操作；禁止同一 Operation 并发终止，失败后保持 Hold，原授权范围内可重试，身份/范围变化重新授权。
- Ledger 枚举限定为可选 ProjectTask 局部视图，不把它说成 Bridge Task/Attempt 全局发现能力。
- 补齐 ADR-031 非权威权益缓存对后续新任务的选路影响，以及未知/网络/风控/身份失败不回退的边界。

## 5. 渐进式加载路由

| 行为 | New 路由 |
|---|---|
| 授权、停止、P0 边界 | root |
| whole/staged/auto 决策、能力未知 | `delegation-policy.md` |
| Ready Gate、TaskPackage、模型、预算、提交 | `task-dispatch.md`；提交前加 `monitoring-and-approval.md` |
| 持续 Goal | `goal-lifecycle.md` |
| 事件、Attention、权限交互 | `monitoring-and-approval.md` |
| 终态、验收、返工、Hold Recovery | `review-and-recovery.md` |
| 锁、路径、Runtime 事实 | `runtime-boundaries.md` |
| 报告、Token、模型证据 | `reporting.md` |

## 6. 验证记录

- `npm run test:affected`：最终 **PASS**；TARGETED 选择 `test/skill-policy.test.ts`，包含 typecheck、build、plugin validation、`git diff --check`；9 tests / 9 pass / 0 fail / 0 skipped；`STRESS_TESTS_NOT_APPLICABLE`。
- 中间两次测试失败为测试仍匹配旧措辞（root 未含“默认不自动调用”与“额度”字面），已更新断言后通过；一次 build 因新 worktree 缺依赖失败，执行 `npm ci` 后复跑通过。
- Frontmatter、reference 存在性、删除文件残留引用、P0/授权/Recovery/auto/project-test/task_id 幂等/模型路由/评估元数据断言、19 场景评估断言均由上述测试覆盖。
- 手工核对 `src/mcp/schemas.ts`、`src/interfaces.ts`、`src/prompts/task-prompt.ts`：生产代码和合同未改；`model.provider_id` 公开可选、持久化前路由为完整选择、五字段 JSON 输出合同仍由 Prompt Builder 注入。
- 未运行 full CI、压力测试、真实 Provider E2E、真实 Host token 测量或生产 Recovery。

构建验证会重建生成物；本任务最终不提交 `dist/`、worker bundle 或 skill 脚本内容变化。

## 7. 剩余风险与 Owner 决定

1. 真实 Master 模型遵循率、失败率和 Host token 节省未测量；需要独立模型/相同推理档位授权后才能做 A/B。
2. SQLite Hold Recovery 与固定 `yolo` 行为仅静态核对当前合同/源码，未做真实进程恢复验收。
3. 仓库外是否存在任务所述既有评估体系不确定；本候选使用新增静态夹具。
4. Skill 精简不更新已安装插件；安装面需要后续发布/安装流程处理。
5. 无阻塞 Owner 决定；是否接受“root 64 行（略高于建议 55–60 行）”以保留 P0 可读性，可在 review 时决定。
