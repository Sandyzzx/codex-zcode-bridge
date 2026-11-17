# Coding Plan 官方积分优惠验证

> Status: EVIDENCE
> Last updated: 2026-11-18
> Evidence branch: `codex/cost-lab-discount-autonomous-research-20261117`
> Evidence commit: `8da4e61a79137dece48300ef6664ccc1ea4836db`
> Scope: Windows x64、个人 Coding Plan、`GLM-5.3-Flash`、reasoning `low`

本文把 V5 研究分支中的真实模型与官方账单证据整理为正式项目资产。
原始、未脱敏实验数据保留在 ignored `.run/`，不进入 Git。成本计算只使用
官方小时桶差分；无法取得的辅助请求 Usage 保持缺失，不按零处理。

## 1. 验证目标

回答三个不同问题：

1. 当前个人 Coding Plan 对 `GLM-5.3-Flash` 是否仍在官方账单中产生额外
   `0.67` 积分倍率？
2. 原生 ZCode 是否仍取得该倍率？
3. 使用安装版官方 ZCode AppServer 的 Bridge 实验路径能否复现同一倍率？

“请求成功”“Token 对上”“使用官方认证”都不能替代第 1 项的官方积分结论。

## 2. 计费公式

```text
BASE_CREDITS =
  (uncached_input * 2.3
   + cached_input * 0.56
   + output * 8) / 10000

EXPECTED_NORMAL =
  BASE_CREDITS * time_multiplier

EXPECTED_WITH_0_67 =
  EXPECTED_NORMAL * 0.67

EFFECTIVE_EXTRA_RATIO =
  ACTUAL_CREDITS / EXPECTED_NORMAL
```

工作日 `14:00-17:59`（`Asia/Shanghai`）按高峰 `2.0` 时段倍率；
实验窗口均为非高峰 `0.5`。时段倍率与活动额外 `0.67` 是两个独立因素。

## 3. Native 控制组

运行标识：`native-v5-20261117-02`。

原生 ZCode Desktop 完成 `COSTLAB_NATIVE_V5_OK`，自然发出主 Turn、
`session_title` 和 `project_memory_extract` 三个模型 HTTP attempt。
`project_memory_extract` 的请求级 Usage 未暴露，因此请求级 Usage 完整性为
`PARTIAL / USAGE_MISSING`；任务级积分仍可按独立小时桶归因。

| 字段 | 值 |
|---|---:|
| 官方 Token 增量 | 59,485 |
| Cached Input | 320 |
| Uncached Input | 59,115 |
| Output | 50 |
| 官方实际积分 | 4.5743 |
| 非高峰 `0.5` 后正常积分 | 6.827185 |
| 有效额外倍率 | 0.6700126040 |
| 结论 | `PASS` |

该窗口无其他模型活动，Task 级官方积分符合 `0.5 × 0.67`，不能从缺失的
辅助请求 Usage 推导单请求精确扣分。

## 4. Bridge 官方 AppServer 真实验证

### 4.1 运行身份

```text
ZCode Desktop: 3.18.2.10443
Node: 24.16.0
Installed AppServer: resources/glm/zcode.cjs
AppServer bytes: 15675386
AppServer SHA-256:
  08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c
Provider: account:bigmodel-individual-coding-plan
Model: GLM-5.3-Flash
Reasoning: low
```

AppServer 使用参数化启动：

```text
node <installed-zcode>/resources/glm/zcode.cjs
  app-server --stdio --surface desktop
```

实验中始终复用现有官方认证服务；没有复制 Credential、JWT、OAuth、
Project Token 或 signing 算法，也没有修改安装目录。

### 4.2 三次独立真实计费实验

每次实验使用 fresh before/after 官方账单快照、隔离 Workspace、独立小时桶、
完整 Token 分类差分以及本地 API-key / Organization / Project identity parity。

| 运行 | Project context | Device context | 官方 Token | Actual Credits | Expected Normal | Effective Extra Ratio |
|---|---|---|---:|---:|---:|---:|
| `v5-installed-bundle-node-billing-20261118` | official read-only | official reused | 22,650 | 1.7574 | 2.622990 | 0.6699987419 |
| `v5-installed-bundle-node-repro-20261118` | official read-only | official reused | 22,657 | 1.7469 | 2.607376 | 0.6699839225 |
| `v5-installed-bundle-node-isolated-context-20261118` | in-memory | fixture generated | 22,658 | 1.7397 | 2.596508 | 0.6700152667 |

第三次是最小化成功配置：不需要 Project Location Cache，也不需要复用
官方 Device MID。`session_title` 辅助请求可能被关闭阶段取消，其 Usage
保持缺失；官方 Token 分类与任务级积分差分仍完整。

### 4.3 最小化运行账单明细

来源：
`.run/v5-installed-bundle-node-isolated-context-20261118/analysis.json`

| 字段 | 值 |
|---|---:|
| Cached Input | 256 |
| Uncached Input | 22,356 |
| Output | 46 |
| Total | 22,658 |
| Base Credits | 5.193016 |
| Time Multiplier | 0.5 |
| Expected without extra discount | 2.596508 |
| Expected with `0.67` | 1.73966036 |
| Actual Credits | 1.7397 |
| Effective Extra Ratio | 0.6700152667 |
| Token Reconciliation | `PASS` |
| Discount | `PASS` |

### 4.4 生产集成 Worker E2E

2026-11-18 又通过构建后的 Bridge MCP、Manager、SQLite Worker 与安装版官方
AppServer 执行了一次 production Coding Plan E2E。该实验与 V5 Harness 分开，
目标是证明生产执行入口确实选择官方 Runtime，而不是测试 Harness 或 vendored
Bundle。

| 字段 | 值 |
|---|---:|
| Cached Input | 0 |
| Uncached Input | 22,657 |
| Output | 78 |
| Total | 22,735 |
| Base Credits | 5.273510 |
| Time Multiplier | 0.5 |
| Expected without extra discount | 2.636755 |
| Expected with `0.67` | 1.76662585 |
| Actual Credits | 1.7666 |
| Effective Extra Ratio | 0.6699901963 |
| Token Reconciliation | `PASS` |
| Discount | `PASS` |

首个 after snapshot 在模型完成约 24 秒后仍未观察到该小时桶增量，因此当时的
记录为 `INCONCLUSIVE / NO_OBSERVED_CREDIT_DELTA`。后续在同一 `02:00`
（Asia/Shanghai）小时桶取得 fresh snapshot 后，Token 分类与积分增量同时出现，
差值精确匹配本地 Usage。整个补充过程没有发起第二次模型请求。这个案例说明
官方账单存在可观察的延迟结算，不能把“短时间未看到积分”误判为免费请求。

## 5. Official Request Security 证据

安装版 AppServer 的网络序列为：

```text
GET  https://zcode.z.ai/api/v1/agent/configs
POST https://open.bigmodel.cn/api/paas/c1f3a7e2/v2/client
POST https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages
```

第二个请求由安装版 AppServer 的官方 `get_sign_key` signing handshake 发起，
HTTP `200`。证据只保留字段形状与非秘密指纹：signing body 包含
`accessToken`、`nonce`、`sig`、`ts`，实际秘密值不进入报告或 Git。

安装版 Bundle 中：

```text
createModelRequestSecurityState
  -> OfficialRequestSecurity
  -> Coding Plan client signing
  -> official signing fetch
  -> Ultra Anthropic Gateway
```

此前使用不带该 signing edition 的 vendored Bundle 的控制实验约为 `1.0`，
没有 signing handshake。因此 signing edition 与 `0.67` 恢复存在强关联。
尚未通过“仅关闭签名”的负向控制证明其唯一因果必要性；根因置信度为
`SUPPORTED`，不是绝对证明。

## 6. 最小成功配置

```yaml
app_server: INSTALLED_OFFICIAL_ZCODE_APPSERVER
app_server_execution: PARAMETERIZED_NODE_STDIO
provider: account:bigmodel-individual-coding-plan
model: GLM-5.3-Flash
reasoning: low
auth: EXISTING_OFFICIAL_HOST_AUTH_SERVICE
project_location: IN_MEMORY
device_identity: FIXTURE_GENERATED
request_security: INSTALLED_OFFICIAL_BUNDLE
signing_implementation: REUSED_OFFICIAL_BUNDLE
```

不需要单独复用 Project Location Cache、Device MID 或独立 Account Resolver。

## 7. 适用条件

- Windows x64。
- Node `>=24.16.0 <25`。
- 与兼容 Manifest 完全匹配的安装版官方 ZCode AppServer。
- 官方账户有效、Provider/Model 可用且存在可用套餐额度。
- 官方活动仍对该账户/模型有效。
- fresh before/after 账单窗口可唯一归因。

## 8. 尚未证明

- 没有证明所有 ZCode 版本、所有 Desktop 版本或其他平台均支持。
- 没有证明所有 Coding Plan 模型、所有账户类型或所有时段均取得 `0.67`。
- 没有把 `0.67` 推广到 Start Plan。
- 没有用负向控制单独隔离 signing，根因仍是 `SUPPORTED`。
- 辅助请求的逐请求 Usage 可能缺失；只能使用官方聚合差分进行 Task 级对账。
- 官方活动与计费规则未来变化后，旧倍率不能自动沿用。

## 9. 原始证据位置

- `.run/native-v5/native-v5-20261117-02`
- `.run/v5-installed-bundle-node-billing-20261118`
- `.run/v5-installed-bundle-node-repro-20261118`
- `.run/v5-installed-bundle-node-isolated-context-20261118`
- V5 研究报告：
  `docs/reports/cost-lab-discount-autonomous-research-20261117.md`

这些路径可能只存在于执行实验的本机，且必须保持 ignored，不作为 Git 证据。
