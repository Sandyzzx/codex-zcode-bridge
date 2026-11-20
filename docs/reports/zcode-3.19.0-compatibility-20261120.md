# ZCode 3.19.0 Unknown-Runtime Compatibility

> Status: RESEARCH
> Date: 2026-11-20
> Branch: `codex/zcode-3190-compat-20261120`
> Worktree: `D:\codex-zcode-bridge\.run\zcode-3190-compat-20261120`
> Baseline: `aedeb2c2a1ea6f41ea3ac2d045f7ed0d75281552` (`origin/preview`)
> Primary implementation commit: `aa755239645b355eb63288473567eb96de2bcd66`
> Final code commit: `15abe6becb13f383fee676a4ae20510d51f817fc`
> Final code tree: `654cda65168ece915251305522db6ce603e23ad7`

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
CODING_PLAN_REAL_MODEL_REQUEST:  PASS
CODING_PLAN_MULTIPLIER:          INCONCLUSIVE
START_PLAN_LIVE_COMPATIBILITY:   BLOCKED / NO_ACTIVE_PLAN
OTHER_PROVIDER_LIVE_PROBE:       NOT_RUN
```

这不是把 3.19.0 提升为生产已验证版本。它只证明一个精确安装指纹在显式授权后
可以用于有界的兼容性探测，且 Provider、折扣与 Start Plan 结论仍分别保持
未验证。

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

这证明最终实验态至少能启动官方 AppServer、完成协议初始化并正常释放进程；它
不证明 Session、Turn、模型、Provider 或计费。

## 6. Coding Plan 真实请求

在兼容性研究期间执行了 1 次真实 Coding Plan 请求：

| 字段 | 值 |
|---|---|
| Task | `costlab-cdc6b51b-8485-4782-b8bf-4bfafcd15dcc` |
| Attempt | 1 |
| Terminal | `completed` |
| Session | `sess_e58a88cc-175e-49d8-b478-f89c5d51b577` |
| Provider | `account:bigmodel-individual-coding-plan` |
| Model | `GLM-5.3-Flash` |
| Input | 18,247 |
| Cached Input | 0 |
| Output | 104 |
| Total | 18,351 |
| Result marker | `COSTLAB_PRODUCTION_VERIFICATION_OK` |

这是一个真实 Provider/模型执行样本，证明 3.19 实验态在该路径上可以完成一次
模型请求。

该请求发生时，Worker 尚未转发 `official_runtime_experimental` 标记，因此
证据中的 `runtime_evidence.status` 是 `UNVERIFIED`。该转发缺陷已在代码提交
`15abe6becb13f383fee676a4ae20510d51f817fc` 中修复，并由 runner 合成测试覆盖。
由于已有成功请求且没有新的归因价值，本轮没有仅为重复该标记而再次消耗真实
请求。

## 7. 官方账单与倍率

同一小时桶的 official Coding Plan 快照：

| 快照 | 15:00:00 Token | Cached | Uncached | Output | Credits |
|---|---:|---:|---:|---:|---:|
| Before | 0 | 0 | 0 | 0 | 0 |
| After probe | 0 | 0 | 0 | 0 | 0 |
| After settlement retry | 0 | 0 | 0 | 0 | 0 |

配额字段发生变化：

- unit 3：`0 -> 2 -> 2`
- unit 6：`4131 -> 4134 -> 4134`

但官方 Cookie/配额单位不等于 Credits，且小时 Token 行仍为零。因此：

```text
CODING_PLAN_MULTIPLIER: INCONCLUSIVE
0.67 PASS: NOT CLAIMED
```

不能把 `2 / expected` 或 `3 / expected` 当成额外优惠倍率。

## 8. Start Plan

只执行了官方只读 `billing/balance` GET：

```text
GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance
```

分别使用 `app_version=3.18.2` 与 `app_version=3.19.0`，两次均 HTTP 200，但：

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

## 9. 官方源码与 Host Patch

公开仓库 `zai-org/ZCode` 当前 `origin/main` 和 `v3.18.2` 均为：

```text
fec975905a2abd4c07e35c40d51fa097a2258ec9
```

未发现公开的 3.19.0 源码 Tag 或 Branch。因此 3.19 安装产物与公开源码的等价性
保持 `UNKNOWN`。三个既存 Official Host patch 没有被声明为 3.19 上游已合并，
状态继续为 `UPSTREAM_PENDING`。

## 10. 测试与生成物

最终验证结果：

| 检查 | 结果 |
|---|---|
| Typecheck | PASS |
| Targeted runtime/provider tests | 22/22 PASS |
| Cost Lab tests | 86/86 PASS |
| Build | PASS |
| Plugin Validator | PASS |
| Generated Artifacts | PASS，12 个文件均为最新 |
| Clean Entrypoints | 4/4 PASS |
| Affected selector | `FULL_SUITE` |
| `test:affected` full-suite run | 961 tests / 959 PASS / 0 FAIL / 2 SKIP |
| `test:full` | 961 tests / 959 PASS / 0 FAIL / 2 SKIP |
| `git diff --check` | PASS |
| Real zero-model protocol smoke | PASS |

`npm run test:affected` 因本次 Runtime、Worker、生成 Bundle 与测试基础设施
变更选择完整回归；随后按 Goal 顺序单独执行 `npm run test:full`，两次均为
959 PASS、0 FAIL、2 SKIP，另有 2 个显式 skip。

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
| 保留 3.18.2 Manifest 与失败边界 | 原有 3.18.2 记录不变；`LEGACY_SAFETY_ONLY` 与 `FULL` pinning 分类测试；全套合成回归 | PASS — SYNTHETIC |
| 未知版本安全检查 | 非 x64、无效/非官方签名、混合根、Node 不兼容、身份不完整均 hard block | PASS |
| 精确指纹授权 | 无授权 `UNVERIFIED`；匹配授权 `EXPERIMENTAL`；资产/Node/签名变化使授权失效 | PASS |
| Provider scope 独立 | Coding Plan、Start Plan、其他 Provider 各需对应 probe scope | PASS |
| 实验态不自动提升 | 授权与运行结果不写 Manifest；折扣保持 `NOT_VERIFIED`；Start Plan 保持 pending | PASS |
| 3.19.0 协议与真实 Coding Plan 执行 | 零模型协议 Smoke；1 次真实 Task completed；18,351 Token | PASS — EXPERIMENTAL |
| Coding Plan 倍率 | 官方小时桶未产生可归因 Token/Credits；quota unit 不是 Credits | `INCONCLUSIVE` |
| Start Plan 真实 E2E 与 Token 对账 | 官方 `billing/balance` 对 3.18.2/3.19.0 均返回空 `plans/balances`；未发模型请求 | `BLOCKED / NO_ACTIVE_PLAN` |
| 完整回归 | `test:affected` 与 `test:full` 均为 961/959 PASS、0 FAIL、2 SKIP | PASS |
| 不合并、不发布、不修改生产状态 | 独立分支；工作区 clean；无 Preview merge/Release；无 SQLite/凭据/安装修改 | PASS |

## 12. Known Gaps

- 公开官方仓库没有可确认的 ZCode 3.19.0 源码身份，因此不能生成逐文件
  3.18.2 -> 3.19.0 官方源码 Diff，也不能把 Desktop `BuildCommitId`
  `a7ed1054` 当成源码 commit。
- 当前机器只保留 3.19.0 安装，没有独立的 3.18.2.10443 可执行副本；本轮
  3.18.2 兼容性结论只来自原有精确 Manifest 和合成回归，不是新鲜实机 E2E。
- 唯一一次 3.19.0 Coding Plan 真实验证发生时，runner marker 转发修复尚未
  落地，因此该历史请求的运行证据为 `UNVERIFIED`；最终 marker 路径由合成
  测试覆盖，没有为了重复 marker 再发真实请求。
- 当前账户的 Start Plan Billing Reader 返回空套餐和空余额，无法建立 active
  entitlement，因此真实 Start Plan Session/Turn、免费 Token 用量和配额前后
  对账均为 `NOT_RUN`，不能声明兼容或倍率。
- 3.19.0 的 Other Provider 真实探测未运行，没有把通用 Runtime 启动成功当作
  其他 Provider 兼容证据。

## 13. Remaining Risks

- 3.19.0 安装 Bundle 与公开源码的等价性未知；未来官方更新可能改变未覆盖的
  Host、协议、认证或 Usage 行为。
- 3.19.0 Coding Plan 能执行一次模型请求，但官方小时桶未形成可归因账单项；
  不能据此判断 0.67、缓存计费、取整或高峰倍率是否保持一致。
- Start Plan 的静态兼容路径已由合成测试保护，但没有当前机器的 live
  Entitlement、设备绑定、Private Lease 和真实模型证据。
- 实验授权降低的是“未知版本无法启动”的可用性障碍，不是安全门禁；异常签名、
  资产漂移、错误 scope 和 malformed 授权仍然 fail closed。

## 14. 安全与资源

```text
REAL_MODEL_REQUESTS: 1
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
ZCODE_3_19_CODING_PLAN_MULTIPLIER: INCONCLUSIVE
ZCODE_3_19_START_PLAN: BLOCKED / NO_ACTIVE_PLAN
ZCODE_3_19_START_PLAN_TOKEN_RECONCILIATION: NOT_APPLICABLE_NO_ACTIVE_PLAN
ZCODE_3_19_OTHER_PROVIDERS: NOT_RUN

ZCODE_3_18_2_FRESH_REAL_E2E: NOT_RUN
ZCODE_3_18_2_CODE_COMPATIBILITY: PASS / SYNTHETIC
SOURCE_EQUIVALENCE: UNKNOWN
UPSTREAM_PENDING: PRESERVED

TYPE_CHECK: PASS
TARGETED_TESTS: 22/22 PASS
COST_LAB_TESTS: 86/86 PASS
TEST_AFFECTED: FULL_SUITE / 961 TESTS / 959 PASS / 0 FAIL / 2 SKIP
TEST_FULL: 961 TESTS / 959 PASS / 0 FAIL / 2 SKIP
GENERATED_ARTIFACTS: PASS
PLUGIN_VALIDATOR: PASS

REAL_MODEL_REQUESTS: 1
PRODUCTION_AUTH_ROUTING_CHANGED: NO
OFFICIAL_INSTALL_MODIFIED: NO
PREVIEW_MERGED: NO
RELEASE_PUBLISHED: NO

FINAL_VERDICT: PASS_WITH_EXPLICIT_EXPERIMENTAL_BOUNDARIES
```
