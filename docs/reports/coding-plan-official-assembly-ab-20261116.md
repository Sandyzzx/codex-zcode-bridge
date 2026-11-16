# Coding Plan 官方装配 A/B 实验报告

> Status: RESEARCH
> Date: 2026-11-16
> Branch: `codex/coding-plan-assembly-ab-20261116`
> Base: `02cf2fa92c8235370fe7a883d4c5b30d93a8ab33` (`origin/preview`)
> Official source: ZCode `3.18.2`, commit `fec975905a2abd4c07e35c40d51fa097a2258ec9`,
> tree `5e90fec80706b8381f94e4eef48cf821b9868916`
> Evidence class: 固定官方源码、Bridge 源码、离线 Harness、既有 A/N 计费证据
> Security boundary: 未读取、输出或哈希比较 Access Token、Project Token、API Key、Refresh Token、
> Cookie 或 JWT 原文

## 1. 最终结论

| 项目 | 结论 | 证据边界 |
|---|---|---|
| 离线 A/B 装配证据工具 | `PASS` | 9 项测试通过；固定源码校验、脱敏、比较、输出边界和 fail-closed gate 均有断言 |
| 官方装配安全复用 | `BLOCKED` | Settings、CA、credential migration 和 Project Token location 存在持久化副作用；未证明可安全隔离 |
| A — Bridge 当前实现 | `FAIL` | 既有 16:00、18:00 两个 Bridge 样本均未应用 `0.67`；本轮未重跑 |
| N — 原生 ZCode | `PASS` | 既有 11:00、19:00 两个原生窗口均与 `0.5 x 0.67` 吻合；本轮未重跑 |
| B — 扩展官方装配实验 | `INCONCLUSIVE` | 未初始化、未发起模型请求、没有 B 的官方前后账单 |
| 最终认证材料结构差异 | `NONE`（合成 Fixture） | Provider、Model、Account、Request Auth、Usage Scene 相同；只证明 Fixture 归一化结果 |
| Runtime/Transport 装配差异 | `CONFIRMED` | Settings-aware access、Host transport、OAuth 恢复钩子和 cipher 生命周期不同 |
| Project 身份一致性 | `UNKNOWN` | 没有比较真实 Project Token scope、`apiKeyId` 或服务端计费身份 |
| `0.67` 的服务端触发条件 | `UNKNOWN` | 没有发现它进入最终请求 Auth；不能从本地结构反推服务端权益规则 |
| Root cause confidence | `LOW` | 已确认 Runtime 结构差异，但不能证明它就是计费差异原因 |

本轮结论不是“官方装配复用没有效果”，而是“在满足无写入、可释放和可对账门禁前，不应执行 B”。
本轮也没有把既有 A/N 证据重新包装成新的受控 A/B 结果。

## 2. A / N / B 实验定义与控制变量

| 组别 | 运行时路径 | 状态 | 说明 |
|---|---|---|---|
| A | Bridge Worker -> simplified account access -> Bridge minimal official factory -> official Request Auth -> official Project Token Client -> official AppServer | 既有证据 | 不重跑；16:00 和 18:00 计费样本已存在 |
| N | Desktop full Local Services -> settings-aware access -> official Request Auth -> official Project Token Client -> official AppServer | 既有证据 | 不重跑；11:00 和 19:00 原生计费样本已存在 |
| B | 在同账号、同 Provider、同 Model、同 Usage Scene 下，用受控实验装配替换 Runtime 组件，最后仍进入官方 Request Auth、Project Token 和 AppServer | 未执行 | 隔离门禁未通过；不能把静态分析称为 B 结果 |

目标控制变量：

- Provider：`account:bigmodel-individual-coding-plan`
- Model：`GLM-5.3-Flash`
- Usage Scene：`CODING_PLAN`
- Account scope：个人账户
- 时区：`Asia/Shanghai`
- 认证实现：官方 Request Auth、官方 Project Token Client、官方 AppServer

既有 A/N 证据的局限：

- A 和 N 不是同一 Prompt、同一上下文、同一小时的严格配对实验。
- 16:00 Bridge 是四个 main-turn 请求的小时聚合；18:00 是一次成功主请求。
- 19:00 原生桶是主请求加自动 `project_memory_extract` 的聚合残差。
- 11:00 是原生设置页 connectivity probe，不是普通主 Turn。
- 这些差异不妨碍成本公式对账，但并不使 A/N 成为 B 的替代品。

## 3. 官方装配差异与源码证据

以下 ZCode 内部结构均为 Observed at `3.18.2`，不是官方公共合同。

### 3.1 固定源码与代码来源

离线工具只读取：

```text
D:\codex-zcode-bridge\.run\z182-ab-source
```

运行前验证：

```text
version: 3.18.2
commit:  fec975905a2abd4c07e35c40d51fa097a2258ec9
tree:    5e90fec80706b8381f94e4eef48cf821b9868916
status:  clean detached checkout
```

源码审计只调用本地 `git` 和受限文件读取，不访问网络，不初始化模型运行时。

### 3.2 原生 ZCode

| 边界 | Observed source | 观察 |
|---|---|---|
| Settings 创建 | `packages/desktop/src/host/index.ts:4043` | Desktop 创建带 migrations 的 Setting Service |
| 完整服务图 | `packages/desktop/src/host/index.ts:4066` | Desktop 调用 `createLocalServices(...)` |
| CA 副作用 | `packages/services/src/node.ts:1414` | `createLocalServices` 路径调用 `ensureAppCaCert()` |
| Settings-aware access | `packages/services/src/node.ts:1619` | 最终 account access 由 settings、账号身份和计划材料共同解析 |
| Host transport | `packages/services/src/node.ts:1478` | 官方 API client 使用 Host network transport |
| Project Token Client | `packages/services/src/node.ts:1575` | 使用官方 `createAccountProjectTokenClient(...)` |

原生链的关键点不是 UI，而是 Host 生命周期、Settings、网络 transport、凭据恢复和账号 access
解析共同构成官方 Desktop 运行上下文。

### 3.3 Bridge

| 边界 | Observed source | 观察 |
|---|---|---|
| 简化 access callback | `src/worker/worker-main.ts:602` | Bridge 校验目标 account type、mode 和 `entitled` 后返回规范化的 individual Coding Plan access |
| Minimal official factory | `upstream/zcode-3.18.2/patches/0002-oauth-refresh-coordination.patch:94` | Bridge 新增精简 Host 装配，不启动完整 Desktop services |
| 默认 API client | 同一 patch `:106` | 未注入 Host transport 时使用 `createNodeApiClient()` |
| Project Token Client | 同一 patch `:135` | 仍调用官方 `createAccountProjectTokenClient(...)` |
| 官方 Request Auth | 同一 patch `:157` | 仍调用官方 `createAccountProviderRequestAuthService(...)` |
| AppServer runtime auth | `src/adapters/zcode-app-server-adapter.ts:1953` | Bridge 拦截 `interaction/requestProviderRuntimeHeaders` |
| Runtime auth 转发 | `src/adapters/zcode-app-server-adapter.ts:2006` | 校验 session/turn/provider/model 后把官方结果交回 AppServer |

### 3.4 汇合点

两边的最终模型认证边界相同：

- `packages/services/src/model-provider/accountProviderRequestAuthService.ts:119`
  返回 `apiKey`，可选 `apiKeyId`，可选 `accountScope`。
- `packages/shared/src/project-access-token-client.ts:213`
  使用 `usageScene: API_KEY_USAGE_SCENE.CODING_PLAN`。
- `apps/zcode-cli/packages/adapters/src/model/model-execution.ts:256`
  把 `requestAuth` 应用于最终模型 Provider 配置。

源码没有发现 `discount`、`campaign` 或活动系数字段进入最终 Model Request Auth。`apiKeyId` 是
官方 endpoint/routing metadata，不是已证实的计费 Header。这个“未发现”只能说明本地代码边界，
不能证明服务端没有基于 Token scope、账户权益或隐藏服务端状态进行判断。

## 4. 有效认证上下文差异

### 4.1 既有可见请求表面

先前 Cost Lab 已比较一次原生主请求与一次 Bridge 主请求：

```text
VISIBLE_REQUEST_HEADER_PARITY: PASS
BILLING_OUTCOME_PARITY: FAIL
```

13 个稳定可见 Header、Base URL、`querySource=main_turn` 和 `sessionType=main` 一致。该结论不回填
本轮 B，因为本轮没有新的真实 HTTP 请求；它也不能代替 Authorization、Project Token scope 或
服务端计费身份比较。

### 4.2 合成 Fixture 比较

离线 Harness 将输入归一化到：

```text
provider_id
model_id
account.family
account.plan_kind
account.scope presence/format
request_auth.api_key_present
request_auth.api_key_id
request_auth.header_names
usage_scene
transport.kind
```

Project Token 原文不进入证据。`apiKeyId` 保留为非秘密元数据；跨进程身份没有通过 Token 哈希
建立指纹。

合成结果：

```text
final_request_auth_surface_delta: NONE
transport_delta: PRESENT
project_identity_parity: FIXTURE_EQUAL
```

含义：

- 当合成 Fixture 的最终认证表面相同时，原生/Bridge 的 transport 名称差异不再错误地报告为
  Request Auth 表面差异。
- `FIXTURE_EQUAL` 只表示 Fixture 输入一致，绝不是真实 Project identity 相同。
- 真实 `PROJECT_IDENTITY_PARITY` 继续保持 `UNKNOWN`。

### 4.3 已确认差异的最终链路影响

| 差异 | 是否进入最终模型请求 Auth | 判断 |
|---|---|---|
| Settings-aware access resolver 对 simplified callback | 间接影响 canonical account access | `STRUCTURAL_RUNTIME_ONLY` on available evidence |
| Host network transport 对默认 Node API client | 影响 OAuth/Project Token 获取路径 | 可能影响换证传输，不直接进入模型 Header |
| OAuth 失效与 associated refresh hooks | 影响凭据恢复和重签路径 | 不直接进入模型 Auth |
| cipher IPC / credential lifecycle | 影响解密与凭据迁移 | 不直接进入模型 Auth |
| Project Token Client | 是，官方实现相同 | `SHARED_OFFICIAL_IMPLEMENTATION` |
| Request Auth Service | 是，官方实现相同 | `SHARED_OFFICIAL_IMPLEMENTATION` |
| Official AppServer | 是，官方实现相同 | `SHARED_OFFICIAL_IMPLEMENTATION` |

这些差异足以说明“Runtime assembly delta confirmed”，但不足以建立“Runtime assembly -> 0.67
缺失”的因果关系。

## 5. B 初始化与隔离验证

### 5.1 结果

```text
B_INITIALIZATION: NOT_RUN
B_MODEL_REQUESTS: 0
B_HTTP_REQUESTS: 0
B_OFFICIAL_BEFORE_AFTER: NOT_CAPTURED
LIVE_PROBE_GATE: LIVE_PROBE_BLOCKED
```

当前 Harness 没有 live mode；`--live` 会直接 fail closed。没有把离线的官方源码导入错误描述为
“官方服务组件已初始化”。

### 5.2 阻断原因

1. **Settings 可能写入**
   `packages/services/src/setting/settingService.ts:343` 的 `get()` 路径可执行
   `writeSettings(...)`，因此不能声明初始化只读。
2. **完整 Local Services 有 CA 副作用**
   `packages/services/src/node.ts:1414` 调用 `ensureAppCaCert()`，首次或修复路径可能生成文件。
3. **Credential Service 可能迁移写盘**
   `packages/services/src/credential/credentialService.ts:159` 到 `:160` 会在读取旧格式值时
   `writeAll(...)`。
4. **Project Token Client 可能持久化 location**
   `packages/shared/src/project-access-token-client.ts:201` 等路径可保存
   `project_token_location`，不能宣称非变更。
5. **没有批准的官方账单直读器**
   当前 Cost Lab 只有人工快照导入能力；B 无法取得同一请求窗口的官方 before/after。
6. **无法证明独占计费窗口**
   官方账单是小时聚合，当前没有 request-level join，也没有隔离其他同账号请求的机制。
7. **没有 live Harness 的资源释放证据**
   官方服务、AppServer、网络、凭据和设置生命周期尚未做过带清理证明的隔离运行。

在这些条件满足前执行一次 B 请求，既不能得到可靠账单归属，又可能改动共享认证/设置状态，违反
本 Goal 的 P0 隔离要求。

### 5.3 离线输出边界

Harness 只写入：

```text
.run/coding-plan-assembly-ab-20261116/offline-evidence.json
```

输出写入检查要求目标位于任务的 `.run` 根内，并使用临时文件加 rename。实验路径没有被
`build-core.mjs`、`build-plugin.mjs` 或官方 Host Runtime 构建脚本引用，因此不会进入生产 Bundle。

## 6. 官方账单与既有 A/N 对账

本轮没有新的官方账单。以下数值来自既有 Cost Lab 证据，只作为 A/N 基线：

| 北京时间桶 | 渠道 | Token | 官方积分 | 结论 |
|---|---|---:|---:|---|
| 11:00 | 原生 ZCode connectivity probe | 95 | 0.0215 | `0.5 x 0.67` |
| 16:00 | Bridge 四请求聚合 | 88,924 | 12.9707 | 高峰 `1.0`，无 `0.67` |
| 18:00 | Bridge 单主请求 | 23,412 | 2.7397 | 非高峰 `0.5`，无 `0.67` |
| 19:00 | 原生主请求 + memory extraction | 55,624 | 4.2902 | `0.5 x 0.67` |
| B | 未执行 | 无 | 无 | `INCONCLUSIVE` |

计算公式：

```text
BASE_CREDITS =
  uncached_input * 2.3 / 10000
  + cached_input * 0.56 / 10000
  + output * 8 / 10000
```

| 桶 | Base | Time multiplier | Expected without 0.67 | Expected with 0.67 | Actual | Effective factor vs no-0.67 |
|---|---:|---:|---:|---:|---:|---:|
| 11:00 | 0.06403 | 0.5 | 0.032015 | 0.02145005 | 0.0215 | 0.67156 |
| 16:00 | 12.970724 | 1.0 | 12.970724 | 8.69038508 | 12.9707 | 0.999998 |
| 18:00 | 5.47938 | 0.5 | 2.73969 | 1.8355923 | 2.7397 | 1.000004 |
| 19:00 | 12.80663 | 0.5 | 6.403315 | 4.29022105 | 4.2902 | 0.669997 |

差异均处于官方四位小数取整范围。16:00 和 18:00 是 Bridge 没有 `0.67` 的现有账单证据；
11:00 和 19:00 是原生取得 `0.67` 的现有账单证据。

## 7. `0.67` 优惠是否生效

### A — Bridge 当前实现

```text
A_BASELINE_DISCOUNT: FAIL
```

“FAIL”表示期望的额外 `0.67` 没有出现在两个独立 Bridge 窗口，不表示 Bridge 任务执行失败。

### N — 原生 ZCode

```text
N_NATIVE_DISCOUNT: PASS
```

两个原生窗口与账单实际值吻合。它支持“当前个人 Coding Plan 账户和 GLM-5.3-Flash 在原生
ZCode 路径上具备优惠效果”，但不证明优惠绑定在哪个服务端字段。

### B — 官方装配实验

```text
B_DISCOUNT: INCONCLUSIVE
```

没有 B 请求、没有 B Usage、没有 B 官方 before/after 差分，因此不能给出 B 的积分结论。

### 优惠机制

当前能够确认的是账单结果：原生路径的扣分侧表现为基础积分乘 `0.5` 时段后再乘约 `0.67`，
等效可用额度约 `1 / 0.67 = 1.4925` 倍。当前没有证据证明它是独立赠点、额外套餐 grant 或某个
客户端可设置的字段。

`0.67` 的具体触发条件保持 `UNKNOWN`：

- 源码未发现 discount/campaign 字段进入最终 Model Request Auth。
- 客户端 `codingPlanBillingDiscount` 是活动文案读取器，不是已证明的计费开关。
- 真实 Project Token scope、`apiKeyId` 实例和服务端 billing identity 未比较。
- 既有 A/N 差异不能定位到 Settings、transport、OAuth、cipher 或隐藏服务端身份中的哪一项。

## 8. 原因证据强度

| 解释 | 强度 | 判断 |
|---|---|---|
| A — Bridge 使用了不同凭据来源 | LOW | 既有审计强烈支持同账号数据根和官方 Repository；真实 Token 不对等未比较 |
| B — 某个认证上下文未传完整 | LOW-MEDIUM | Bridge callback 更简化，但官方 Request Auth 之前的所有输入未证明缺失 |
| C — Runtime/Host 装配不同 | CONFIRMED LOCAL DIFFERENCE / CAUSALITY LOW | Settings、transport、OAuth、cipher 等差异已确认；未证明影响计费 |
| D — 服务端隐藏资格不同 | PRIMARY HYPOTHESIS / CONFIDENCE LOW | 最终请求表面相同而账单不同，但缺少服务端身份和规则证据 |
| E — 证据不足 | MATERIAL | B 未运行，真实 Project identity、Token scope 和 request-level billing 都未知 |

当前排序只能是：

```text
D primary hypothesis
C confirmed local difference, causality unknown
A/B/E remain possible contributing classes
```

不得将“Runtime 装配不同”升格为“根因已找到”。

## 9. 对 Coding Plan、Start Plan 和 Host Wake 的影响

### Coding Plan

- 现有 Bridge Coding Plan 请求仍可执行，但优惠差异保持真实存在。
- 本轮没有修改 Bridge 认证、Provider、路由、Header 或生产 Worker。
- 任何后续修复都必须保留官方 Project Token Client、`CODING_PLAN` usage scene，
  session/turn/provider/model 绑定和现有计费核对。

### Start Plan

- `START_PLAN_CHANGED: NO`
- 未使用 Start Plan，未触碰旧 Start Plan cleanup 任务。
- 本实验的 Settings/credential 阻断说明：不能为了 Test B 复用完整 Desktop 服务图而顺带改变
  Start Plan lease、认证或清理语义。

### Host Wake 与调度

- `HOST_WAKE_CONFLICT: NONE`
- 未启动、停止、重启或重派 Bridge Host、Worker、Lifecycle Manager、SQLite Authority 或 Host Wake
  实验进程。
- 未写生产 SQLite，未改变其他 Agent 的 Worktree。

## 10. 正式修复判断与最小边界

`MINIMAL_REPAIR_CANDIDATE: NONE APPROVED`。

当前不应实现以下改动：

- 伪造 ZCode User-Agent、Header、设备身份或客户端标签。
- 硬编码 `0.67` 或直接修改 billing 结果。
- 复制 Token、切换身份或反复重签 Project Token。
- 为了测试优惠把完整 Desktop `createLocalServices` 直接接入生产 Worker。

如果 Owner 决定继续，下一步必须先建立安全证据通道：

1. 官方 Settings 初始化可证明只读，或使用不会执行 migration 的官方只读 adapter。
2. Credential migration 与 Project Token location 写入被隔离，或可证明为非变更。
3. 官方账单能提供同一小时窗口的 before/after，最好有非秘密 request/turn join。
4. 能证明实验窗口没有其他同账号、同模型请求。
5. 实验服务、AppServer、网络和凭据资源有确定性释放路径。
6. 实验代码有显式开关，默认禁用，不进入生产 Bundle。

满足这些门禁后，最多执行一次最小 B 请求。B 若仍得不到 `0.67`，应报告 `FAIL`，并把调查收窄到
真实 Project identity/Token scope 和官方服务端权益；若无法可靠对账，应保持 `INCONCLUSIVE`，
不能通过增加请求次数寻找期望结果。

## 11. 验证与工程结果

| 命令 | 结果 |
|---|---|
| `node --test tools/cost-lab/test/official-assembly-probe.test.mjs` | PASS，9 pass / 0 fail / 0 skip |
| `node tools/cost-lab/official-assembly-probe.mjs` | PASS；`0` model requests，`0` network requests，`LIVE_PROBE_BLOCKED` |
| `npm run test:affected`（实现阶段，生成的 Bundle 变更触发相关域） | PASS，`TARGETED_TESTS_PASS`；23 pass / 0 fail / 0 skip |
| `npm run test:affected`（最终文件集） | `NO_TESTS_APPLICABLE`；T0 typecheck/build/plugin validation/generated freshness/diff check 均通过，不能称为 targeted-test PASS |
| Typecheck | PASS，由 `test:affected` 执行 |
| Build | PASS，由 `test:affected` 执行 |
| Plugin validation | PASS，由 `test:affected` 执行 |
| Generated artifact freshness | PASS，12 files fresh |
| `git diff --check` | PASS |
| Stress gate | `STRESS_TESTS_NOT_APPLICABLE` |

受影响验证的首次尝试因隔离 Worktree 没有 `node_modules/playwright-core` 在插件 build 阶段失败；
该次失败没有运行测试或修改源码结论。随后在 Worktree 内建立仅指向现有依赖的 `node_modules`
Junction 并重跑，上表记录重跑后的有效结果。

离线证据：

```text
.run/coding-plan-assembly-ab-20261116/offline-evidence.json
```

当前生成结果的 SHA-256 为：

```text
5faeea4f534a0a47e436f3af7ea7081e94633a2d49a17c6bae1a0e88bf82e57b
```

该文件位于忽略目录，不提交；因包含生成时间，重新运行会得到不同哈希。

## 12. 剩余不确定性

- B 未执行，因此不能回答“扩展官方装配能否恢复优惠”。
- 真实原生/Bridge Project Token 的 scope、Project/Organization 绑定和 `apiKeyId` 实例未比较。
- 没有 request-level 官方积分流水；小时聚合不能排除 Token 分类完全相同的未知并行请求。
- 客户端没有把 `discount`/`campaign` 字段送入最终模型 Auth，但服务端隐藏资格仍是 `UNKNOWN`。
- Settings、CA、credential migration 和 Project Token location 的实际写入范围没有通过 live
  probe 验证；安全路线尚未建立。
- 先前失败的嵌套官方源码检出不属于注册 Worktree，也没有提交；本轮执行策略拒绝了递归删除，
  因此它仍留在任务忽略目录中。它未被 Harness 使用，不影响源码固定或计费结论。

## 13. 最终状态

```text
GOAL: CODING_PLAN_OFFICIAL_ASSEMBLY_AB_PROBE

IMPLEMENTATION: PASS
OFFICIAL_ASSEMBLY_REUSE: BLOCKED
A_BASELINE_DISCOUNT: FAIL
N_NATIVE_DISCOUNT: PASS
B_DISCOUNT: INCONCLUSIVE
AUTH_CONTEXT_DELTA: CONFIRMED runtime-only structural difference; no discount/campaign field observed at final request-auth boundary; live billing effect UNKNOWN
PROJECT_IDENTITY_PARITY: UNKNOWN
RUNTIME_ASSEMBLY_DELTA: CONFIRMED
REAL_MODEL_TASKS: 0
REAL_HTTP_REQUESTS: 0
ACTUAL_CREDITS: NONE
EXPECTED_WITHOUT_0_67: NOT_COMPUTED
EXPECTED_WITH_0_67: NOT_COMPUTED
BILLING_RECONCILIATION: BLOCKED
ROOT_CAUSE_CONFIDENCE: LOW
PRODUCTION_CODE_CHANGED: NO
HOST_WAKE_CONFLICT: NONE
START_PLAN_CHANGED: NO
MINIMAL_REPAIR_CANDIDATE: NONE APPROVED; require safe read-only official composition and non-mutating credential/billing access first
NEXT_ACTION: Owner decides whether to provide an approved read-only official assembly and billing access path before any single B request
```
