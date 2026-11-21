# Token Efficiency A/B

> Status: RESEARCH
> Last updated: 2026-11-22
> A0: `1f9ff9ef37528205e76156e13fe06ed2b1fd3711`
> Implementation: `6f814bf8736baa59295e686af8733c88d4202ca0`
> Run: `token-efficiency-20261121-offline-ab` / `host-probe-20261121-installed-host`
> Current Preview base: `450c18afc0c8af2700734399c5aebd87a36df795`

## 对照与测量

PR #116 已在 `450c18afc` 合入 Preview。统一集成候选另外吸收 Track A 的默认
32 KiB Event 页（ADR-048）和 ADR-039 行政释放保护；默认 Event 分页未进入下述固定
离线样本的 27.2% 归因。ADR-039 为 `zcode_status` 和 `zcode_cancel` 增加可选
`dispatch_blocker` Schema，属于诊断合同而非 Token 收益，并使 B-All 目录代理增加
360 Tokens。非零预算真实 A/B 仍未执行。

`replay-ab.mjs` 使用冻结 A0 与候选的 `createBridgeServer`，通过锁定的 MCP SDK
读目录和调用工具。十个固定样本覆盖单文件、多文件、大代码任务、长时间运行、大日志、
中断且缺 Result、重复查询、连续相关任务、稳定 Prompt、不同 Prompt。用同一组
TaskPackage 和状态证据构造各组。B3 样本仅改变同一证据的交接方式。Worker 失败和
中断样本留在各组。已知大日志失败的样本包含一次完整取证补读。

每组计入一个 `tools/list`。请求参数、文本、`structuredContent` 和响应对象分别用
`js-tiktoken@1.0.21` 的 `o200k_base` 编码。表中 Envelope 指工具响应对象，
含两个返回通道。实际宿主可能选择不同的通道或重复注入。目录、响应、请求和 Worker
Prompt 的统计不混用。

安装版 Codex Host 的零成本探针补齐了通道选择：MCP Result 同时含文本和
`structuredContent`，但第二次 Responses 请求的模型可见 `function_call_output`
只含 `structuredContent`，另加约 48 字符的 wall-time 包装，不含文本通道。因此
Envelope 是本机传输上界，不是当前安装版 Host 的实际模型输入；结构化通道加目录是
更接近模型的代理指标。探针使用本机回环 Provider，未发起 Provider 或计费请求。

| 组 | 目录代理 Tokens | 调用数（另计一次目录） | Envelope 代理 Tokens | Envelope + 目录 | 请求参数代理 Tokens |
|---|---:|---:|---:|---:|---:|
| A0 重复 Status | 7,747 | 62 | 90,426 | 98,173 | 3,530 |
| A0 Attention 对照 | 7,747 | 33 | 82,947 | 90,694 | 3,121 |
| B1 现有 Attention + Event 归属 | 7,785 | 33 | 82,969 | 90,754 | 3,146 |
| B2 Result 分层 | 7,904 | 63 | 65,753 | 73,657 | 3,642 |
| B3 工件引用 | 7,747 | 62 | 90,426 | 98,173 | 2,074 |
| B4 保持缓存输入对照 | 7,747 | 62 | 90,426 | 98,173 | 3,530 |
| B5 仅描述 | 7,278 | 62 | 90,426 | 97,704 | 3,530 |
| B-All | 7,729 | 34 | 58,296 | 66,025 | 1,802 |

| 场景 | A0 Attention Envelope | B-All Envelope | A0 Attention / B-All 调用 |
|---|---:|---:|---:|
| 单文件 | 701 | 701 | 3 / 3 |
| 多文件 | 1,174 | 1,174 | 3 / 3 |
| 大代码任务 | 26,157 | 962 | 3 / 3 |
| 长时间运行 | 1,145 | 1,156 | 6 / 6 |
| 大日志失败 | 50,473 | 50,995 | 3 / 4 |
| Worker 中断 | 488 | 488 | 3 / 3 |
| 多次查询 | 688 | 699 | 3 / 3 |
| 连续相关任务 | 701 | 701 | 3 / 3 |
| 稳定 Prompt 对照 | 707 | 707 | 3 / 3 |
| 不同 Prompt 对照 | 713 | 713 | 3 / 3 |

## 归因与限制

- B-All 的双通道 Envelope 加目录比重复 Status 下降 32.75%，比 A0 已有 Attention
  下降 27.2%。安装版 Host 只注入结构化通道时，对应代理值从 48,175 降至 35,768，
  降幅 25.75%；文本通道加目录为 49,255 → 36,923（−25.04%）。这些仍是 MCP 载荷代理，
  不能换算成实际 Provider 输入或费用。
- 27.2% 的总体结果高度集中。大代码成功样本从 26,157 降至 962，减少 25,195，
  大于总体净减少 24,651；该样本解释了 102.2% 的净收益。固定样本中位数仍为
  710 → 710。大日志失败从 50,473 增至 50,995（+522，并多一次完整取证读取）；
  长时间运行和多次查询各增加 11。当前证据只支持“大型成功 Result 的显式摘要可降低
  MCP 载荷”，不支持普通任务、失败任务或完整任务账单普遍降本。
- 分样本 Envelope 的均值为 8,294.7 → 5,829.6，最近秩 P90 为 26,157 → 1,174，
  P95 为 50,473 → 50,995。统计单位是 10 个固定回放样本。两次确定性重跑验证可复现性。
  真实任务成本分布和置信区间需要真实配对数据。
- 重复 Status 到 Attention 的 29 次调用差来自 A0 已有功能。B1 在同一 Attention
  调度内维持 33 次调用，Event 归属为响应和目录共增加 60 个代理 Tokens。
  B-All 的 34 次调用包含一次完整取证补读。计量从启动信息已消费后开始，固定轮询次数，
  启动阶段、Thin Waiter 命令和后续 MCP 核对均在计量窗口外。宿主唤醒延迟和模型轮次待测。
  SQLite 套件覆盖 WAL reader、Pending、终态、超时和 Attempt 唤醒谓词。
- B2 的大代码 fixture 省去原始正文。大日志失败 fixture 必须读回完整证据，
  增加 522 代理 Tokens 和一次工具调用。短结果始终只读一次。已知需要原文时
  Master 可直接使用 `full`。实际补读率取决于任务。
- B3 两次引用共省 1,456 个 MCP 请求参数代理 Tokens。每次引用如增加一次文件读，
  额外文本共 1,320 代理 Tokens。Worker Prompt 加原文后每个样本仅省约 7，
  文件读取的工具包装可能抵消节省。回放输入的活文件与读取费用为固定假设。
- B4 是 A0 无改动对照。候选重复加载同一工具目录得到相同结果，Worker Prompt 与 A0 相同。
  冷缓存、热缓存、同任务、连续任务、重启/恢复及新目录的实际缓存收益均未测量。
- B5 单独替换描述得到目录下降 6.1%（7,747 → 7,278）。组合加入 Result、
  Event、Status 和 Cancel Schema 后目录为 7,729，仅比 A0 少 18 Tokens（−0.23%）；
  其中 `dispatch_blocker` 是 ADR-039 的兼容性成本，不应归入 Token 优化。候选仍广告
  12 个 `outputSchema`。

## 安装版 Host 探针

- Codex Desktop `26.1117.4957.0` / CLI `0.171.0-alpha.13` 对同一 MCP Result
  保留两个通道：宿主事件含约 24K 字符文本和约 24K 字符结构化载荷；发给模型的下一
  `function_call_output` 仅含结构化载荷，文本 marker 为 false。证据在
  `.run/host-probe/evidence.json` 与 `requests.jsonl`，请求数 2，付费请求 0。
- AppServer 直读 32 MiB Result 时，MCP transport 在 16,777,216 字节行上限处丢弃，
  未返回 Result；探针记录 `host_line_limit_discard`，进程树清理已验证。证据在
  `.run/host-probe/app-server-large-result.json`。SQLite 原证据仍在，但当前
  MCP-only `view="full"` 无法完成超过宿主行上限的完整回读。SDK 大缓冲测试不覆盖
  这一 Host 边界。
- 该探针只证明通道选择和读取边界，不证明 Provider Prompt Cache。两次请求的工具
  JSON 均为 21,531 bytes，注册顺序稳定；真实缓存读取、写入、额外模型轮次与费用仍为
  `NOT_MEASURED`。

## 真实试点

本轮试点发起的模型请求与账单请求均为 0。实验性 Provider 支出为 0。
完整任务的 Master、Worker、其他模型费用、实际 Usage、cache read/write、可缓存输入、
实际 MCP Context、任务成功/恢复/重试率及完整墙钟时长为 `NOT_MEASURED`。
日常 Codex 开发和审查的可归因成本未知。真实 A/B 会记录该任务的 Codex Master
成本，完整成本口径为 `TotalCost = MasterCost + WorkerCost + OtherModelCost`。
集成候选 Windows 全量本地回归为 981 PASS、0 FAIL、2 SKIP，退出码 0；两个注册压力门
另为 4/4 PASS。它们不度量真实 Worker 成功率、恢复率或账单。实际墙钟和额外
Master 模型轮数也没有可归因数据。
试点门禁和缺项见 [发布门禁](TOKEN_EFFICIENCY_RELEASE_GATE.md)。

条件具备后先冻结同一模型版本、推理档、真实工作树、验收、账户、价格表版本和缓存策略。
用一个 A0/B-All 配对收集全部角色的请求级用量、费用和任务结果。将失败、重试、
待结算及所有辅助模型纳入归因和最坏预算。对同口径已结算费用采用
`1 - ΣCost_B / ΣCost_A`。可承受的重复数确定后，按任务和冷/热缓存分层保留
均值、中位数、P90/P95，并用配对重采样评估区间。单对试点不足以认证成功率非劣。

## 复现

从集成工作树执行。A0 目录必须从冻结提交构建，含 [基线](TOKEN_EFFICIENCY_BASELINE.md)
指定的模型无关测试和 tokenizer。本机取证根目录为
`D:\codex-zcode-bridge\.run\bridge-2.0.0-consolidation-20261122-offline-ab`。

```powershell
npm.cmd run build
$a0 = '..\token-efficiency-phase0-audit-20261121\dist'
$run = 'D:\codex-zcode-bridge\.run\bridge-2.0.0-consolidation-20261122-offline-ab'
node docs/research/token-efficiency-phase0-20261121/replay-ab.mjs $a0 > "$run/replay-ab-integration.json"
node docs/research/token-efficiency-phase0-20261121/replay-ab.mjs $a0 > "$run/replay-ab-integration-repeat.json"
Get-FileHash "$run/replay-ab-integration.json","$run/replay-ab-integration-repeat.json"
```

离线验收核对原请求的全量对象、文本、工具错误、Schema 对象根及完整证据补读。
集成工作树两次回放 JSON 的 SHA-256 均为
`5e25e373802daec8b019a15403e8819fd5bdc9f037a0257bf97b637f61cdaf99`
（文件内容为小写哈希，PowerShell 仅按大写显示）。候选 `tools/list` SHA-256 为
`203253530f5da8a1ade6c4f2990ce05e6180f9bc160f983f88e298ff45578f54`，
候选 MCP server 构建 SHA-256 为
`15ecb8f5a798e02a32f3465379c298b77886415aa74abbbd4fc63522b89376d4`。
逐场景及各返回通道的统计保存在回放 JSON。
