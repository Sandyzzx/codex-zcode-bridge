# Coding Plan Regression RCA and Real E2E

> Status: RESEARCH
> Date: 2026-11-20
> Branch: `codex/unified-official-appserver-startplan-20261119`
> Worktree: `.run/unified-official-appserver-startplan-20261119`
> Baseline HEAD: `5e02e30cef0aa8c05fd3d6782f9039041a0eefe5`
> Baseline tree: `6761d75dde468a4d6972b2bab8aa1a5ab4c12b966`
> Code fix: `bc03ac41c5d7211000d4765f9526948cf0e796d7`
> Code-fix tree: `f9b0c7572c6e5f8feab5c7cceb33e2eb2f816039`

## 1. 结论

Thin Adapter 后的连续 `turn_started -> turn_failed` 已定位为 Bridge 生产
Worker 中的 **Resolver 捕获时序缺陷**，不是 Coding Plan 凭据失效，也不是官方
AppServer 或上游 Provider 拒绝。

修复后，生产路径完成了一次真实 Coding Plan 请求，并在官方延迟结算后的同一
小时桶取得精确 Token 和 Credits 对账：

```text
Coding Plan request usage: 22,795 tokens
Official hour usage:       22,795 tokens
Official credits:             1.7808
Effective extra ratio:        0.6700013733
```

因此 Coding Plan 执行和额外 `0.67` 倍率均成立：

```text
CODING_PLAN_REAL_E2E: PASS
CODING_PLAN_MULTIPLIER: VERIFIED
CODING_PLAN_BILLING: PASS
```

Start Plan 的生产 E2E 也已完成。该套餐按产品定义免费提供一定数量的 Token，
不提供 Coding Plan 的积分折扣；官方响应同样以 `unit_type: "token"` 和
`used_units` 记账。本次余额增量精确等于 Runtime Usage `114,362`，因此验收目标
是官方 Token 配额扣减对账，而不是一个并不存在的 Credits 活动倍率。

因此：

```text
START_PLAN_REAL_E2E: PASS
START_PLAN_MULTIPLIER: NOT_APPLICABLE / NO_DISCOUNT
START_PLAN_BILLING: TOKEN_UNIT_RECONCILED / PASS
```

两类套餐的计费语义均已得到与各自产品模型一致的对账证据，最终合并状态由
PR CI 完成后决定：

```text
PREVIEW_MERGE: PENDING REQUIRED CI
FINAL_VERDICT: PASS PENDING MERGE/CI
```

## 2. 历史成功路径与当前路径差异

### 2026-11-14 / 2026-11-17 成功基线

历史 Coding Plan 成功提交：

- `a754545eb83d8e314c727c3ca0df0a2d3f47325d`
- `8da4e61a79137dece48300ef6664ccc1ea4836db`

这两个版本都先构造完整的 `resolveProviderRuntimeAuth`，再把该函数放入
`adapterOptions`。因此 Adapter 捕获到的函数本身就是可变闭包，后续账户、
Runtime 与请求上下文都通过该函数动态解析。

### Thin Adapter 回归版本

ADR-041 实现提交 `a676c6cd14573f2620339f992a345ed0715541ff` 改为：

1. 先创建初始 `resolveProviderRuntimeAuth` fallback；
2. 将该 fallback 写入 `adapterOptions`；
3. 在选定 production Adapter 后再对局部变量
   `resolveProviderRuntimeAuth` 赋值为真实 resolver；
4. Adapter 仍持有步骤 2 捕获的旧 fallback。

后续赋值没有修改 `adapterOptions.resolveProviderRuntimeAuth`，也没有修改
Adapter 已保存的私有字段。因此 OAuth、Keyring、账户发现和官方 Host 内部
认证即使正常，Adapter 仍调用“不可用”stub，随后 fail closed。

## 3. 根因证据

三个连续诊断窗口形成闭环：

| 尝试 | 本地开始时间 | Task | 结果 | 关键观测 |
|---|---|---|---|---|
| v3 | 07:58 | `costlab-b7ff2cbf-67b7-41ec-b325-e786062b1f68` | failed | 外层诊断与失败路径建立 |
| v4 | 08:23 | `costlab-b8c70272-a8d2-44c9-b3da-eec841e23a2d` | failed | `resolver_completed headers_applied:false`，无内层 resolver 诊断 |
| v5 | 08:27 | `costlab-f8338c3c-4a9f-44f7-b9ff-b7ecb37aaa1b` | completed | `headers_applied:true`，真实模型请求完成 |

v4 的调用链证明 Adapter 调用了被错误捕获的 stub：

```text
request_received
resolver_started
resolver_completed headers_applied:false
```

同时没有出现内层 resolver 的 `resolved`、`service_rejected`、
`input_rejected` 或 `resolver_rejected` 诊断。修复绑定后，v5 出现：

```text
resolver_started
resolved headers_applied:true request_auth_present:true
resolver_completed headers_applied:true
```

诊断只包含阶段、Provider/模型匹配、布尔值和错误类名，不包含 Token、Cookie、
API Key、JWT、Authorization、请求正文或异常消息正文。

证据文件：

- `.run/cost-lab-e2e/coding-regression-diagnostic-v3-20261120.json`
- `.run/cost-lab-e2e/coding-regression-diagnostic-v4-20261120.json`
- `.run/cost-lab-e2e/coding-regression-diagnostic-v5-20261120.json`

## 4. 修复

修复提交：`bc03ac41c5d7211000d4765f9526948cf0e796d7`

主要变更：

- 新增稳定身份的
  `createOfficialProviderRuntimeAuthDispatcher()`；Adapter 捕获固定
  dispatcher，不捕获随后会被替换的局部函数。
- Worker 在 Adapter 与官方 Session 完成装配后，通过 `bind()` 绑定真实
  Provider Runtime Auth Resolver。
- 增加 credential-free `runtime-auth` 阶段诊断，覆盖请求收到、身份拒绝、
  内层 resolver 开始/完成/拒绝和错误分类。
- Manager stderr allowlist 仅转发符合受限格式的
  `[bridge-worker] runtime-auth ...` 行。
- Cost Lab production runner 只保留同一受限 marker。
- 新增 dispatcher 时序、fail-closed、诊断脱敏和 stderr 转发测试。

修改文件：

- `src/runtime/official-provider-runtime-auth.ts`
- `src/worker/worker-main.ts`
- `src/adapters/zcode-app-server-adapter.ts`
- `src/manager/spawn-worker.ts`
- `src/host/stdio.ts`
- `test/official-provider-runtime-auth-diagnostics.test.ts`
- `test/spawn-worker-stderr.test.ts`
- `test/zcode-app-server-adapter.test.ts`
- `test/test-impact-map.json`
- `tools/cost-lab/production-verification-runner.mjs`
- `tools/cost-lab/test/production-verification-runner.test.mjs`
- `plugins/codex-zcode-bridge/dist/bridge.mjs`
- `plugins/codex-zcode-bridge/worker/worker-main.mjs`

## 5. 真实请求记录

本表只统计具有 runner request-level 证据的请求。较早的
`coding-e2e` / `final-coding-e2e` 试验因 runner 在任务证据写入前失败，保留为
superseded evidence-incomplete attempts，不纳入精确 Token/Credits 总量。

| Plan | Task | Provider / Model | Dispatches | Usage | 结果 |
|---|---|---|---:|---|---|
| Coding Plan | `costlab-eeb197ee-bfca-46ab-ade7-faca02df5107` | `account:bigmodel-individual-coding-plan` / `GLM-5.3-Flash` | 1 | UNKNOWN | failed |
| Coding Plan | `costlab-b7ff2cbf-67b7-41ec-b325-e786062b1f68` | 同上 | 1 | UNKNOWN | failed |
| Coding Plan | `costlab-b8c70272-a8d2-44c9-b3da-eec841e23a2d` | 同上 | 1 | UNKNOWN | failed |
| Coding Plan | `costlab-f8338c3c-4a9f-44f7-b9ff-b7ecb37aaa1b` | 同上 | 1 | 22,795 | completed |
| Start Plan | `costlab-5b4ae7a5-b29a-4009-adba-42b9d73121bc` | `account:bigmodel-start-plan` / `GLM-5.3-Flash` | 1 | 114,362 | completed |

共 5 个具有 request-level runner 证据的主请求；2 个成功完成，3 个失败且 Usage
明确保留为 UNKNOWN，没有将缺失 Usage 当成零。

## 6. Coding Plan Usage 与官方账单

成功请求：

- Task: `costlab-f8338c3c-4a9f-44f7-b9ff-b7ecb37aaa1b`
- Attempt: `1`
- Session: `sess_8c492720-d1f3-4785-a5f9-f9104189222e`
- Provider: `account:bigmodel-individual-coding-plan`
- Model: `GLM-5.3-Flash`
- Runtime: ZCode `3.18.2.10443`
- Runtime bundle SHA-256:
  `08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c`
- Terminal: `completed`
- SQLite Result / Cleanup / Release: observed

Usage：

| 字段 | Token |
|---|---:|
| Cached Input | 0 |
| Uncached Input | 22,667 |
| Output | 128 |
| Reasoning | 0 |
| Total | 22,795 |

请求后立即读取账单时，官方小时桶尚未出现模型行；没有把“尚未观察到”解释为
零扣费。随后在同一小时桶执行只读 fresh snapshot：

- 本地小时桶：`2026-11-20 08:00:00`，`Asia/Shanghai`
- Cached Input: `0`
- Uncached Input: `22,667`
- Output: `128`
- Total: `22,795`
- Credits: `1.7808`

计算公式：

```text
base =
  (22,667 * 2.3 + 128 * 8) / 10,000
  = 5.31581

time multiplier = 0.5

expected normal =
  5.31581 * 0.5
  = 2.657905

expected with 0.67 =
  2.657905 * 0.67
  = 1.78079635

actual official credits = 1.7808

effective extra ratio =
  1.7808 / 2.657905
  = 0.670001373262024
```

该小时桶只有这一个模型活动，Token 精确匹配。偏差来自官方四位小数取整：
`0.00000365` Credits。

证据：

- `.run/cost-lab-e2e/coding-regression-diagnostic-v5-20261120.json`
- `.run/cost-lab-e2e/coding-regression-fresh-v5-attempt-1-20261120.json`
- `.run/cost-lab-e2e/coding-regression-usage-v5-20261120.json`
- `.run/cost-lab-e2e/coding-regression-reconciliation-v5-20261120.json`

即时读取生成的 reconciliation 明确为 `INVALID_BILLING_DATA / INCONCLUSIVE`；
最终倍率结论来自后续 fresh snapshot 的精确同桶对账，不来自即时零行。

## 7. Start Plan Usage 与账单

成功请求：

- Task: `costlab-5b4ae7a5-b29a-4009-adba-42b9d73121bc`
- Attempt: `1`
- Session: `sess_3599a52f-06d1-420b-9060-a2e0f72c07c3`
- Provider: `account:bigmodel-start-plan`
- Model: `GLM-5.3-Flash`
- Terminal: `completed`
- Read / Write 工具与代码回读：PASS
- SQLite Result / Cleanup / Release: observed

Usage：

| 字段 | Token |
|---|---:|
| Cached Input | 90,688 |
| Uncached Input | 113,947 |
| Output | 415 |
| Reasoning | 0 |
| Total | 114,362 |

官方 Start Plan `billing/balance`：

- Endpoint:
  `GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.18.2`
- Plan: `zcode-v3-start-plan-1119`
- Entitlement: `GLM-5.3-Flash`
- `unit_type`: `token`
- Before `used_units`: `0`
- After `used_units`: `114,362`
- Used delta: `114,362`
- Remaining delta: `-114,362`
- Credential state unchanged: YES
- Keyring lock released: YES

Token-unit 对账精确通过：

```text
START_PLAN_TOKEN_DELTA = 114,362
RUNTIME_TOTAL_TOKENS   = 114,362
```

证据：

- `.run/cost-lab-e2e/final-startplan-before-20261120.json`
- `.run/cost-lab-e2e/final-startplan-e2e-20261120.json`

### Start Plan 计费语义

已检查本机安装版：

`C:\Users\Sandy\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs`

- Bytes: `15,675,386`
- SHA-256: `08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c`
- Runtime 定义了 Start Plan Billing current/balance URL。
- Runtime 中未找到 Start Plan 路径上的 `totalCredits` 或 `actualCredits`
  字段消费逻辑。
- 官方 Start Plan 响应只提供 Token entitlement 和 Token bucket。
- Start Plan 免费提供一定数量的 Token，不适用额外折扣倍率。

因此不能把“Token 扣减量”与“积分倍率”混为一个概念，也不能用 Coding Plan
的 `0.67` 结论替代 Start Plan。Start Plan 的正确验收对象是 Token 配额：

```text
START_PLAN_MULTIPLIER: NOT_APPLICABLE / NO_DISCOUNT
START_PLAN_BILLING: TOKEN_UNIT_RECONCILED / PASS
```

## 8. 测试与验证

### 修复提交前

- `npm run typecheck`: PASS
- `npm run build`: PASS
- `npm run cost-lab:test`: `84/84 PASS`
- 生成物 freshness 初检：按预期提示两个 bundle 待与源码一起提交

### 修复提交后

- `npm run test:affected` 自动选择 `FULL_SUITE`：
  - Tests: `950`
  - PASS: `947`
  - FAIL: `1`
  - SKIP: `2`
- Typecheck / Build / Plugin Validator / Generated Artifacts /
  `git diff --check`: PASS（在完整测试启动前均通过）
- 唯一失败：
  `ADR-031 Gate E1: a post-startup login is observed by the next dispatch...`
  在 73 秒后未观察到 `released` 生命周期事件。
- 该失败场景单独复跑：`1/1 PASS`，耗时 `17.4s`。这与仓库
  `PROJECT_STATE.md` 已记录的同类 `released` observation timeout 一致，
  不是本次 auth dispatcher 的断言失败。
- 本次修改的定向套件：
  `official-provider-runtime-auth-diagnostics`、
  `zcode-app-server-adapter`、`spawn-worker-stderr`：
  `47/47 PASS`

本轮没有把 flaky rerun 通过写成“完整回归首次全绿”；报告同时保留首次
`947/950` 和定向复跑结果。

## 9. Preview 合并

合并前置条件按两种套餐各自的真实计费语义验收。当前结果：

```text
Coding Plan REAL_E2E:        PASS
Coding Plan MULTIPLIER:      VERIFIED
Start Plan REAL_E2E:         PASS
Start Plan MULTIPLIER:       NOT_APPLICABLE / NO_DISCOUNT
Start Plan BILLING:          TOKEN_UNIT_RECONCILED / PASS
Official Billing Anomalies:  NONE
PR #103 REQUIRED CI:         PASS
```

因此候选分支满足合并到 `preview` 的计费、E2E、测试和 CI 条件。报告提交本身
会产生新的文档-only HEAD，合并前必须再次确认该 HEAD 的必需 CI 结果。正式
Merge Commit 以远程 `preview` 与 PR #103 的最终记录为准。

## 10. 未解决项

没有未解释的 Coding Plan Token/Credits 差异，也没有 Start Plan Token 配额
差异。Start Plan 不适用额外折扣倍率，因此不需要通过重复模型请求寻找不存在的
Credits 倍率。

```text
START_PLAN_MULTIPLIER: NOT_APPLICABLE / NO_DISCOUNT
FINAL_VERDICT: PASS PENDING FINAL HEAD CI AND MERGE
```
