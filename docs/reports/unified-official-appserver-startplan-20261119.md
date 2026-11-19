# Unified Official AppServer Runtime for Coding Plan and Start Plan

> Status: RESEARCH（一次性实现与离线验收记录，不替代当前合同）
> Date: 2026-11-19
> Branch: `codex/unified-official-appserver-startplan-20261119`
> Baseline: `f5390897978be995b3a942feaeaac0170e8849fa`
> Baseline tree: `08280044c51aee0db3258869b90b5cc80f3c33c8`
> Worktree: `.run/unified-official-appserver-startplan-20261119`

## 1. 实施结论

Coding Plan 与 BigModel Start Plan 的**执行 Runtime**现已统一：

```text
account:bigmodel-individual-coding-plan
account:bigmodel-start-plan
  -> OfficialAppServerWorkerAdapter
  -> OfficialAppServerRuntimeResolver
  -> installed resources/glm/zcode.cjs
  -> installed same-root builtin provider config
  -> installed zcode-runtime-host.exe
  -> existing Official Host Process Manager / Protocol / Cleanup
```

这次统一只覆盖安装版 AppServer、Official Host Process Manager、Session/Turn
和资源生命周期。Provider 认证、权益判定和执行能力仍然各自独立：

| 边界 | Coding Plan | Start Plan |
|---|---|---|
| 选择条件 | 精确 Coding Plan Provider ID | 精确 `account:bigmodel-start-plan` |
| Runtime 能力门禁 | `OFFICIAL_DISCOUNT_VERIFIED` | `OFFLINE_COMPATIBLE` |
| 是否依赖 Coding Plan `0.67` | 是 | 否 |
| Provider Runtime Auth | Official Host Provider Runtime Auth | Private Credential Lease |
| Billing / Entitlement | 既有 Coding Plan 路径 | 既有 Live Entitlement 路径 |
| 本轮真实认证/账单/模型请求 | `NOT_RUN` | `NOT_RUN` |

其他 Provider 继续使用既有的 `OfficialHostAdapter`，没有扩大安装版 Runtime
的适用范围。

## 2. 变更前与变更后

### 变更前

- 只有精确 Coding Plan Provider 进入 `OfficialAppServerWorkerAdapter`。
- Start Plan 使用 `OfficialHostAdapter`，即使它已经具备独立认证、Live Billing
  Entitlement、Private Credential Lease 和 Worker-parent 生命周期。
- `OfficialAppServerRuntimeResolver` 已经读取 Start Plan 的离线兼容性 Manifest
  字段，但没有把该字段暴露为 Runtime Descriptor，也没有 Provider 级能力门禁。
- Adapter 的默认语义容易把“Coding Plan 优惠已验证”误用为“所有计划都具备同等
  模型执行能力”。

### 变更后

- `OfficialAppServerRuntimeDescriptor` 增加
  `start_plan_static_compatibility`；未知或未验证 Runtime 明确为 `null`。
- `OfficialProviderRuntimeCapability` 区分
  `coding_plan_discount` 与 `start_plan_static`。
- `selectOfficialProviderRuntime` 只接受精确的官方 BigModel Provider ID；
  未知 Provider 返回 `null`，不会开启安装版 Runtime。
- `OfficialAppServerWorkerAdapter` 在创建 Session 或构造 Process Manager 前执行
  Provider 能力门禁。
- Start Plan 使用原始 Session Preferences，不把 Provider ID 改写为 Coding Plan。
- Start Plan 的 `resolveStartPlanRuntimeAuth`、Private Lease、父进程存活绑定和
  secret redaction 路径保持不变。

## 3. Runtime 路由矩阵

| Provider ID | Runtime | Capability | 其他 Provider 路径 |
|---|---|---|---|
| `account:bigmodel-individual-coding-plan` | Installed Official AppServer | `coding_plan_discount` | 未改变 |
| `bigmodel-individual-coding-plan` | Installed Official AppServer | `coding_plan_discount` | 兼容别名 |
| `builtin:bigmodel-coding-plan` | Installed Official AppServer | `coding_plan_discount` | 兼容别名 |
| `account:bigmodel-start-plan` | Installed Official AppServer | `start_plan_static` | 仅精确 ID |
| 其他任意 Provider | 既有 `OfficialHostAdapter` | 无安装版能力门禁 | 未改变 |

Provider ID 的选择器不导入 Runtime 模块，避免 Worker 初始化时提前加载认证或
Runtime 依赖。Provider registry 与认证仍是选择之后的权威门禁。

## 4. 能力门禁与失败语义

`officialProviderCapabilityFailure` 的判定为：

```text
descriptor.status != OFFICIAL_RUNTIME_VERIFIED
  -> 任一能力失败

capability = coding_plan_discount
  -> discount_capability == OFFICIAL_DISCOUNT_VERIFIED

capability = start_plan_static
  -> start_plan_static_compatibility == OFFLINE_COMPATIBLE
```

因此，已验证的安装版 Runtime 即使报告
`OFFICIAL_DISCOUNT_NOT_VERIFIED`，Start Plan 仍可以通过自己的 Runtime 能力门禁；
这证明 Start Plan 不依赖 Coding Plan 的优惠结论。反过来，Start Plan 的
`OFFLINE_RESEARCH_PENDING`、`OFFLINE_INCOMPATIBLE` 或未知值会 fail-closed。

门禁失败发生在：

1. `ZCodeAgentProcessManager` 构造之前；
2. `session/create` 或 `session/resume` 之前；
3. 任何 Provider Auth 或模型请求之前。

## 5. 认证边界保持不变

本轮没有修改或复制以下内容：

- Coding Plan OAuth / Project Token / API Key 签发；
- Start Plan official account authentication resolver；
- Start Plan Live Billing Entitlement；
- Private Credential Lease、父进程存活通道和任务级绑定；
- 设备身份、签名、Header、账号切换和过期/取消语义；
- 官方 ZCode 安装文件、共享凭据、生产 Authority 或 SQLite。

Start Plan 仍由 `resolveStartPlanRuntimeAuth` 提供一次性凭据；Coding Plan 仍由
Provider Runtime Auth 提供请求认证。两条路径没有回退关系。

## 6. 测试与验证

已实际执行：

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build:test` | PASS |
| `npm run build` | PASS；core、Bridge、Worker、browser bundle 重建 |
| 定向 Runtime / Capability / Selection / Adapter 测试 | PASS，14/14 |
| 定向 Worker 生命周期测试 | PASS，3/3 |
| `start-plan-production-auth`、`start-plan-official-appserver-offline`、`official-host-adapter` | PASS，49 pass / 1 expected skip / 50 total |
| `npm run validate:plugin` | PASS |
| `git diff --check` | PASS |
| 真实 Start Plan E2E | `NOT_RUN` |
| 真实 Native A/B | `NOT_RUN` |
| 官方 Billing 观察 | `NOT_RUN` |

定向 Worker 测试覆盖：

- 明确 Coding Plan 进入安装版 `OfficialAppServerWorkerAdapter`；
- Start Plan 的 fake Billing 成功路径进入同一个安装版 Adapter；
- Start Plan 在 `OFFICIAL_DISCOUNT_NOT_VERIFIED` 的测试 Runtime 下仍完成 Provider
  registration、Session、Private Auth 和模型 Turn；
- 凭据只通过私有 Runtime-header 回调交付，不出现在 AppServer 请求日志中。

先前的 `npm run test:affected` 曾因本 Worktree 没有本地 `node_modules`，在
`build:plugin` 复制 `playwright-core/browsers.json` 时停在 `ENOENT`。这不是代码
验证失败。本次在 ignored 的 Worktree 内建立指向根依赖目录的目录联接后，重新
执行了完整 `npm run build`，生成物已与源码同步。没有修改根工作区 WIP。

## 7. 受控限制

本轮全部结论仅来自离线与合成验证：

```yaml
OFFLINE_IMPLEMENTATION: PASS
STARTPLAN_REAL_ENTITLEMENT: NOT_RUN
STARTPLAN_REAL_E2E: NOT_RUN
NATIVE_AB_COMPARISON: NOT_RUN
BILLING_OBSERVATION: NOT_RUN
```

仍不能从本报告推断：

- 当前账户的 Start Plan 实际额度、Captcha、认证或模型权益；
- Start Plan 安装版 AppServer 的当前真实请求是否成功；
- Start Plan 与 Coding Plan 是否存在相同积分优惠；
- 官方服务端是否对两个 Provider 返回一致的计划或权益字段。

## 8. 后续真实 E2E Runbook

只有 Owner 重新授权真实请求后，才可按以下顺序验证：

1. 读取官方机器可读 Billing before snapshot；
2. 确认账户、Provider、模型、套餐及统计小时桶；
3. 通过正式 Bridge MCP、Manager、Worker 和 SQLite Authority 发起一次最小
   Start Plan 任务；
4. 记录认证结果、Provider registration、Session/Turn、Usage、Request ID；
5. 等待官方账单结算，读取 fresh after snapshot；
6. 按 Cached Input、Uncached Input、Output 和 Credits 对账；
7. 无法唯一归因时保留 `INCONCLUSIVE`，不得把缺失 Usage 记为零。

不得用 Coding Plan 凭据替代 Start Plan，不得模拟客户端身份，不得修改设备或
共享凭据，也不得在未取得 fresh before snapshot 时先发真实任务。

## 9. 最终状态

```yaml
GOAL: P0_UNIFY_CODING_PLAN_AND_START_PLAN_ON_ONE_OFFICIAL_INSTALLED_APPSERVER_RUNTIME

OFFLINE_IMPLEMENTATION: PASS
STARTPLAN_REAL_ENTITLEMENT: NOT_RUN
STARTPLAN_REAL_E2E: NOT_RUN
NATIVE_AB_COMPARISON: NOT_RUN
BILLING_OBSERVATION: NOT_RUN

RUNTIME_IDENTITY: INSTALLED_ZCODE_APPSERVER
SHARED_APPSERVER: YES
SHARED_PROCESS_MANAGER: YES
SHARED_LIFECYCLE: YES
CODING_PLAN_CAPABILITY: OFFICIAL_DISCOUNT_VERIFIED_REQUIRED
STARTPLAN_CAPABILITY: OFFLINE_COMPATIBLE_REQUIRED
COUPLED_DISCOUNT_GATE: NO
PROVIDER_AUTH_CHANGED: NO
PRODUCTION_CODE_CHANGED: YES
PRODUCTION_DEPLOYMENT: NO

TESTS: PASS
TYPECHECK: PASS
BUILD: PASS
PLUGIN_VALIDATION: PASS
DIFF_CHECK: PASS
FULL_CI: DEFERRED

COMMIT: reported in delivery envelope
TREE: reported in delivery envelope
REMOTE: reported in delivery envelope
REPORT: docs/reports/unified-official-appserver-startplan-20261119.md
```
