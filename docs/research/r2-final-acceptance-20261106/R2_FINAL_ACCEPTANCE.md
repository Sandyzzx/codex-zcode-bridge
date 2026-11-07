# R2 最终验收：Host 兼容性与资源

> Status: RESEARCH
> Date: 2026-11-06
> Code baseline: `904f45770f21a423ba683cd0a91d9b1dd5fca6b8`
> Code tree: `9ac3d3d216afc6064db961cdf71b1f5080d540b2`
> Worktree: `D:\codex-zcode-bridge\.run\r2-final-acceptance-20261106`
> Acceptance status: **BLOCKED** — 当前实际 Host 不能完整接收最大 Result；Ubuntu 门禁另有一项确定的平台测试错误及一项未解的 MCP 超时。Windows 完整回归和 1/2/4/8 资源矩阵 PASS。

## 验收裁决

| 验收面 | 结论 | 证据边界 |
|---|---|---|
| 实际安装 Native Host＋Marketplace 最大 Result | **BLOCKED** | 4 KiB 完整返回；32 MiB 被 16 MiB 行门丢弃；单份最大 Result 也无法接收 |
| TypeScript SDK 限制区分／独立完整传输 | **PASS** | 默认 10 MiB 负例；独立大缓冲 stdio 客户端六个 32 MiB 组合完整返回；不冒充实际 Host 成功 |
| 1/2/4/8 最大 Result 生产生命周期／资源 | **PASS** | 15 个任务均一次 Spawn、完整 Result、Cleanup、Release；32 MiB ASCII，非 Provider/密集数组八并发认证 |
| Windows 最终代码完整回归 | **PASS** | 991 total / 989 pass / 0 fail / 2 既有 skip |
| Ubuntu 构建、产物一致性与定向回归 | **PARTIAL；门禁未通过** | 构建和四个 bundle 对 Git blob 一致；86 total / 82 pass / 1 fail / 1 cancelled / 2 既有平台 skip |
| 原生 Ubuntu 完整 CI、Desktop UI／模型上下文大结果 | **NOT RUN** | 本轮 Ubuntu 为真实 Linux VM 的 TCG 模拟环境；没有向模型发送 turn |

32 MiB TaskResult 与 256 KiB 私有 Worker envelope 合同保持不变。后者不是 MCP 双份返回的外层预算。所有生产文件、测试、映射和 CI 与 904f457 保持一致，没有生产数据库迁移或公开 API 修改。

## 已确认的阻断

Observed：本机 Desktop 正在使用的 Native Host 为 `codex-cli 0.166.0-alpha.6`，路径 `C:\Users\Sandy\AppData\Local\OpenAI\Codex\bin\cf48bb65779b3399\codex.exe`，SHA-256 `4c771af345a7f0c02aca6294008ee0f74078481020f6113641833005b5049305`。暂停前记录的同版本可执行文件哈希不同，且原 Worktree 和日志已被清理；本报告采用 11 月 6 日重建隔离 Worktree 后重新取得的证据。

使用该实际可执行文件的 App Server、实际 `plugin/install` Marketplace 安装及 `mcpServer/tool/call`，读取新的合成 SQLite v14 数据库。插件 Bridge/Worker 与 904f457 构建制品一致。4 KiB `zcode_result` 的 structuredContent 和 text 全字段 canonical SHA-256 均匹配；32 MiB Result 被 Host 明确丢弃：

```text
Incoming message exceeded the maximum line length, discarding it max_line_length=16777216
```

这不是仅依据 RPC 超时推断的失败。探针记录 stderr 后提前结束等待，`PROBE_OBSERVED_NATIVE_LINE_DISCARD` 是探针分类，不是 Host 返回的 JSON-RPC 错误。最大结果调用没有收到完整 Result；隔离数据库文件 SHA-256 前后相同。

进一步用独立诊断 MCP 服务测精确帧边界，保留完整 TaskResult 字段，仅改变返回形式。structured 和 text 均得到：含结尾 LF 的整条 MCP JSON 帧在 16,777,215 和 16,777,216 字节时完整返回、摘要一致；16,777,217 和 16,777,218 字节时丢弃。每个场景使用新的隔离 Host，避免前一次丢帧遗留 pending 调用影响下一次。该结果只声明本次版本与输送路径的观测边界。

这验证了真实安装的 Native Host/Marketplace 接收路径；未发送模型 turn，没有证明 Desktop UI 渲染、模型上下文交付或真实 Provider 能处理大 Result。已经失败的底层接收门足以阻断当前 R2 Host 容量验收。

## SDK 和 Host 是两个独立限制

仓库锁定的 `@modelcontextprotocol/client 2.1.0` 在 `dist/src-DDAAhLnO.mjs` 定义默认 `STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024`。生产测试 `test/mcp-result-v14.test.mjs` 分别使用默认客户端和显式提高容量的隔离客户端；前者应报 `ReadBuffer exceeded maximum size of 10485760 bytes` 并断连，后者验证完整双份结果。

该配置属于 TypeScript 客户端；不能调整实际 Rust Native Host 的 16 MiB 行限制。诊断 Host 的单份约 16 MiB 成功响应也直接证明 Host 并非沿用同一 10 MiB ReadBuffer。

## 32 MiB Result 的实际 MCP 传输成本

诊断服务使用真实 SDK `StdioServerTransport`，在发送时计量 `JSON.stringify(message) + LF`，记录 canonical/wire 字节和 SHA-256。所有下表 Result 的 canonical UTF-8 均恰好 33,554,432 字节；是代表性输入，不是所有合法内容的上界。

| 数据形态 | structured 单份 | text 单份 | 两份同时返回 |
|---|---:|---:|---:|
| ASCII 正文 | 33,554,502 | 33,554,607 | 67,109,060 |
| NUL 转义正文 | 33,554,502 | 39,146,970 | 72,701,423 |
| 数组密集：大量合法空字符串文件项 | 与 canonical 相同容量级别，未单独运行该组合 | 123,032,427 | 156,586,880 |

所有 32 MiB 组合均被真实 Host 丢弃。text 把 pretty JSON 放进 JSON 字符串，增加引号、反斜线、换行和缩进成本；数组密集样本说明不能把约 64 MiB 当作固定的双份上界。其 text 约 117.33 MiB，双份约 149.33 MiB。fixture 的编码进程高水位约 1.73/1.92 GiB，只代表本诊断生成/序列化过程，不冒充生产 Worker 峰值或 Host 成功接收成本。

Native Host 拒收，所以没有“32 MiB 经 Native Host 实际成功交付”的时间或 Host 接收 RAM 结论。失败场景计量完整编码帧，不能冒充整帧已经写完管道或已经交付。

另用真实 SDK stdio 服务和明确设为 256 MiB 的**独立诊断客户端**，完整发送并回读 ASCII/NUL 的 structured、text、both 六种组合，全部 canonical 摘要相同，实际帧字节与上表一致。它没有改变实际 Host 的配置。各组合从调用到完整响应的观测时间依次为：structured ASCII/NUL 5.41/4.91s，text 3.86/5.02s，both 12.58/14.73s；计入服务端生成/编码、stdio、客户端缓冲和解析，未控制整机后台负载，不能当作纯管道吞吐或稳定延迟合同。客户端进程高水位约 296–564 MiB；服务端使用额外计量副本，高水位不是生产 MCP 进程预算。

## 资源矩阵和回归

### Windows 最终提交完整回归

`npm run test:full` 在当前最终代码执行完成：**991 项、989 PASS、0 FAIL、2 个既有 SKIP、0 cancelled**。typecheck、core/plugin build、完整隔离测试和 plugin validation 全通过；Node 测试时间 1,752.73s，命令墙钟 1,787.18s（29m47s）。本轮没有修改断言、超时、SKIP 或执行清单。期间部分验收探针/Ubuntu VM 与回归重叠，因此不拿墙钟与历史回归作性能 A/B。

其中真实生产 Worker、Adapter Unicode/escaping、32 MiB 边界、超限/非法结果错误收敛、CAS/Recovery、COMMIT 不确定、v13 BLOB 历史数据复制和 shipped CLI 均由现有自动测试覆盖。默认 SDK 的 10 MiB 负例及大缓冲完整双份接收通过，后者实际 `CallToolResult` body 为 67,109,025 字节。B3-05 原参数压力用例 375.14s PASS；不把它当作新增 SQLite 历史增长矩阵。

### Windows 1/2/4/8 并发最大 Result

沿用提交内 `scripts/probe-result-resources.mjs`，SHA-256 `7faa6cd6054e4063b1a9132aeff35f45cc6b01dca144fb67375318545d943e5b`。包装器只加入自有进程清单和 OS 采样，原脚本保留。每个场景在新的 Manager 进程、隔离 v14 数据根运行；受控 synthetic Adapter 产生恰好 32 MiB ASCII Result，实际 Worker/Spawner/Claim/fd6/Manager/SQLite/Cleanup 全部运行。全部 Worker Claim 齐备后同时开放结果生成。

各场景 Result、Cleanup、Release 均通过，每个任务 Spawn 恰好一次。资源矩阵运行时 Windows 全回归、SDK 探针及 Ubuntu VM 都已结束；没有调整生产预算。

| 并发 | 完成秒数 | Manager RSS 高水位 MiB | 采样 Manager＋Worker WS 合计峰值 MiB | 私有提交内存合计峰值 MiB | DB/WAL/SHM 等文件峰值 MiB |
|---|---:|---:|---:|---:|---:|
| 1 | 6.03 | 660.30 | 596.31 | 689.51 | 96.83 |
| 2 | 11.51 | 885.24 | 756.73 | 850.11 | 129.06 |
| 4 | 28.70 | 1,111.16 | 1,145.40 | 1,344.50 | 193.55 |
| 8 | 71.67 | 1,608.10 | 1,637.92 | 1,816.45 | 322.53 |

Worker 各进程高水位约 179.5–185.4 MiB。1/2/4/8 场景提交完成、Driver 关闭前的 DB 字节分别为 67,407,872 / 101,003,264 / 168,198,144 / 302,571,520，WAL 为 34,027,112 / 34,228,992 / 34,657,472 / 35,530,912；这些不是磁盘空间紧缩后的逻辑 Result 总和。

采样周期 500ms，可能漏掉瞬时峰值。WS 合计可能重复计算共享页；private bytes 是私有提交虚拟内存，不是物理驻留内存。各进程高水位也不是同时发生的总峰值。清单绑定进程句柄与 StartTime，只统计 Manager/Worker，未将临时 OS probe helper、Host 或整机进程计入。它不是实际 Provider、MCP pump 调度或数组密集 Result 的八并发认证。**STRESS_TESTS_RUN：R2 最大 Result 1/2/4/8 矩阵**；R3–R7 调度/历史增长专项未扩展，不能据此声称均通过。

### Ubuntu

真实 Ubuntu 24.04.5 LTS / Linux 6.8.0-147-generic / x64 / Node 24.16.0 / SQLite 3.53.0。所有环境位于项目内的 QEMU TCG 虚拟磁盘，无 WSL/Hyper-V 安装、宿主服务或权限变更。普通 `ubuntu` 用户，源 Git 归档 SHA-256 `1a4a30ff666675967f16bd29d589f8137ecc50a59786b0010c767f55414b9deb`，对应 904f457；使用锁定依赖及匹配的 Linux esbuild 0.28.2。

typecheck、build PASS。首轮比较 build 前后文件 SHA 时夹具 **FAIL**，随后查证为验收工具的 CRLF 基准错误：Windows `git archive` 输出应用了当前 `core.autocrlf` 转换，而重建产物为 LF。取回实际 Linux Bridge、Worker、upgrade CLI、Waiter 四个产物，与 `git show 904f457:<path>` 的原始 blob **全部逐字节相同**，不是忽略换行后才相同。包内 Bridge 的旧归档为 1,822,216 字节/38,960 个 CRLF，重建产物及 Git blob 均为 1,783,256 字节；其他三件也对应完全相同的转换。验收脚本改用明确的 Git blob SHA，不降低产品断言。原失败及调查数据保留，分类为夹具错误，不作为产品失败。

typecheck/build、validator、build:test 均完成。最终使用同一自有虚拟磁盘已编译的 904f457，在普通用户下运行八个现有 Linux 自动入口：`sqlite-result-v14`、`sqlite-v14-upgrade`、`mcp-result-v14`、`wp6c/result-recovery`、`wp6b2b1/lifecycle-port`、`wp6c/admin-abandonment`、`spawn-worker-stderr`、`wp6b-wiring/lifecycle-gate`。执行器和平台排除策略保持原值。

**86 项、82 PASS、1 FAIL、1 CANCELLED、2 个既有平台 SKIP，Node 472.15s，命令退出 1。** 32 MiB 的 Unicode/转义边界、SQL +1 拒绝、实际 SQLite 原值/digest/duplicate/CAS/Recovery、提交不确定及故障、v13 行/event/BLOB 和 shipped upgrade CLI 均通过；四个真实 Spawner stderr 场景也通过。两项未通过必须保留：

| 项目 | 触发、证据与影响 | 最小后续处理 |
|---|---|---|
| **确认：Linux 自动测试的平台合同错误（测试/CI 问题，P2）** | `test/sqlite-candidate/wp6c/admin-abandonment.test.mjs:300` 无条件要求实际子进程 CLI 执行成功；生产 `src/cli/admin-abandon-held-operation.ts:292` 正确拒绝非 Windows，报 `windows_required`。`test/test-impact-map.json:323` 将整个文件放入自动门禁，`scripts/lib/test-files.mjs` 的 Windows-only 集合未排除它。因此普通 Linux 自动入口确定性失败；不是生产行政命令应该放宽身份门。最小复现：Linux 构建测试后，用原 runner 仅运行该文件即可。 | 单独的测试修正任务：Windows 保留真实 CLI 成功/CAS 断言；Linux 验证 `windows_required` 且没有数据变更。保留同文件内仍有效的跨平台 Store/Recovery 覆盖，不通过移除整个文件、SKIP 或放宽生产 guard 取得绿色。冻结代码本轮未改。 |
| **确认观察，原因未定：最大 Result MCP 60s 超时** | `test/mcp-result-v14.test.mjs:10` 在 60,137.73ms 触发原有 `timeout:60000`，Node 计为 CANCELLED。发生于 1 vCPU / 4 GiB / QEMU TCG 的真实 Ubuntu；是否仅由软件模拟开销导致，**不确定**。该用例在 Windows 最终完整回归通过，但不能代替 Linux 通过。 | 在原生 Ubuntu 或既有 Ubuntu CI 以原始测试预算核验。没有调整超时、减小 Result、截断数据或替换断言；本轮不声称原因已定位或门禁已通过。 |

Ubuntu 环境的必要限界：早期验收列表误含两项已有 Windows-only 文件，被执行器在测试开始前拒绝，已依现有 manifest 更正。另两次 TCG 启动发生 IO-APIC 计时器 kernel panic，未进入产品代码；其中仍存活的自有 panic VM 按捕获的精确进程指纹收束。最终使用 1 vCPU、legacy PIC 的 profile 完成上述 86 项执行；构建阶段为 4 vCPU。原始失败证据保留，夹具/启动失败与真实测试断言结果分别计数。完整 Ubuntu suite/远程 CI、原生 Linux 性能均未运行，不用模拟环境宣称通过。

## Owner 决策点

保留 ADR-026 已批准的 32 MiB / 256 KiB，不实施生产迁移或公开 API 变更。本轮不修改产品源码、测试、Schema、生命周期合同或插件返回形式。

1. 若继续要求现有 `zcode_result` 一次返回全部字段，必须先有实际 Host/传输支持足够帧容量的证据；仅将 TypeScript ReadBuffer 调大无效。未来提高 Host 上限时还需覆盖合法数组和转义扩展，不能仅据 ASCII 双份结果拍定 64 MiB。当前[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)列有 tool timeout 和输出 token budget，未给出已验证的 stdio 行上限解除方案；这不证明没有内部开关。本报告的 16 MiB 是指定二进制/实际隔离配置的观测，不推广到所有版本。
2. structured-only 可以减少重复序列化，但当前 16 MiB Host 仍放不下 32 MiB。它还涉及公开消费兼容，不能当作已解决方案。
3. 如果 Owner 选择不同的读取方式，另立消费合同决策并验证完整字节、身份、读取一致性和错误语义；本轮不引入分页或第二 Result Authority。其他传输、资源引用、UI/模型读取路径均尚未验证，不能宣称可行。

Host 查询失败时，本次最大 Result 已在 SQLite 完整保存且 Operation 已 released；查询失败不能被当作执行失败，不能因此重派 Worker。最先值得推进的是 **Host 完整读取合同裁决**，并行修正上述 Linux 测试平台合同、在原生 Ubuntu 核验原 MCP 预算。三者均不需要启动 R3–R7 生产改造。

## 产物、重现与 Git 边界

当前目录的 `ACCEPTANCE_EVIDENCE.json` 汇总最终统计、每个 Host/SDK probe、资源矩阵、产物 SHA 和原始日志路径/摘要。原始证据在本 Worktree `.run/acceptance/`；没有采用已被清理的暂停前日志作为本次 PASS。

手动工具不进入自动套件：`native-host-probe.mjs` / `native-matrix.mjs` 为实际安装 Host 和隔离 Marketplace/诊断服务；`sdk-wire-probe.mjs` 为独立可完整接收的 SDK 对照；`resource-matrix.mjs` / `sample-owned-processes.ps1` 包装提交内资源探针；`ubuntu-vm.mjs` / 两个 guest shell 为项目内临时虚拟机。Native probe 要显式指定 `R2_CODEX_EXE`；每例只创建自有数据根，没有模型 turn。VM 的 `--resume <owned-run>` 只能在先前 QEMU 已确认退出后使用；`--tests-only` 复用已完成的编译，不重跑构建。

Ubuntu 输入：官方 minimal 24.04 amd64 cloud image（SHA-256 `406630c08b5e545fcc7209854b129d47e3af822db128c9f19336593b5a2d3fe0`）、Node 24.16.0 linux-x64、QEMU Windows 20260811（官方 SHA-512 已核对）、当前锁定依赖及匹配的 Linux esbuild 0.28.2、904f457 的 Git archive。二进制/安装器只在项目内解包，未执行宿主安装。详细输入摘要在 evidence JSON；所有 guest 的文件写入封装在项目内虚拟磁盘，HTTP seed 仅监听 loopback。

本轮 `test:affected --base 904f457...` 的 T0 已通过：typecheck、build、plugin validation、diff check；选择结果为 **NO_TESTS_APPLICABLE**，不把它计为新增测试 PASS。手动工具另做语法检查及上述实际执行。只保留验收文档/工具；构建产生的换行变动经核实无真实 diff 后恢复。主 Worktree 仍为发布基线 aabbb0a，并保留原 `.gitignore` WIP；验收分支为 `codex/r2-final-acceptance-20261106`。没有修改生产/测试/CI、没有生产 SQLite 访问或 v14 生产迁移、没有未知 Hold 处理、没有 Push/Merge/Tag/Release。
