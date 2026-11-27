# G6：性能与资源观测

> Status: RESEARCH — LIMITED SYNTHETIC BENCHMARK / PRODUCT PERFORMANCE UNKNOWN
> Last updated: 2026-11-12
> Last verified: 2026-11-12，读取 `.run/performance-benchmark-20261112/evidence/summary.json`
> Verified against: Bridge candidate `ba25f837` + documentation changes；earlier fixed official artifact benchmark；loopback Mock provider only

## 环境

- Windows x64
- Node `24.16.0`
- 3 个顺序 sample/path：official official ProcessManager 与 direct AppServer
- fixed AppServer hash `DF4637...B4F2E`
- benchmark 时的 Host module hash `B74F6A...D22343`；该样本早于当前 `3F481A...B537` 制品，不能与当前候选性能等价
- Provider origin `127.0.0.1`
- real model/account requests: 0

## Median

| Metric | Official (ms) | Direct (ms) |
|---|---:|---:|
| AppServer start | 128.891 | 1,241.202 |
| Session create | 479.692 | 445.350 |
| execution ready | 42.124 | 37.893 |
| send ACK | 7.937 | 5.897 |
| success turn | 854.907 | 893.139 |
| tool roundtrip | 222 | 240 |
| cancel | 121.466 | 101.973 |
| shutdown | 73.566 | 83.253 |

表中的 official “start” 数值较小不能解释为“官方路径启动更快”。official path 的计时包含通过 ProcessManager 和 Windows helper 建立 client 的划分，direct path 的 start 与 benchmark-only lifecycle fallback 语义不同；两条路径使用不同 handle 和关闭实现。

## 资源观测

每个生命周期样本在 started/ready/after-turn 观察到 AppServer root 与 helper 共 2 个进程，shutdown 后为 0。RSS 和 CPU 只在离散边界采样，不包含连续峰值、句柄、线程或磁盘 I/O 峰值。

## 支持的有限结论

- 在 3 个 Windows x64 loopback Mock 样本中，所有 run 最终为 success/cancel 且 shutdown 后 managed processes 为 0。
- fixed official 路径能够完成 start、session、tool roundtrip、cancel、shutdown。
- 样本可用于发现明显数量级问题，不用于产品容量或 SLA。

## 不能推导

- Official 与 direct 的普遍性能优劣
- p95/p99、并发吞吐、队列等待或长期内存稳定性
- 真实 Provider latency、Billing、token refresh 或网络重试
- 生产用户工作负载
- 其他平台/硬件

## 后续门槛

至少需要固定硬件/OS/Node、统一生命周期语义、足够样本和 percentile，并分别测量 cold/warm start、真实 Provider 延迟、同 profile/不同 profile 并发、Browser/MCP/tool 后代与持续资源。完整回归和真实服务运行仍是发布前置条件。

## 结论

`PRODUCT_PERFORMANCE: UNKNOWN`。
