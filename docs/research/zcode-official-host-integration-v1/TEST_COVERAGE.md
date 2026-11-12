# G6：测试覆盖与证据矩阵

> Status: RESEARCH — CURRENT DIRECTED, INTEGRATION AND FULL REGRESSION PASS
> Last updated: 2026-11-12
> Last verified: 2026-11-12，从 `.run/final-evidence-20261112` 逐项核对
> Verified against: Bridge candidate `8e8966d5` + final documentation/artifact completion

## 范围

证据环境为 Windows x64、Node 24.16.0；固定上游为 ZCode 3.18.0 / AppServer 0.17.1。所有 Provider 与账户路径使用本地 loopback 或合成凭据。真实账户、真实模型、Start Plan 与 Billing 请求均为 0。

## 当前证据

| 范围 | 结果 | 证据 | 主要覆盖 |
|---|---:|---|---|
| Adapter/Worker 当前定向集合 | 32/32 `PASS` | `official-host-adapter-current-20261112.log` | session、subscribe/send、resume、terminal、cancel、reverse RPC、asset gate、frame |
| 路由、SQLite 与影响选择定向集合 | 64/64 `PASS` | `focused-contract-rerun-20261112.log` | Start Plan、路由、SQLite、Worker、影响选择 |
| SQLite real-adapter suite | 47/47 `PASS` | `mvp-real-adapter-suite-rerun.log` | Worker pipes、private auth、cancel、crash、large Result、deadline、routing |
| upstream frame | 7/7 `PASS` | `upstream-frame-after-origin-sync-20261112.log` | exact 16 MiB、+1、partial、UTF-8、CR/LF、EOF、pending RPC |
| upstream account | 12/12 `PASS` | `upstream-account-after-origin-sync-20261112.log` | lock、reread、single network refresh、CAS、timeout、crash、revision/header |
| 最终完整隔离回归（affected） | 935 pass / 0 fail / 1 skip（936） | `test-affected-final-candidate-20261112.log` | 整个自动影响范围；`FULL_REGRESSION_PASS` |
| 较早完整隔离回归（full） | 934 pass / 0 fail / 1 skip（935） | `test-full-after-origin-sync-20261112.log` | 早于最终 native/Host closure 测试 |
| SQLite stress | 3/3 `PASS` | `test-stress-after-origin-sync-20261112.log` | history growth、CAS、admission |
| 固定制品同源双建 | byte-identical | `official-host-repeatability-current.json` | 1,821,168-byte Host module 与 BOM/provenance metadata |
| clean checkout | `PENDING_FINAL_COMMIT` | final clean-checkout logs | 必须从本次提交后的全新 checkout 执行 `npm ci`、typecheck、build、plugin validation、Host export import、keyring native load |

## 合同覆盖

### 启动、RPC 与恢复

- 官方 Adapter 在 subscribe 之前不重复 send。
- resume 要求 exact session id；未知 terminal、foreign/duplicate terminal 和 generation change fail closed。
- cancel/timeout close once，不重发 session/send。
- 官方 close result 与独立 recorded-tree verdict 分开保留。
- recorded tree clean、live、incomplete 与 close failure 分别验证。
- 固定 helper、entrypoint、provider 和 shipped tree verification fail closed。

### 账户与凭据

- Start Plan private auth 只注入匹配 turn；Coding Plan 不经过 Start Plan Billing。
- private lease 在 cancel、Worker exit、ACK loss、EOF、重复 consumer 和账户切换时不跨 identity 重放。
- 固定上游 refresh patch 通过 single-flight、CAS、timeout、stale writer、A→B→A 和 late response 矩阵。
- 不同 profile 可继续并发；相同 profile 只在 refresh transaction 上串行。
- 真实 OAuth、远端 rotation 语义与 Billing 网络行为仍未执行。

### SQLite 与生命周期

- 32 MiB Result、完整 frame、COMMIT unknown、CAS、late cleanup、Manager restart 与 Hold 均有测试。
- Preview.4 的生产 Lifecycle startup 自动升级 v13→v14，保留 occupied running Attempt、Recovery Hold、events、digest 和 durable facts。
- rename/publication 中断后能够幂等恢复；blocked source fail closed。
- 这些是测试范围证据，没有使用生产 SQLite。

### 固定制品

- 13 个 BOM 文件逐项验证 bytes 与 SHA-256。
- 三个 patch 验证顺序、路径、bytes 与 SHA-256。
- `BUILD_PROVENANCE.json` 与 BOM、Host module 输出一致。
- clean checkout 中动态导入 Host module，并加载 Windows x64 keyring Node-API binding。

## 未覆盖

- 真实账户、OAuth 网络刷新、Start Plan/Coding Plan 模型请求和 Billing。
- 一般 Desktop Main 独立性。
- 自动选择或支持多个 upstream runtime 版本。
- 生产数据迁移和安装级回滚。
- 长时间 soak、持续资源峰值与产品性能。

## 结论

当前证据足以支持 Windows x64 / Node 24.16.0 固定 Official Host 制品的工程候选验收；真实服务行为仍是单独的 `NOT_RUN` 运营验证项，不能从合成 PASS 推导。
