# 官方 ZCode Runtime、Cost Lab Web 与 Start Plan 兼容性验收

> Status: RESEARCH（一次性交付与验收记录，不替代当前合同）
> Date: 2026-11-18
> Branch: `codex/official-runtime-integration-20261118`
> Baseline: `02cf2fa92c8235370fe7a883d4c5b30d93a8ab33` (`origin/preview`)
> Worktree: `.run/official-runtime-integration-20261118`

## 1. 交付结论

本轮同时完成：

1. Windows x64 生产 Coding Plan 改为优先使用已安装、精确校验的官方 ZCode
   AppServer。
2. 通过构建后的 Bridge MCP、Manager、SQLite Worker、Official Host 认证链与
   安装版 AppServer，完成一次真实 `GLM-5.3-Flash` Coding Plan E2E。
3. 官方同小时账单差分与本地 Usage 完全匹配，实际扣分为 `1.7666`，有效额外
   倍率为 `0.6699901963`，成功复现约 `0.67` 优惠。
4. 完成 Start Plan 与同一 AppServer 的离线兼容性审计；没有发起真实 Start Plan
   模型、认证、Billing 或权益请求。
5. 完成可实际使用的 Cost Lab 本地 Web/API、官方账单读取、历史、脱敏导出和
   零模型环境检查。
6. 将 V5 研究转为正式脱敏证据，并更新中英文 README、插件 README 和 ADR。

## 2. 官方 Runtime Resolver

新增 `OfficialAppServerRuntimeResolver`。它从现有安装发现和持久化 Bridge
设置出发，不接受测试 Harness 固定路径，并分别验证：

- Desktop 产品版本；
- `resources/glm/zcode.cjs` 的文件大小与 SHA-256；
- 同一安装根下的 builtin Provider 配置；
- `resources/tools/runtime-host/zcode-runtime-host.exe`；
- Node 主次版本范围；
- Windows x64 平台。

首个兼容 Manifest：

```yaml
desktop_version: 3.18.2.10443
bundle_bytes: 15675386
bundle_sha256: 08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c
builtin_provider_config_bytes: 261659
builtin_provider_config_sha256: ef3d64656cb5281cce292b77ef12e96b5251582cfb00cdf9eb08e3d4565abb69
runtime_host_bytes: 179608
runtime_host_sha256: c2c8ff5ff28cbddc4f177c094aa67c322830889612251bd173baaabc89379ab4
node_compatibility: ">=24.16.0 <25"
appserver_protocol: zcode-app-server-stdio-desktop-v1
request_security_capability: official-installed-bundle-signing
coding_plan_discount_verified: true
```

版本、大小、摘要、同根关系、平台或 Node 任一不匹配时返回
`OFFICIAL_RUNTIME_UNVERIFIED` 与 `OFFICIAL_DISCOUNT_NOT_VERIFIED`。未知安装不会
构造模型进程，也不会继承 `0.67` 声明。

## 3. Worker 集成

Windows x64 生产 Worker 仅在任务 Provider 为
`account:bigmodel-individual-coding-plan` 时选择
`OfficialAppServerWorkerAdapter`。其他 Provider 的既有选择规则不变。

官方 Adapter 保持现有：

- MCP/Manager/Worker/Task Admission/SQLite Authority；
- Official Host 认证、Provider Runtime Auth 和 Process Manager；
- Session、Subscribe、Send、Runtime Headers、Turn、Cancel、Timeout；
- Identity-bound Windows 清理、Result、Recovery 与 Release。

模型进程使用参数化启动：

```text
node <installed-zcode>/resources/glm/zcode.cjs
  app-server --stdio --surface desktop
```

本轮还修复了两个生产装配问题：

1. `scripts/build-core.mjs` 将已打包的 Official Host 资产复制到构建后的
   `dist/src/adapters/vendor/official-host`，使构建 MCP 入口能找到 Host Module。
2. `src/runtime/account-provider.ts` 从显式继承的 personal
   `provider_config.json` 所在 `v2` 目录读取官方凭据与 Coding Plan cache，
   避免隔离 `HOME` 把账户来源指向错误目录。

没有修改认证材料的签发、登录状态、设备身份、官方安装目录或签名实现。

## 4. 生产 Coding Plan E2E

### 4.1 运行条件

```yaml
provider: account:bigmodel-individual-coding-plan
model: GLM-5.3-Flash
reasoning: low
plan: PERSONAL_CODING_PLAN
execution: BUILT_BRIDGE_MCP_TO_WORKER
runtime: INSTALLED_OFFICIAL_APPSERVER
runtime_status: OFFICIAL_RUNTIME_VERIFIED
bundle_sha256: 08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c
provider_sync: 10 providers / 1 entitled
model_requests: 1
task_status: SUCCEEDED
```

生产事件记录显示 Provider Update、Session Create、模型目录与选择、Subscribe、
Send 和 Turn Completion 均完成。最终 Usage 来自 Provider/Turn，不是由 Token
文本或截图估算。

### 4.2 请求 Usage

| 分类 | Token |
|---|---:|
| Cached Input | 0 |
| Uncached Input | 22,657 |
| Output | 78 |
| Total | 22,735 |
| Reasoning | 0 |

### 4.3 官方账单差分

模型完成时的首次 after snapshot 仍显示 `02:00` 小时桶无增量
（`NO_OBSERVED_CREDIT_DELTA`）。后续在同一小时取得 fresh snapshot 后，官方
增量出现，且四类 Token 与本地 Usage 完全一致：

```yaml
before: 2026-11-18T02:08:52.300+08:00
first_after: 2026-11-18T02:09:45.171+08:00
settled_after: 2026-11-18T02:10:55.254+08:00
time_zone: Asia/Shanghai
bucket: "02:00:00"
```

```text
BASE_CREDITS =
  (22657 * 2.3 + 0 * 0.56 + 78 * 8) / 10000
  = 5.27351

EXPECTED_NORMAL = 5.27351 * 0.5
                  = 2.636755

EXPECTED_WITH_0_67 = 2.636755 * 0.67
                     = 1.76662585

ACTUAL = 1.7666
EFFECTIVE_EXTRA_RATIO = 1.7666 / 2.636755
                      = 0.6699901963
```

| 项目 | 结果 |
|---|---:|
| Official Cached Input | 0 |
| Official Uncached Input | 22,657 |
| Official Output | 78 |
| Official Total | 22,735 |
| Official Credits | 1.7666 |
| Expected Normal | 2.636755 |
| Expected with `0.67` | 1.76662585 |
| Effective Extra Ratio | 0.6699901963 |
| Token Reconciliation | `PASS` |
| Discount | `PASS` |

补充快照没有伴随模型请求。官方小时聚合精度为 `0.0001` 积分；实际值与
`0.67` 理论值的差为 `0.00002585`，在官方展示精度内。该小时没有其他已知
同账户、同模型活动，四类 Token 与唯一本地请求同时精确匹配。

### 4.4 请求预算与失败尝试

成功前共有 16 个验证会话未产生模型请求，均记录 `model_requests: 0`：

- 11 个会话以 `FAILED` 收束，涉及构建后 Host 资产路径、Bridge connect/shutdown、
  Provider config 和 Events 读取等 Harness 装配问题；
- 5 个会话在实验进程被终止时保留为 `MODEL_REQUESTED`，没有请求 Usage，也没有
  观察到对应 Token 或积分增量；它们不是未计数的成功模型调用。

排除这些工程问题后，只发出一次真实模型请求。没有自动重派、没有重试认证错误、
没有调用 Start Plan、没有修改其他运行中的 Bridge 任务。

## 5. Start Plan 离线兼容性

安装版 ZCode 的同一 AppServer 制品包含 Start Plan 与 Coding Plan Provider，
但两条套餐路径并不等价：

| 能力 | Coding Plan | Start Plan |
|---|---|---|
| Provider | BigModel Individual Coding Plan | BigModel Start Plan |
| Gateway | BigModel Ultra Anthropic | `zcode-plan/anthropic` |
| Client Signing | 适用 | 不适用 |
| Signing Handshake | 官方真实请求验证 | `NOT_APPLICABLE` |
| Runtime Auth | Official Host Provider Auth | Bridge Private Lease |
| Runtime Headers | 同一 AppServer RPC | 同一 AppServer RPC，凭据来源不同 |
| 真实 E2E | 本轮 `PASS` | `NOT_RUN_BY_OWNER_CONSTRAINT` |
| 积分优惠 | 本轮约 `0.67` `PASS` | `NOT_VERIFIED` |

离线验证覆盖 Provider Registry 隔离、任务级 entitlement、精确
Session/Turn/Model Runtime Header 绑定、`3007`/`3012`/`401`/`403`
fail-closed 分类，以及绝不回退 Coding Plan 身份。

```yaml
START_PLAN_SOURCE_AUDIT: COMPLETE
START_PLAN_APPSERVER_COMPATIBILITY: OFFLINE_VERIFIED
START_PLAN_AUTH_PATH: DOCUMENTED
START_PLAN_REQUEST_SECURITY: DOCUMENTED
START_PLAN_RUNTIME_HEADERS_PROTOCOL: COMPATIBLE
START_PLAN_SIGNING_HANDSHAKE: NOT_APPLICABLE
START_PLAN_LIVE_E2E: NOT_RUN_BY_OWNER_CONSTRAINT
START_PLAN_DISCOUNT: NOT_VERIFIED
```

## 6. Cost Lab Web

新增 `npm run cost-lab:web`，服务只绑定 `127.0.0.1` 并自动选择端口。页面提供：

- Dashboard：安装、Bundle、Node、Runtime、Provider、Model、Plan 与最近实验；
- Environment：本机检查、摘要校验和显式零模型 AppServer protocol smoke；
- Coding Plan：显式确认后启动固定 Provider/Model/Reasoning 的生产验证；
- Billing Analysis：官方 Token 分类、积分、正常预期、优惠预期、有效倍率和
  settlement 状态；
- History：实验状态、请求数、Usage、积分、结果和脱敏导出；
- Start Plan：只展示离线研究状态，不提供真实执行入口。

安全边界：

- 只允许 loopback；
- 固定 API 白名单，无任意命令、路径、URL 或 Shell；
- state-changing API 校验 Origin、CSRF 与 same-site；
- 页面加载不请求模型，也不自动读取官方账单；
- 真实验证必须由用户主动确认；
- 浏览器不保存 API Key、JWT、OAuth、Project Token 或 Authorization Header；
- 输出和历史导出脱敏。

官方账单可能在短延迟后才结算。after-snapshot 现在在同一小时桶内有界重试约
`2.5` 分钟；看到 Token 增量即停止。超时仍无增量时返回 `INCONCLUSIVE`，绝不
把缺失账单记为 0 积分或免费请求。

桌面与移动布局已通过本地截图检查；页面没有在加载时触发模型调用。

## 7. 正式证据与文档

- `docs/evidence/coding-plan-official-discount-verification-20261118.md`
  固化 Native 对照、V5 Bridge 实验与生产 Worker E2E。
- `docs/decisions/ADR-040-installed-official-appserver-runtime.md`
  记录安装版 Runtime、Manifest 门禁、显式 fallback 和生命周期边界。
- `docs/research/start-plan-official-appserver-compatibility-20261118.md`
  记录 Start Plan 的离线认证、Signing、Gateway 和 Runtime Headers 差异。
- `tools/cost-lab/README.md` 记录 Web 使用、计费语义、API 与安全边界。
- 根 README、中文 README 和插件 README 明确区分 Coding Plan 已验证优惠、
  Start Plan 离线兼容及 Cost Lab 用法。

原始账单、完整实验输出和 History 只保存在 ignored `.run/`。提交内容不包含
账户 ID、Organization/Project ID、API Key ID、凭据、JWT、完整请求头或
未脱敏原始账单。

## 8. 验证结果

| 检查 | 结果 |
|---|---|
| `npm run cost-lab:test` | PASS；43/43 |
| 定向 Runtime/Adapter/Worker/Start Plan 测试 | PASS；64/64 |
| `npm run typecheck` | PASS |
| `npm run build` | PASS；core、Bridge、Worker、plugin 重建完成 |
| `npm run validate:plugin` | PASS |
| `git diff --check` | PASS |
| `npm run test:affected` | 在提交前 `check:generated` 处按预期停止：修改过的生成物尚未 commit，测试阶段未继续 |
| `FULL_CI` | `DEFERRED` by Owner |
| 真实 Start Plan | `NOT_RUN` |

`test:affected` 的生成物门禁会在提交后重新执行 `npm run check:generated`；
不能把提交前停止写成测试 PASS。完整回归、Windows/Ubuntu matrix、压力测试和
发布门禁按本 Goal 的 Owner 决策暂缓。

## 9. 资源清理与并行隔离

- 生产 E2E 的 task 进入 `SUCCEEDED`，无已知 residual model process。
- 定向测试完成后按 worktree 命令行范围检查，没有残留属于本 Worktree 的
  AppServer/Worker 进程。
- 没有停止或修改 Host Wake、Start Plan、主线 Bridge、其他 Agent Worktree、
  共享 SQLite Authority、Magpie 或官方安装目录。
- 所有持久化实验产物位于本 Worktree 的 ignored `.run/`。

## 10. 限制与剩余不确定

1. 优惠结论只覆盖 Windows x64、个人 Coding Plan、`GLM-5.3-Flash`、
   reasoning low 和实验时有效活动。
2. 没有证明所有模型、账户、套餐、地区或时段都享有相同倍率。
3. Signing edition 与优惠恢复存在强关联，但没有通过“仅禁用签名”的负向控制
   证明其为唯一必要因果因素；根因置信度仍为 `SUPPORTED`。
4. 官方账单按小时聚合。本轮以四类 Token 精确匹配、唯一合法请求和同小时
   before/after 差分建立归因；无法区分并行污染时仍必须返回 `INCONCLUSIVE`。
5. Start Plan 当前没有真实额度验证，CAPTCHA、Private Lease + 安装版 AppServer
   组合和任何 Start Plan 权益均未知。
6. 完整 CI 与发布门禁尚未执行，本分支不自动合并或发布。

## 11. 最终状态

```yaml
GOAL: BRIDGE_OFFICIAL_RUNTIME_INTEGRATION_COSTLAB_WEB_AND_STARTPLAN_COMPATIBILITY

PRODUCTION_RUNTIME_INTEGRATION: PASS
PRODUCTION_CODING_PLAN_E2E: PASS
OFFICIAL_DISCOUNT_REPRODUCED: PASS
EFFECTIVE_EXTRA_RATIO: 0.6699901963

START_PLAN_OFFLINE_AUDIT: COMPLETE
START_PLAN_RUNTIME_COMPATIBILITY: OFFLINE_VERIFIED
START_PLAN_LIVE_E2E: NOT_RUN
START_PLAN_DISCOUNT: NOT_VERIFIED

COST_LAB_WEB: PASS
BILLING_READER: PASS
EVIDENCE_EXPORT: PASS

README_OFFICIAL_DISCOUNT: PASS
README_START_PLAN: PASS
README_COST_LAB: PASS

TARGETED_TESTS: PASS
TYPECHECK: PASS
BUILD: PASS
PLUGIN_VALIDATION: PASS
FULL_CI: DEFERRED

PRODUCTION_CODE_CHANGED: YES
PRODUCTION_DEPLOYMENT: NO
RESOURCE_CLEANUP: PASS

COMMIT: reported in delivery envelope
TREE: reported in delivery envelope
REMOTE: reported in delivery envelope
```
