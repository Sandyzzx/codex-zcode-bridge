# G6：上游升级、SQLite 升级与回滚

> Status: RESEARCH — SQLITE UPGRADE PASS / FIXED HOST DEPLOYMENT SAFETY PASS / NEXT-VERSION TRANSITION DEFERRED
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对固定制品选择、runtime generation fence、direct rollback smoke 与 SQLite 完整回归
> Verified against: Bridge candidate `ba25f837`；upstream `b95ebaff` / ZCode 3.18.0

## 三个不同对象

1. **Official Host 制品版本**：当前只冻结 ZCode 3.18.0 / AppServer 0.17.1 / Node 24.16.0，不提供多版本自动选择。
2. **Bridge SQLite Authority schema**：Preview.4 Lifecycle startup 可从 v13 自动升级到 v14。
3. **Adapter 回滚**：test-only direct-AppServer seam 保留行为验证；Windows x64 生产选择始终是 `official_host`。

SQLite 升级通过不能证明 Official Host 可以升级；反过来，同一固定制品的部署验证也不能替代 schema 迁移测试。

## 当前生效的制品切换边界

- Worker bundle 从自身位置解析精确 scope 目录：`win32-x64-node24.16.0-zcode3.18.0-b95ebaff`。
- AppServer、provider、Host module 和 helper 的路径由固定 bundle 与 BOM 决定。
- 任务输入、环境变量和持久配置不能重定向 Host module 或 AppServer 入口。
- 每个 Adapter 在第一次执行前验证完整 assets manifest。
- 官方 runtime close 或 generation change 会终止活跃 Attempt，不允许同一 Turn 静默切到新 runtime。
- 升级意味着安装并启动包含新 scope 的新 Worker bundle；旧 Worker 继续使用已加载的旧 scope，直到完成、失败或按现有 Recovery 处理。
- 回滚意味着停用新 bundle 并在下一次 Worker 启动时使用旧 bundle；已有 SQLite Fact 不回退，也不需要切换 Task Authority。

上述边界由 `official-host-adapter.test.ts` 的 fixed asset、generation fence、asset tamper 和 production selector 测试覆盖。

## 合成回滚证据

- test-only direct-AppServer smoke：1/1 PASS，证明旧执行路径可在隔离测试中构造。
- 该 seam 不进入持久 Adapter Mode、公共 TaskPackage、环境变量或 Worker 生产选择。
- 固定 Host 制品仍是 Windows x64 默认路径；回滚 smoke 只证明兼容接口，不表示生产二进制回滚演练已完成。

## SQLite 自动升级

生产 Lifecycle 在既有 v13 文件或 pending marker 时，于 bootstrap lock 内调用 `autoUpgradeV13`：

- stage copy，不原地修改源库；
- 构造并验证 v14；
- pending marker；
- tokenized v13 backup；
- 原子 publication；
- 重读 v14；
- marker cleanup；
- rename/publication 中断后幂等恢复；
- occupied running Attempt、Recovery Hold、events 与 digest 保持不变。

blocked root、未知源、目标不合法或活跃 writer 保持 fail closed，不删除 Hold。

## 必须保持的限制

- 当前没有第二个已批准 upstream 版本，因此不能伪造“从 3.18.0 升级到下一版本”的兼容结果。
- 没有在安装级 plugin migration 中 drain 活跃 Worker；发布流程必须把旧 Worker 完成或按 Recovery 处理作为前置条件。
- SQLite v14 写入后不能直接用 v13 backup 覆盖生产路径而不丢失新任务；数据回滚仍需独立批准。
- 没有执行生产 SQLite migration。

## 结论

```text
SQLITE_V13_TO_V14_STARTUP_UPGRADE: PASS_TEST_SCOPE
SQLITE_INTERRUPTED_MIGRATION_RECOVERY: PASS_TEST_SCOPE
FIXED_HOST_EXACT_PATH_AND_MANIFEST: PASS
ACTIVE_ATTEMPT_SILENT_RUNTIME_SWITCH: PREVENTED_BY_CLOSE_OR_GENERATION_FENCE
DIRECT_APP_SERVER_ROLLBACK_SEAM: PASS_TEST_ONLY
NEXT_UPSTREAM_VERSION_UPGRADE: DEFERRED_NOT_RUN
PRODUCTION_DATA_MIGRATION: NOT_RUN
```
