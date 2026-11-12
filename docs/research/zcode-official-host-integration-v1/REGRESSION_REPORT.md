# 回归与证据报告

> Status: RESEARCH — FULL ISOLATED REGRESSION PASS
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对 `.run/final-evidence-20261112` 的当前日志
> Verified against: Bridge candidate `8e8966d5`（tree `4e9b0a00`）+ final candidate worktree changes

## 当前结果

| 运行 | 结果 | 证据 |
|---|---:|---|
| 最终 `npm run test:affected -- --base origin/preview` | 935 pass / 0 fail / 1 skip（936 项） | `test-affected-final-candidate-20261112.log`；`FULL_REGRESSION_PASS` |
| 较早 `npm run test:full` | 934 pass / 0 fail / 1 skip（935 项） | `test-full-after-origin-sync-20261112.log`；早于最终 native/Host closure 测试 |
| SQLite stress | 3/3 pass | `test-stress-after-origin-sync-20261112.log` |
| Adapter/Worker 当前定向集合 | 32/32 pass | `official-host-adapter-current-20261112.log` |
| 路由、SQLite 与影响选择定向集合 | 64/64 pass | `focused-contract-rerun-20261112.log` |
| SQLite real-adapter 重跑 | 47/47 pass | `mvp-real-adapter-suite-rerun.log` |
| upstream frame | 7/7 pass | `upstream-frame-after-origin-sync-20261112.log` |
| upstream account | 12/12 pass | `upstream-account-after-origin-sync-20261112.log` |
| typecheck / build / build:test / validate:plugin | PASS | `typecheck-after-origin-sync.log` 等 |
| 固定制品同源双建 | byte-identical | `official-host-repeatability-current.json` |

唯一 skip 为现有平台条件跳过项；没有 fail、cancel 或 todo。完整回归执行的是隔离测试入口，没有真实账户、真实 Provider 或生产 SQLite。

## 失败历史

初版 `mvp-real-adapter-suite.log` 启动 47 项，40 通过、7 失败。失败来自当时测试构造无法注入 direct-adapter 回滚 seam；生产默认官方路径与测试回滚构造不匹配。

加入 test-only seam 后，`mvp-real-adapter-suite-rerun.log` 为 47/47。初版失败日志继续保留，不能被成功重跑覆盖或改写。

后续文档整理期间的 `test-affected-current-20261112.log` 也保留 3 个失败，用于证明在完成路由幂等与 Start Plan preflight 修复前，完整套件尚未通过。修复后较早完整套件达到 935/934/0/1；加入 native/Host closure 测试后的最终套件为 936/935/0/1。

## 固定制品验证

- Host module：1,821,168 bytes，`3F481AAE16EFF9912DAF17178B49491BD64E67C4419BFFDB59EB4B78E85EB537`。
- BOM：7,260 bytes，`B9A7104DAB3B10250CA93899324C0B33966E64C0BE02F279A1353BABBA8F129C`。
- patch aggregate diff：`39D980C47C553B39D91F73748B63B794FAB18360B008728233B4C5BA70D7495F`。
- `validate:plugin` 校验 13 个 BOM 文件、三份有序 patch、Host module、AppServer、provider、helper 与六个 keyring 文件。
- Windows x64 / Node 24.16.0 clean checkout 动态加载 `ZCodeAgentProcessManager`、`ZCodeProtocolClient`、`ZCodeStdioTransport`、`createOAuthProviderRuntimeAuthService` 和 keyring native binding。

首次 clean checkout 校验发现了 Git 索引中四个官方文本制品的 byte identity 与 BOM 不一致：provider JSON、third-party notices、LICENSE 和 NOTICE 在提交中为 LF，而 BOM 记录了 Windows checkout 的混合/CRLF 字节。修复方式是使用已存在的 `-text` 保护，将四个原始文件按精确字节重新加入候选，再创建全新 checkout 复验；该历史失败保留在证据日志中。

## 范围边界

- 完整回归是工程与合成回归，不是真实 OAuth、模型、Start Plan 或 Billing E2E。
- Windows x64 是当前 Official Host 固定制品支持面；其他平台继续走既有 direct AppServer 或按平台矩阵拒绝。
- 跨上游版本的 canary 与回滚不在固定 3.18.0 制品内部伪造；生产切换必须在 Worker drain 后通过包装版本完成，活跃 Attempt 不受原地目录替换影响。
- 没有运行生产数据迁移、长时间 soak 或产品性能结论。

## 结论

```text
TARGETED_TESTS: PASS
INTEGRATION_TESTS: PASS
WINDOWS_LIFECYCLE: PASS
STRESS_TESTS: PASS
FULL_REGRESSION: PASS
REAL_SERVICE_E2E: NOT_RUN
PRODUCTION_DATA_MIGRATION: NOT_RUN
```
