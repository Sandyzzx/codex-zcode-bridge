# ZCode 3.19.0 Unknown-Runtime Compatibility

> Status: RESEARCH
> Date: 2026-11-20
> Branch: `codex/zcode-3190-compat-20261120`
> Worktree: `D:\codex-zcode-bridge\.run\zcode-3190-compat-20261120`
> Baseline: `aedeb2c2a1ea6f41ea3ac2d045f7ed0d75281552` (`origin/preview`)
> Primary implementation commit: `aa755239645b355eb63288473567eb96de2bcd66`
> ADR-042 implementation commit: `15abe6becb13f383fee676a4ae20510d51f817fc`
> Runtime authorization env forwarding: `0e7134701d643c7b80def4e3cb80c95c63e34691`
> Runtime authorization env forwarding tree: `ec63f443cce54bad986eb47ab1b6274c604dcbfe`

## 1. 结论

未知官方版本现在不再因为“不在精确 Manifest 中”而永久拒绝。Resolver 会先
完成安装安全检查和完整指纹计算；只有精确指纹经过本地显式授权后，才进入
`OFFICIAL_RUNTIME_EXPERIMENTAL`。

本机 ZCode Desktop `3.19.0.10774` 已完成以下验证：

```text
INSTALLATION_SAFETY:             PASS
UNKNOWN_VERSION_INSPECTION:      PASS
FINGERPRINT_AUTHORIZATION:       PASS
ZERO_MODEL_PROTOCOL_SMOKE:       PASS
CODING_PLAN_REAL_MODEL_REQUEST:  PASS / 2 RUNS
CODING_PLAN_MULTIPLIER:          VERIFIED / 0.67
START_PLAN_LIVE_COMPATIBILITY:   BLOCKED / NO_ACTIVE_PLAN
OTHER_PROVIDER_LIVE_PROBE:       NOT_RUN
```

这不是把 3.19.0 提升为生产已验证版本。它只证明一个精确安装指纹在显式授权后
可以用于有界的兼容性探测。两次真实 Coding Plan 请求均完成请求级 Token 对账，
并在官方小时桶中观察到 `0.67` 额外倍率；这不自动推广到其他安装指纹、其他
Provider、Start Plan 或未覆盖的计费路径。

## 2. Unknown-Version 策略实现

实现遵循 Owner 的 UNKNOWN VERSION COMPATIBILITY POLICY：

1. 未知版本先执行完整安装指纹和基础安全检查。
2. 检查通过后，才允许用户签发与精确指纹绑定的实验授权。
3. 授权可按 `coding_plan_probe`、`start_plan_probe` 和
   `other_provider_probe` 分别授予。
4. AppServer、builtin Provider 配置、runtime-host、Desktop EXE、ASAR、
   签名主体或 Node 版本变化都会改变指纹并使旧授权失效。
5. 无效签名、非官方发布者、非 x64 PE、混合安装根或不支持 Node 始终
   hard block，不能由实验授权覆盖。
6. 实验运行不会改写 VERIFIED Manifest，也不会自动产生折扣或套餐兼容声明。

授权文件默认可从
`ZCODE_BRIDGE_EXPERIMENTAL_RUNTIME_AUTHORIZATION_FILE` 指向的绝对路径读取。
该非秘密配置键也进入 detached Worker 的显式环境转发白名单；否则只在父进程
环境设置路径时，真实 Worker 会错误地退回默认设置目录并以
`EXPERIMENTAL_AUTHORIZATION_REQUIRED` 失败。该修复由
`0e7134701d643c7b80def4e3cb80c95c63e34691` 引入，并由 `child-env` 回归覆盖。
本地授权工具：

```powershell
node tools/compatibility/authorize-official-runtime.mjs inspect
node tools/compatibility/authorize-official-runtime.mjs grant `
  --fingerprint <sha256> `
  --scope coding_plan_probe `
  --scope start_plan_probe `
  --scope other_provider_probe `
  --output <project-.run-path>
```

授权输出被限制在项目 `.run` 目录。授权文件必须是普通文件、合法 Schema、
无重复记录；Malformed、未知 scope、超过 64 KiB 或重复匹配记录均 fail closed。

## 3. 安装身份

| 字段 | 实测值 |
|---|---|
| Installation root | `C:\Users\Sandy\AppData\Local\Programs\ZCode` |
| Desktop | `3.19.0.10774` |
| AppVersion | `3.19.0` |
| BuildCommitId | `a7ed1054` |
| Node | `24.16.0` |
| Installation safety | `OFFICIAL_INSTALLATION_SAFE` |
| Fingerprint | `3e25056614f91d3651c237fbc89a076a1f9e834d351257423854844fb5b28290` |
| AppServer bundle | 15,843,692 bytes, `6b84e928d9258fe020c6ab8c75fa2c123b0cd658fe43c0ce141a13df677fb0ea` |
| builtin Provider config | 261,659 bytes, `ef3d64656cb5281cce292b77ef12e96b5251582cfb00cdf9eb08e3d4565abb69` |
| runtime-host | 179,608 bytes, `c87a9f3cf9cf920e4b5993aad69f8840a5d9bc7c0ae90b32acb29c15a1db0aae` |
| `ZCode.exe` | 246,332,312 bytes, `c5afb161a2d9389761d417ca668bc94311e3d2aff6ca3d0117b0b15701666f27` |
| `app.asar` | 385,171,742 bytes, `2421850970f361aaa1b3f1d6c960b101a5d476ad95631359d0413a19de1197cb` |

`ZCode.exe` 与 runtime-host 的 PE 架构均为 x64，Authenticode `Valid`，签名主体
为北京智谱华章科技股份有限公司，签名 thumbprint 均为
`6F7B147DC610F91425750D2449C46002C3385BCF`。

`a7ed1054` 是 Desktop 的 BuildCommitId，不是已核实的官方源码 Git commit。

## 4. 授权状态

不带授权文件时：

```text
Status: OFFICIAL_RUNTIME_UNVERIFIED
Authorization: required
Reason: EXPERIMENTAL_AUTHORIZATION_REQUIRED
```

使用与当前指纹匹配的授权文件时：

```text
Status: OFFICIAL_RUNTIME_EXPERIMENTAL
Authorization: authorized
Discount: OFFICIAL_DISCOUNT_NOT_VERIFIED
Start Plan static compatibility: OFFLINE_RESEARCH_PENDING
```

实验状态本身不包含任何 Provider 可靠性或计费优惠结论。

## 5. 零模型协议 Smoke

最终代码通过一次真实安装版 AppServer 零模型 Smoke：

| 项目 | 结果 |
|---|---|
| Protocol initialized | PASS |
| Method | `runtime/capabilities` |
| Capabilities received | PASS |
| Process started | PASS |
| Session created | NO |
| Model requests | 0 |
| Cleanup | PASS |
| Runtime status | `OFFICIAL_RUNTIME_EXPERIMENTAL` |
| Duration | 14,072 ms |

这证明最终实验态至少能启动官方 AppServer、完成协议初始化并正常释放进程；它
不证明 Session、Turn、模型、Provider 或计费。证据：
`.run/cost-lab-e2e/zcode319-protocol-smoke-postfix-20261120.json`。

## 6. Coding Plan 真实请求

在兼容性研究期间执行了两次真实 Coding Plan 请求：

| 样本 | Task | Session | Uncached Input | Output | Total | Runtime evidence |
|---|---|---|---:|---:|---:|---|
| 首次探测 | `costlab-cdc6b51b-8485-4782-b8bf-4bfafcd15dcc` | `sess_e58a88cc-175e-49d8-b478-f89c5d51b577` | 18,247 | 104 | 18,351 | `UNVERIFIED` |
| 最终路径复验 | `costlab-c68470fb-18f2-4f90-bfe0-3809dddcc485` | `sess_f25b5e04-4876-4dcc-aaee-a9756f2bb169` | 22,484 | 62 | 22,546 | `EXPERIMENTAL` |

两个样本均使用：

- Provider：`account:bigmodel-individual-coding-plan`
- Model：`GLM-5.3-Flash`
- Reasoning：`low`
- Terminal：`completed`
- SQLite Result / Cleanup / Release：观察到

首次请求发生时，Worker 尚未转发 `official_runtime_experimental` 标记，因此该
样本的运行证据是 `UNVERIFIED`。环境变量转发修复 `0e7134701` 落地后，第二次
请求明确观察到：

```text
runtime.status = OFFICIAL_RUNTIME_EXPERIMENTAL
runtime.version = 3.19.0.10774
bundle_sha256 = 6b84e928...677fb0ea
installed-runtime worker marker = PRESENT
failure_facts = null
operation_release_observed = true
```

因此最终代码路径不只是由合成测试覆盖，也完成了一次真实的三版本身份一致执行：
安装版 3.19 AppServer、固定 3.18.2-compatible Official Host 适配层、构建后的
Current Bridge Worker。

## 7. 官方账单与倍率

首次请求的即时和短延迟快照仍为零；后续 fresh snapshot 显示官方延迟结算已经
写入 15:00 小时桶。最终证据如下：

| 样本 | 小时桶 | Official Tokens | Official Credits | Expected Normal | Effective Extra Ratio |
|---|---|---:|---:|---:|---:|
| 首次探测 | `15:00:00` | 18,351 | 2.8676 | 4.28001 | 0.6699984346 |
| 最终路径复验 | `17:00:00` | 22,546 | 3.4980 | 5.22092 | 0.6699968588 |

两次 Token 分类均精确匹配：

```text
15:00 sample:
  uncached_input = 18,247
  cached_input   = 0
  output         = 104
  total          = 18,351
  credit_class   = EXTRA_0_67
  reconciliation = PASS

17:00 sample:
  uncached_input = 22,484
  cached_input   = 0
  output         = 62
  total          = 22,546
  credit_class   = EXTRA_0_67
  reconciliation = PASS
```

两个小时桶均位于星期五的 `14:00–18:00` 峰时窗口，官方当前账单的
`time_multiplier` 为 `1`。因此：

```text
CODING_PLAN_MULTIPLIER: VERIFIED / approximately 0.67
SAMPLE_COUNT: 2
BILLING_RECONCILIATION: PASS
```

首次请求也验证了延迟结算边界：约 6 分钟后的快照仍为零，但在之后重新读取同一
小时桶时出现了完整且精确匹配的 Token/Credits。缺失观察没有被解释为零扣费。

## 8. Start Plan

只执行了官方只读 `billing/balance` GET：

```text
GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance
```

分别使用 API query value `app_version=3.18.2` 与 `app_version=3.19.0` 执行
当前 live 读取；两者均 HTTP 200，但：

```json
{
  "plans": [],
  "balances": []
}
```

因此当前账户没有可验证的 active Start Plan：

```text
START_PLAN_STATUS: BLOCKED / NO_ACTIVE_PLAN
START_PLAN_REAL_MODEL_E2E: NOT_RUN
START_PLAN_COMPATIBILITY: NOT_VERIFIED
START_PLAN_DISCOUNT: NOT_APPLICABLE / NO_DISCOUNT
```

没有虚构 `used_units`，也没有用 Coding Plan 的认证或折扣结果替代 Start Plan。
最近一次 live 证据：

- `.run/cost-lab-e2e/zcode319-startplan-live-20261120.json`
- `.run/cost-lab-e2e/zcode319-startplan-live-app319-current-20261120.json`

两次读取均只发出 1 个官方 GET；凭据前后元数据一致，Keyring Lock 已释放，
模型请求为 0。由于账户没有 active Start Plan，模型 Session/Turn 与 Token
用量对账保持 `NOT_RUN`。

这里的 `3.18.2` / `3.19.0` 只是 Billing Reader 的 `app_version` query
值；两次读取都发生在当前装有 ZCode `3.19.0.10774` 的机器上，不是 3.18.2
安装版实机运行。本机没有 3.18 安装，因此不能用这两个请求声明 3.18.2
Start Plan Runtime 兼容。

## 9. 官方源码与 Host Patch

公开仓库 `zai-org/ZCode` 当前 `origin/main` 和 `v3.18.2` 均为：

```text
fec975905a2abd4c07e35c40d51fa097a2258ec9
tree 5e90fec80706b8381f94e4eef48cf821b9868916
```

未发现公开的 3.19.0 源码 Tag 或 Branch。因此 3.19 安装产物与公开源码的等价性
保持 `UNKNOWN`。三个既存 Official Host patch 没有被声明为 3.19 上游已合并，
状态继续为 `UPSTREAM_PENDING`。

## 10. 测试与生成物

最终验证结果：

| 检查 | 结果 |
|---|---|
| Typecheck | PASS |
| Targeted runtime/provider tests | 25/25 PASS |
| Cost Lab tests | 86/86 PASS |
| Build | PASS |
| Plugin Validator | PASS |
| Generated Artifacts | PASS，12 个文件均为最新 |
| Clean Entrypoints | 4/4 PASS |
| Affected selector | `FULL_SUITE` |
| `test:affected` full-suite run after `0e7134701` | 961 tests / 959 PASS / 0 FAIL / 2 SKIP |
| `test:full` (final documentation/evidence re-run) | 961 tests / 959 PASS / 0 FAIL / 2 SKIP |
| `git diff --check` | PASS |
| Final zero-model protocol smoke | PASS，14,072 ms |
| Real final-code Coding Plan E2E | PASS，22,546 Token |
| Real final-code billing reconciliation | PASS，ratio `0.6699968588` |

`npm run test:affected` 因本次 Runtime、Worker、生成 Bundle 与测试基础设施
变更选择完整回归。`0e7134701` 落地后的这次运行是最终代码证据：961 项中
959 PASS、0 FAIL、2 个显式 skip。另有一次 `npm run test:full` 也是相同结果，
但发生在环境变量转发修复之前，仅保留为较早的全量回归基线，不能替代修复后的
最终门禁。

授权与回退测试覆盖：

- Manifest 缺席但安装安全的未知版本；
- 精确指纹授权；
- 资产变化使授权失效；
- 非 x64/非官方签名 hard block；
- Malformed、未知 scope 与重复授权记录；
- Provider scope 独立；
- 实验态不会被 runner 提升为 `VERIFIED`；
- 实验协议 Smoke；
- 生产 Worker 缺失认证 resolver 的既有 fail-closed 边界。

## 11. Requirement Evidence Matrix

| Goal 要求 | 当前证据 | 判定 |
|---|---|---|
| 3.19.0 Runtime Identity | 安装根、Desktop/ASAR/Bundle/builtin/runtime-host 大小与 SHA-256、PE、Authenticode、Node | PASS |
| 官方 3.19.0 源码差异 | 公开仓库无 3.19.0 Tag/Branch；BuildCommitId 不等同源码 commit；只做安装产物静态与协议验证 | `SOURCE_EQUIVALENCE: UNKNOWN` |
| 保留 3.18.2 Manifest 与失败边界 | 原有 3.18.2 记录不变；`LEGACY_SAFETY_ONLY` 与 `FULL` pinning 分类测试；全套合成回归；历史 3.18.2 制品可核验但缺少完整 Desktop 安装 | PASS — SYNTHETIC |
| 未知版本安全检查 | 非 x64、无效/非官方签名、混合根、Node 不兼容、身份不完整均 hard block | PASS |
| 精确指纹授权 | 无授权 `UNVERIFIED`；匹配授权 `EXPERIMENTAL`；资产/Node/签名变化使授权失效 | PASS |
| Provider scope 独立 | Coding Plan、Start Plan、其他 Provider 各需对应 probe scope | PASS |
| 实验态不自动提升 | 授权与运行结果不写 Manifest；折扣保持 `NOT_VERIFIED`；Start Plan 保持 pending | PASS |
| 3.19.0 协议与真实 Coding Plan 执行 | 最终代码零模型协议 Smoke；2 次真实 Task completed；18,351 + 22,546 Token；最终运行时标记已观察 | PASS — EXPERIMENTAL |
| Coding Plan 倍率 | 两个峰时小时桶均精确匹配 Token；Credits 分别为 2.8676 / 3.4980；ratio 约 0.67 | `VERIFIED / 0.67` |
| Start Plan 真实 E2E 与 Token 对账 | 官方 `billing/balance` 对 3.18.2/3.19.0 均返回空 `plans/balances`；未发模型请求 | `BLOCKED / NO_ACTIVE_PLAN` |
| 完整回归 | `0e7134701` 后 `test:affected` 为 961/959 PASS、0 FAIL、2 SKIP；最终文档/证据状态再次运行 `test:full`，同为 961/959 PASS、0 FAIL、2 SKIP | PASS |
| 不合并、不发布、不修改生产状态 | 独立分支；工作区 clean；无 Preview merge/Release；无 SQLite/凭据/安装修改 | PASS |

## 12. Known Gaps

- 公开官方仓库没有可确认的 ZCode 3.19.0 源码身份，因此不能生成逐文件
  3.18.2 -> 3.19.0 官方源码 Diff，也不能把 Desktop `BuildCommitId`
  `a7ed1054` 当成源码 commit。
- 当前机器只保留 3.19.0 完整安装。历史目录中找到了由
  `fec975905a2abd4c07e35c40d51fa097a2258ec9` 构建的 3.18.2
  AppServer/Host 制品：`zcode.cjs` 31,009,692 bytes /
  `B55BA68C...CF639`，builtin config
  `BC760A3B...56CD`，runtime-host `04E1794F...FC24`。但没有匹配的
  完整 Desktop `ZCode.exe` 和 `app.asar`，因此不能把它与 3.19.0 Desktop
  混合成安装，也没有把它冒充成独立 3.18.2 生产安装。本轮 3.18.2 兼容性
  结论仍只来自原有精确 Manifest、历史证据和合成回归，不是新鲜实机 E2E。
- Owner 已确认当前机器只有已安装的 ZCode 3.19，没有 3.18；因此不再寻找或
  拼装 3.18 安装，也不把历史 3.18 制品与 3.19 Desktop 混用。
- 当前账户的 Start Plan Billing Reader 返回空套餐和空余额，无法建立 active
  entitlement；Owner 已明确要求 Start Plan 暂缓测试。因此真实 Start Plan
  Session/Turn、免费 Token 用量和配额前后对账均为 `NOT_RUN`，不能声明
  兼容或倍率。历史上的 `app_version=3.18.2` 读取只是 query 参数，不是
  3.18.2 安装版实机验证。
- 3.19.0 的 Other Provider 真实探测未运行，没有把通用 Runtime 启动成功当作
  其他 Provider 兼容证据。

## 13. Remaining Risks

- 3.19.0 安装 Bundle 与公开源码的等价性未知；未来官方更新可能改变未覆盖的
  Host、协议、认证或 Usage 行为。
- 3.19.0 Coding Plan 已获得两个无缓存、峰时、精确 Token 匹配的 0.67 样本；
  缓存输入权重、非峰时窗口、辅助请求和更长会话仍属于有限样本范围。
- Start Plan 的静态兼容路径已由合成测试保护，但没有当前机器的 live
  Entitlement、设备绑定、Private Lease 和真实模型证据。
- 实验授权降低的是“未知版本无法启动”的可用性障碍，不是安全门禁；异常签名、
  资产漂移、错误 scope 和 malformed 授权仍然 fail closed。

## 14. 安全与资源

```text
REAL_MODEL_REQUESTS: 2
START_PLAN_MODEL_REQUESTS: 0
CREDENTIALS_EXPORTED: NO
CREDENTIALS_MODIFIED: NO
OFFICIAL_INSTALL_MODIFIED: NO
PRODUCTION_SQLITE_MODIFIED: NO
PREVIEW_MERGED: NO
RELEASE_PUBLISHED: NO
```

本机安装目录只读检查，没有替换 ZCode 3.19.0，也没有修改认证、路由或持久凭据。

## 15. 最终判定

```yaml
GOAL: ZCODE_3_19_0_ADAPTATION_WITH_3_18_COMPATIBILITY

UNKNOWN_RUNTIME_POLICY: IMPLEMENTED
INSTALLATION_SAFETY: PASS
FINGERPRINT_AUTHORIZATION: PASS
ZERO_MODEL_PROTOCOL_SMOKE: PASS

ZCODE_3_19_CODING_PLAN_EXECUTION: PASS
ZCODE_3_19_CODING_PLAN_MULTIPLIER: VERIFIED / 0.67
ZCODE_3_19_CODING_PLAN_BILLING_RECONCILIATION: PASS / 2 SAMPLES
ZCODE_3_19_EFFECTIVE_EXTRA_RATIO: 0.6699968588 / FINAL RUN
ZCODE_3_19_START_PLAN: BLOCKED / NO_ACTIVE_PLAN
ZCODE_3_19_START_PLAN_TOKEN_RECONCILIATION: NOT_APPLICABLE_NO_ACTIVE_PLAN
ZCODE_3_19_OTHER_PROVIDERS: NOT_RUN

ZCODE_3_18_2_FRESH_REAL_E2E: NOT_RUN
ZCODE_3_18_2_CODE_COMPATIBILITY: PASS / SYNTHETIC
SOURCE_EQUIVALENCE: UNKNOWN
UPSTREAM_PENDING: PRESERVED
RUNTIME_AUTHORIZATION_ENV_FORWARDING: PASS

TYPE_CHECK: PASS
TARGETED_TESTS: 25/25 PASS
COST_LAB_TESTS: 86/86 PASS
TEST_AFFECTED: FULL_SUITE / 961 TESTS / 959 PASS / 0 FAIL / 2 SKIP
TEST_FULL: 961 TESTS / 959 PASS / 0 FAIL / 2 SKIP / FINAL DOCUMENTATION RE-RUN
GENERATED_ARTIFACTS: PASS
PLUGIN_VALIDATOR: PASS

REAL_MODEL_REQUESTS: 2
PRODUCTION_AUTH_ROUTING_CHANGED: NO
OFFICIAL_INSTALL_MODIFIED: NO
PREVIEW_MERGED: NO
RELEASE_PUBLISHED: NO

FINAL_VERDICT: PASS_WITH_EXPLICIT_EXPERIMENTAL_BOUNDARIES
```
