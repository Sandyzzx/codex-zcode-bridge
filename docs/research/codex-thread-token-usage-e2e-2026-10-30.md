> Status: RESEARCH
> Updated: 2026-10-30
> Verification: source/schema audit, isolated candidate tests, real Rollout reads, a read-only Magpie comparison, and an explicit-ID Rollout discovery/tail observation were completed. The latest live Activity append test passed without issuing a model request. The earlier minimal real App Server attempt remains PARTIAL because it captured no confirmed Thread Token Usage notification; the account-null auth block was superseded by the follow-up evidence below.

# Codex 主会话 Token Usage 隔离接入与真实 E2E 验证

任务：`CODEX_THREAD_TOKEN_USAGE_E2E_20261030`

> Release packaging note (2026-11-01): the raw `.evidence/` capture tree is intentionally excluded from the Preview release tree. It remains attached to source commit `d91913a2c1b4b04485ee2815bb3b9fb80be2f131`; paths below identify the original evidence layout rather than files shipped in the plugin package.

## 结论与范围

本 Worktree 增加了独立观察模块 `src/observability/thread-token-usage.ts`。没有接入 `src/host/stdio.ts`、现有 JSON TaskStore、Worker、调度或清理链路，没有新增 MCP schema，也没有启用 SQLite。

合成候选已覆盖通知字段映射、Thread 隔离、去重、turn fence、Compaction 前后绝对快照、恢复入口、缺失字段保留 unknown、通知缺失后的绝对总量恢复，以及主动查询错误状态分类。它不能证明本机 Desktop 的活动主 Thread 实际发出了该通知。

本机安装信息：Desktop `26.1027.3384.0`；实际启动的二进制来自该 Desktop 安装目录，`codex --version` 为 `codex-cli 0.166.0-alpha.5.1`。该二进制的独立 App Server 子进程完成了 `initialize` / `notifications/initialized` 握手，且 `experimentalApi` 明确为 `false`。握手返回 userAgent `Codex Desktop/0.166.0-alpha.5.1 ... (thread-token-usage-e2e-probe; 0.1.0)`。脱敏响应见 `.evidence/runtime-initialize.json`。

**真实 E2E 总体状态：PARTIAL / BLOCKED。** 现有 Desktop App Server 由 UI 以 stdio 启动；没有可访问的活动会话 pipe。`codex app-server daemon version` 返回控制 socket 不可达（Windows socket 错误 10050）。因此本任务无法从当前主 Thread 捕获原始通知，也没有在真实主 Thread 执行额外轮次、触发压缩、断开恢复或多 Agent 任务。没有用 Mock 或本地合成通知替代这部分证据。

## 上游源码与本机协议核实

官方仓库参考：

- [protocol.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)：`TokenCountEvent`、`TokenUsageInfo` 和 `TokenUsage`。
- [app-server protocol v2 thread.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)：Thread Token Usage notification 类型。
- [app-server bespoke_event_handling.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/bespoke_event_handling.rs)：内部事件到通知的派发。
- [token_usage_replay.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/token_usage_replay.rs)：Thread attach/resume 时基于 rollout 最新 TokenCount 恢复通知。
- [account_processor.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/account_processor.rs)：`account/usage/read` 请求注册与参数形状。
- [history.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/context_manager/history.rs)：上下文历史与 usage 重算相关逻辑。

查询日期观察到的链接指向官方 `main`；本次 GitHub API 查询无法取得并固定源码 SHA，故这些链接只支持“当前上游源码观察”，不作为本机安装版本保证。本机版本证据独立来自安装二进制和它生成的协议 schema。

使用本机安装的 `codex app-server generate-json-schema` 分别生成默认与 `--experimental` schema。未加 `--experimental` 的默认输出已包含 `thread/tokenUsage/updated`、payload schema 和 `account/usage/read`；方法在本机 schema 中不是 experimental-only。默认 v2 schema SHA-256：`3164e5e1b190371566a3c163f6f4e56ee75552b5652ece246149e028cbabf23d`；experimental v2 schema SHA-256：`ab788279bb5212b13701b505f7d8f119a71705d91f46e6e09c1e893e98c4a541`。生成物保留在 `.evidence/local-schema-default/` 与 `.evidence/local-schema-experimental/`。

本机协议 schema 的通知要求 `threadId`、`turnId`、`tokenUsage.total`、`tokenUsage.last`；`modelContextWindow` 是 nullable。各 breakdown 的大多数字段是整数；`cacheWriteInputTokens` 在 schema 中有默认 0，但候选模块对 wire 上省略的值仍保留为 `null`，以免把未观察值伪装成实测零。

| 核查点 | 当前证据结论 | 限制 |
|---|---|---|
| 通知是否为正式协议 | 本机默认（非 experimental）schema 含该通知；独立真实 App Server 接受 initialize | 当前 Desktop 主 Thread 没有原始通知抓包 |
| 是否需要 experimental 开关 | 本机 schema 生成时未启用 experimental 仍包含该方法；握手也用 `experimentalApi:false` | 没有对活动 Desktop 连接核验通知路由 |
| 是否每个模型响应后发送 | 上游派发由 `EventMsg::TokenCount` 驱动；能收到 token-count 事件时会形成更新 | 不保证无 usage、失败或特殊路径下每次响应都产生该事件；本机实际频率未测 |
| `total` 与 `last` | `total` 是来源提供的 Thread 累计/当前总量字段；`last` 是最近一次 usage/context 采样。客户端应原样保存，不把 `last` 相加 | compaction/context recovery 可能改变源值；不能把名字当成跨版本数学保证 |
| `modelContextWindow` | 模型上下文窗口上限，不是已使用 Token；本机 schema 允许 null | 无窗口值时不得计算百分比 |
| Compaction | 上游 history/usage 路径会重算或恢复 context 相关值；候选接受新的绝对快照、不自行累加 | 当前 Desktop 的压缩前后真实值：BLOCKED |
| Thread Resume | 上游 app-server 有从 rollout 最近 `TokenCount` 恢复通知的路径 | 当前安装版本的行为及活动 Thread 恢复：BLOCKED |
| 主 Thread / 子 Agent | 通知按 `threadId` 归属；模块每个 threadId 独立保存，不自行跨 Thread 求和 | 当前安装版本中实际 Agent 运行拓扑与总量归属：BLOCKED |

### `account/usage/read`

本机 schema 支持不带参数的账户活动摘要，也支持 `{ "threadId": ... }`。thread 形式响应可含 `threadUsage`、按模型分组的 token estimate 与 estimated credits/USD；它描述服务端用量/计费估算，不等于 `last.totalTokens` 或上下文窗口占用。作为活动统计补充可以研究，不能替代 `thread/tokenUsage/updated`。本任务没有发起该请求；认证、权限、接口不支持和一般失败状态由候选接口分别表示。

## 隔离实现

- `TokenUsageSource` 仅消费 `thread/tokenUsage/updated`；其它通知返回 `ignored`。通知到达标记 `supported`；若独立能力协商明确证明旧端不支持，宿主可标记 `unsupported`；尚未确认时保留 `unknown`。
- `ThreadTokenUsageManager` 按 `threadId` 保存最新绝对快照；exact duplicate 幂等；通过显式 turn-start fence 拒绝前一 turn 的延迟通知。
- `total` / `last` 分字段保留，不从 `last` 做加法，也不计算使用百分比。
- 缺失或格式不合法的数值保留 `null`；空 usage 不生成全零快照。
- `restore()` 可接收 rollout 恢复值并标识 `rollout_restored`，但模块本身不读取/解析 rollout。
- `account/usage/read` 错误状态保留 `unsupported`、`authentication_required`、`permission_denied`、`failed`、`unknown`。
- 快照是进程内状态。Bridge 重启后的历史恢复需由上游重放通知或另行持久化；本候选没有写 SQLite 或 JSON。

## 验证结果

合成测试：`test/thread-token-usage.test.ts`，最终专项运行 **16/16 PASS**。

真实本机协议探针：`.evidence/runtime-initialize.json`。探针启动安装目录中的真实 `codex.exe app-server --stdio`，仅执行协议 initialize，不发起模型请求；这证明本地二进制版本、启动和 initialize 响应，不证明 Desktop 主 Thread 收到 usage 通知。

完整项目验证记录：

- `npm test`：430 项，429 通过、1 项 Windows 平台跳过、0 失败（总运行 626.4 秒）。最大档 B3-05（32 active / 10,000 historical）通过；setup 533.366 秒、status p95 2.71 ms、recovery 25.970 秒、cleanup 7.285 秒。
- `npm run typecheck`：PASS。
- `npm run build`：在安装锁文件依赖后 PASS。第一次运行因隔离 Worktree 缺少 `node_modules` 中的 `playwright-core/browsers.json` 失败；`npm ci` 后重跑通过。构建造成的生成文件 CRLF-only 工作区噪声已恢复到候选 HEAD；Token 模块未接入 bundle。
- `npm run validate:plugin`：PASS。
- `git diff --check`：PASS。
- Token 专项 `npm run build:test; node --test dist-test/test/thread-token-usage.test.js`：16/16 PASS。

`NOT RUN` 仅用于未执行的真实 E2E 子项，不能解释为通过。

## 验收矩阵

| 验收项目 | 状态 | 证据 / 缺口 |
|---|---|---|
| 源码审计 | PARTIAL | 上游官方 main 与本机生成 schema 已核；上游 SHA 未固定，安装版本 Rust 源码未取得 |
| 协议兼容性 | PARTIAL | 本机默认 schema + 真实安装二进制 initialize PASS；活动 Desktop 连接未抓包 |
| 合成测试 | SYNTHETIC_TEST_PASS | 16 项测试以实际运行摘要为准 |
| 真实通知接收 | BLOCKED | 当前主 Desktop stdio pipe 不可从本任务访问；daemon socket 不可达 |
| 多轮更新 | BLOCKED | 未在活动主 Thread 取得原始通知 |
| Compaction | BLOCKED | 未对当前活动主 Thread 执行/抓取前后更新 |
| Thread Resume | BLOCKED | 未断开当前 App Server 或读取 rollout 后重连 |
| 多 Agent 隔离 | BLOCKED | 未创建真实多 Agent 任务；不能推断跨 Thread 汇总口径 |
| 旧版本兼容 | PARTIAL | 候选对未知 method、缺字段和失败状态有容错合成覆盖；未在旧 Desktop 二进制运行 |
| JSON 生产回归 | PASS | 候选未接入 JSON 生产路径；全量 `npm test` 429 PASS、1 平台跳过、0 失败，插件 build/validate 通过 |

## 最终架构建议

1. 仅能确认本机 App Server 的默认协议 schema 声明该通知；**稳定获取当前 Codex 主会话 Token 尚未通过真实通知 E2E**。
2. `modelContextWindow` 表示窗口容量。`last` 是最新来源快照，可用于观察当前请求上下文近似量，但百分比/准确占用必须经本机真实数据和 compact 状态验证；目前不建议对外显示百分比。
3. Compaction 后应以新的服务端绝对快照覆盖观察值；候选实现了此接收方式，真实压缩行为未验证。
4. 上游当前源码存在 Thread Resume 的 rollout token replay 路径；当前 Desktop 版本与当前主 Thread 未验证。
5. `threadId` 是候选唯一归属键。任何跨 Agent 求和都应等到真实拓扑与 server accounting 证据明确后再做。
6. 暂无必要写入现有 SQLite 生命周期设计。该能力目前是易失观察，尚无已批准生产合同和实证可靠性要求。
7. Worker Token 与 Codex 主会话 Token 应在上层分别保留 `source`、thread/worker 身份和 confidence 后再汇总；不要把主/子 Agent 跨 thread 加总，也不要用账户估算覆盖 context usage。

## 任务边界

源码只在 `codex/thread-token-usage-e2e-20261030` 隔离 Worktree。未 merge、push、tag、release；未清理实验文件或历史证据。Owner 审查前不得称为生产接线或完整 REAL_E2E_PASS。

## 后续：独立 App Server 真实 Token E2E 尝试（2026-10-30）

本轮使用安装的 `codex-cli 0.166.0-alpha.5.1` 启动独立真实 App Server，完成 `initialize` 并调用标准 `account/read`。未访问或复制 Desktop JWT/Token，也没有触碰活动 Desktop Thread。

`account/read` 返回 `account: null`，`requiresOpenaiAuth: false`。隔离 App Server 没有返回任何已认证账户类型，因此没有调用 `model/list`，没有创建 Thread，也没有发起模型请求。证据文件只保留版本、账户是否可识别、非敏感布尔状态及结论，不保存原始 account payload。结果为 `REAL_APPSERVER_TOKEN_E2E=BLOCKED_AUTH_UNAVAILABLE`，Thread ID 为 null，Token 通知数为 0。独立 Thread 未创建，因此没有产生该测试的 rollout 或外部持久 Thread 数据。

执行器为 `scripts/real-appserver-token-e2e.mjs`；脱敏结果为 `.evidence/real-appserver-token-e2e.json`。该运行只证明真实安装二进制可启动、完成协议握手并回答 account/read；没有证明真实模型或 Token 通知链路。

| 本轮要求的最终字段 | 状态 | 证据 / 原因 |
|---|---|---|
| `REAL_APPSERVER_TOKEN_E2E` | `BLOCKED_AUTH_UNAVAILABLE` | App Server `account/read` 没有已认证账户对象；未查询模型、未建 Thread、无通知 |
| `MULTI_TURN_E2E` | `NOT_RUN_AUTH_BLOCKED` | 没有执行真实模型调用 |
| `COMPACTION_E2E` | `NOT_RUN_AUTH_BLOCKED` | 没有创建 Thread；未调用 `thread/compact/start` |
| `RESUME_E2E` | `NOT_RUN_AUTH_BLOCKED` | 没有可恢复的测试 Thread |
| `MULTI_AGENT_E2E` | `NOT_RUN_AUTH_BLOCKED` | 未查询可用模型能力或创建 Thread |
| `DESKTOP_HOST_INTEGRATION` | `BLOCKED_PIPE_ATTACH` | 本轮仅探测独立 App Server；不代表可观察 Desktop 当前主 Thread |

达到本轮依赖门需要一个已登录且能由独立 `codex app-server` 标准账户读取路径识别的账户。当前证据不支持继续执行真实请求；不会从 Desktop 提取或复制凭据来绕过此门。

### 后续：修正认证判定并执行一次最小真实请求（2026-10-30）

本节修正上一节的判断：`account: null` 且 `requiresOpenaiAuth: false` 不能证明自定义 Provider 未认证。上一轮的 `BLOCKED_AUTH_UNAVAILABLE` 结论已被本次证据推翻。

本次只读检查发现当前独立 App Server 继承默认 `CODEX_HOME`（环境变量未设置，配置源为用户默认 `config.toml`），Provider 为 `magpie`、wire 类型 `responses`，配置模型为 `codex/gpt-6.1-sol`，Provider endpoint 主机为 `127.0.0.1:3425`。配置中存在受支持的 `experimental_bearer_token` 设置；只记录其存在，不读取或保存值。该设置官方支持但不推荐用于新配置。`account/read` 返回 account 不存在且 `requiresOpenaiAuth:false`，本次未把它当作认证失败。`model/list` 成功并返回 14 个可见模型，配置模型和默认模型均可见。失败归类不是 `NO_AUTH_CONFIG`、`PROVIDER_AUTH_FAILED` 或 `MODEL_LIST_FAILED`。

Desktop 版本为 `26.1027.3384.0`，独立二进制为 `codex-cli 0.166.0-alpha.5.1`，握手 userAgent 是 `Codex Desktop/0.166.0-alpha.5.1 ... (thread-token-usage-minimal-e2e; 0.1.0)`，`experimentalApi:false`。已观察 Desktop App Server 命令行没有 Provider/model 覆盖；Desktop 进程的 `CODEX_HOME` 环境未读取，因此 Desktop 与独立进程的完整配置同一性为 `PARTIAL`，不声称完全一致。未更改 Desktop 设置。

只创建了一个独立 ephemeral Thread，并通过 `turn/start` 发起一次 22 字符提示的真实请求，没有发送 Mock Response。脱敏 thread/turn 标识、时间戳、模型和非敏感配置摘要见 `.evidence/minimal-real-token-e2e.json`。探针没有保留 `turn/completed` 的状态/错误字段，且没有记录到可确认同时匹配该 Thread 和 Turn 的 `thread/tokenUsage/updated` 通知。故模型响应成功状态为 `UNKNOWN`；不能宣称真实模型请求成功。**本次最小阻断原因：没有一条已确认属于该独立 Thread/Turn 的真实 Token Usage 通知。** 认证并未被证明缺失或失败；`account:null` 不再作为阻断理由。为遵守本轮“一次最小请求”范围，没有重试或扩大实验。

| 本轮验收项 | 状态 | 证据 / 缺口 |
|---|---|---|
| `REAL_APPSERVER_TOKEN_E2E` | `PARTIAL` | 真实安装 App Server initialize、`account/read`、`model/list`、独立 Thread 与一次 `turn/start` 已执行；没有匹配 Token Usage 通知，门槛未满足；请求结果状态未知 |
| Provider 配置 | `SUPPORTED_AUTH_CONFIG_PRESENT` | Provider 配置中的 bearer 设置存在；其值未读取；真实模型鉴权结果未能从保留证据确认 |
| `MULTI_TURN_E2E` | `NOT_RUN` | 本轮只允许一次最小调用 |
| `COMPACTION_E2E` | `NOT_RUN` | 未调用 `thread/compact/start` |
| `RESUME_E2E` | `NOT_RUN` | 未关闭/重启 App Server 或恢复 Thread |
| `MULTI_AGENT_E2E` | `NOT_RUN` | 未创建子 Agent |
| `DESKTOP_HOST_INTEGRATION` | `BLOCKED_PIPE_ATTACH` | 独立 App Server 结果不代表可以观察 Desktop 当前主 Thread；Desktop 进程环境仍未核实 |

本次证据文件：`.evidence/minimal-real-token-e2e.json`。探针为 `scripts/minimal-real-token-e2e.mjs`；它修正了后续执行时必须区分 turn 完成状态与 Token 通知的记录逻辑。本轮没有重跑合成测试，没有运行 Compaction/Resume/多 Agent，也没有执行模型请求重试。

## P0：Codex Rollout 与 Magpie Usage 数据源比较（2026-10-30）

任务：`CODEX_TOKEN_SOURCE_COMPARISON_P0_20261030`

本轮仅读取已有数据，没有发起新模型请求，没有修改 Desktop、Magpie、生产 JSON/SQLite、Worker 或调度。证据中的 Thread ID、Session ID 和 Request ID 均以短哈希或掩码保存，不保存会话正文、用户提示词、模型输出、凭据或项目敏感路径。

### P0-A：Codex Rollout

当前有效 Codex Home 来自默认用户级 Codex Home，`CODEX_HOME` 未显式设置。探针只检查该目录下的 `sessions` 与 `archived_sessions`，没有扫描其他磁盘目录。当前主 Thread 的 Rollout 文件名、`session_meta.id`、`session_id` 和调用方明确给出的 Thread ID 完全一致；元数据同时显示：

- `thread_source=user`
- `parent_thread_id=null`
- `originator=Codex Desktop`
- `source=vscode`
- CLI `0.166.0-alpha.5.1`
- Provider `magpie`
- 当前主 Thread 模型 `codex/gpt-6-luna`

因此主 Thread 身份来自三重 ID 一致与主/子 Thread 元数据，而不是文件修改时间推断。脱敏文件标识为 `rollout#02313287e439`。证据观察时间固定为 `2026-10-30T14:32:54.787Z`。

| 样本 | 角色 | TokenCount 条数 | Compaction 标记 | 最新 `total.totalTokens` | 最新 `last.totalTokens` | `modelContextWindow` |
|---|---|---:|---:|---:|---:|---:|
| `rollout#02313287e439` | 当前主 Thread，短时活动会话 | 262 | 1 | 37,786,457 | 204,979 | 258,400 |
| `rollout#16cdaab7b857` | 普通短会话 | 21 | 0 | 2,195,276 | 133,440 | 475,000 |
| `rollout#d8dfa555c08e` | 多轮、多 Provider 历史会话 | 678 | 5 | 102,624,400 | 146,053 | 258,400 |

三份文件在采样时均以换行结束，未发现无效 JSON 行，读取前后大小和 mtime 未变化。当前主 Thread 文件仍可能继续增长，因此上述“读取稳定”只表示该次快照内稳定，不是长期无锁保证。多个 TokenCount 快照会出现重复，`total` 在这些样本中未下降。

Compaction 可以从 Rollout 的 `compacted` 标记及相邻 `token_count` 事件直接观察：

- 当前 Thread：压缩前 `total=30,394,698, last=248,300`；压缩后 `total` 保持 `30,394,698`，`last=39,475`。
- 历史 Thread 四次可比较压缩样本均保持 `total` 不变，`last` 从约 `226k–245k` 降至约 `25k–34k`。

这支持“`total` 是 Thread 累计统计，`last` 更接近最新上下文采样”的接入判断，但不把 `last / modelContextWindow` 宣称为精确上下文百分比。样本中没有明确 Resume/replay 事件标记；Rollout 文件可在后续独立读取这一点成立，但“Resume 后原进程自动恢复哪一快照”仍未专项验证，故 Resume 结论为 `PARTIAL`。

### P0-A 只读读取器

新增 `src/observability/codex-rollout-token-source.ts`。接口要求调用方同时给出：

- 明确的 `codexHome`
- 明确的 Rollout 文件
- 预期主 Thread ID

读取器只在显式 Codex Home 的 `sessions` 或 `archived_sessions` 下接受文件；校验文件名、`session_meta.id/session_id`、`thread_source=user`、`parent_thread_id=null`。身份不匹配、文件在读取中变化或出现子 Thread 元数据时关闭失败，不返回可误用的 Token 快照。它按文件顺序选择最后一条有效绝对 TokenCount，未知字段保留 `null`，忽略空 `info`、无效行和末尾未完成 JSONL 行，不监听、不扫描、不写入原始 Session 或生产存储。

专项测试位于 `test/codex-rollout-token-source.test.ts`，本轮实际运行 5 项，5 PASS、0 FAIL。覆盖最新快照、未知字段、部分行、空 usage、主/子 Thread 身份失败和 Codex Home 边界。先前已通过的 16 项 App Server Token 合成测试没有重复运行。

除 fixture 测试外，同一读取器随后对当前真实主 Thread 执行了一次完整只读调用：状态 `ok`，读取 2,515 行、339 条 TokenCount、2 个 Compaction 标记，读取前后未变化；最新快照为 `total=43,957,702`、`last=114,153`、`modelContextWindow=258,400`，时间为 `2026-10-30T15:56:37.899Z`。脱敏结果保存在 `.evidence/rollout-reader-real-thread.json`。该文件在任务继续期间仍可能增长，报告中的早期采样表与这次读取是两个不同时间点。

### P0-B：Magpie Usage

本机 Magpie 为 `0.1.1333`，安装可执行文件与 `/v1` 返回值一致；官方同版本 tag `v0.1.1333` 的源码提交为 `db48697d67ab3b67ec3bedee058329d5d36c9294`。只读检查确认当前版本注册：

- `GET /v1/magpie/usage`
- `GET /v1/magpie/usage/requests`

两个接口从 loopback 返回 HTTP 200，无需新增凭据。探针没有读取或保存 API Key、Bearer、Cookie 或其他凭据；没有调用 POST。`/usage/requests` 必须先用 `q=<threadId>` 过滤并读取全部分页，未过滤的第一页不能作为该 Thread 的完整数据。

实际记录包含请求时间、Provider、Model、Session、Request ID、input、output、cache read、cache write、reasoning、cost、status 和 route ID。当前三个样本的记录均能通过明确 Session ID 过滤且未混入其他 Session。当前主 Thread 的 295 条记录中，270 条 HTTP 200、1 条 499、24 条 502；普通会话 21 条全部 200；历史混合会话 903 条中 858 条 200，另有 429/499/502 记录。

这些值由 Magpie Gateway ledger 提供；`route_id` 存在时可确认记录来源是 Magpie 请求层，`source=log` 时则指向 Codex Session Reader。仅凭当前 API 字段不能证明每个数值都直接来自上游 Provider 原生 usage，而不是 Magpie 归一化后的值，故与 Rollout 匹配的部分只能证明两边数值一致，不证明 Magpie 是独立计量源。

### P0-C：数值和关联比较

比较前统一统计范围：Rollout 的 `total_tokens = input_tokens + output_tokens`，其中 `input_tokens` 已包含 cached input；Magpie 的对应请求级总量按 `input + cache_read + output` 汇总。reasoning 是 output 的子字段，不重复相加。不同观察时间、重试、失败请求和混合 Provider 不在无可比基准时强行计算误差率。

可靠结果如下：

- 普通短会话：Rollout 最新累计 `2,195,276`；Magpie 21 条成功请求为 input `121,934` + cached `2,062,336` + output `11,006` = `2,195,276`，reasoning 两边均为 `3,232`。逐字段累计精确一致。
- 当前主 Thread：取 Rollout 采样时点之前的 261 条成功 Gateway 记录，其中 260 条可用 input/cache/output tuple 找到对应 Rollout `last_token_usage`；Magpie 汇总为 `37,992,495`，Rollout 同时点最新累计为 `37,786,457`。两次采集间 Thread 继续活动，只报告差异与时间窗口，不计算精确误差率。
- 混合 Provider 历史会话：858 条成功 Magpie 记录中有 646 条能在 678 条 Rollout TokenCount 中找到 input/cache/output tuple，但只有 92 条 Rollout TokenCount 出现在 Magpie 查询结果中。该 Thread 跨多个 Provider/Model，Magpie 不能重建整份 Rollout 累计值，二者不能直接替代。

| 维度 | Codex Rollout | Magpie Usage |
|---|---|---|
| 是否包含真实主 Thread | `PASS`。明确 Thread ID 与 metadata、文件名一致 | `PARTIAL`。可读取已有请求，但只能覆盖经过 Magpie 的部分 |
| Token 数据完整性 | `PASS`。绝对快照含 total/last/context window | `PARTIAL`。请求级字段完整，但没有上下文窗口或直接的主 Thread 累计快照 |
| 输入 Token | 有，含 cached 的输入总量 | 有；`input + cache_read` 才对应 Rollout input |
| 缓存 Token | 有 `cached_input_tokens`；实际样本 `cache_write_input_tokens=0` | 有 `cache_read/cache_write` |
| 输出 Token | 有 | 有 |
| 推理 Token | 有，属于 output 子字段 | 有；部分旧记录为 null |
| 当前上下文信息 | 有 `last` 和 `modelContextWindow` | 无 |
| Compaction 可观察性 | 有 `compacted` 和前后绝对快照 | 无可证明的上下文压缩快照 |
| Resume 后连续性 | Rollout 文件持久；进程 Replay 仍须专项验证 | 按历史 Session ID 可查询，但不能恢复上下文字段 |
| Thread ID 关联 | 文件、metadata 与显式 Thread ID 可交叉校验 | `q` 和 Session ID 可关联，但只覆盖网关样本 |
| 更新时效 | 文件追加后可再次只读读取；本轮未做尾随监听 | 请求完成后进入网关记录；本轮只做快照 |
| 是否依赖额外服务 | 否，只读本地 Codex Home | 是，依赖本机 Magpie 服务与端口 |
| 读取权限与风险 | 本地文件可读即可；需防错误 Thread 归属和活动文件变化 | 需要 loopback 服务可访问；数据可能包含跨 Provider 噪声和失败请求 |
| 适合生产接入程度 | 高，限定于明确 Thread ID 与路径后的首选源 | 低到中，只宜作对照、成本或请求级补充 |

### P0-D：结论

| 验收项 | 状态 | 说明 |
|---|---|---|
| `ROLLOUT_SOURCE_FOUND` | `PASS` | 通过默认 Codex Home 的 session storage 找到真实 Rollout |
| `MAIN_THREAD_IDENTITY` | `PASS` | 文件名、`session_meta.id`、`session_id` 与显式 Thread ID 完全一致 |
| `REAL_TOKEN_COUNT_FOUND` | `PASS` | 三个真实主 Thread 共观察到 961 条有效 TokenCount |
| `ROLLOUT_READ_STABILITY` | `PARTIAL` | 快照稳定、空值和部分行可处理；活动文件的长期增量尾读、旋转和并发追加尚未实现 |
| `MAGPIE_USAGE_API` | `PASS` | 同版本两个 GET 接口可用且无需新凭据 |
| `MAGPIE_REQUEST_MATCHING` | `PARTIAL` | 明确 Session 可过滤；活动 Thread 大部分请求 tuple 可匹配；混合 Provider Thread 不能重建完整累计 |
| `TOKEN_COMPARISON` | `PARTIAL` | 普通短会话累计精确一致；活动与混合 Provider 样本缺少同一时点/同一覆盖范围，只做趋势和 tuple 匹配 |
| `ROLLOUT_READER_IMPLEMENTATION` | `PASS` | 隔离只读读取器及 5 项专项测试通过 |

**`PREFERRED_SOURCE=CODEX_ROLLOUT`。** 晋升范围是“调用方已掌握明确主 Thread ID 和对应 Rollout 路径时，使用 Codex 原生 Rollout 的绝对快照”。它比 Magpie 更接近上下文事实，包含 `last`、窗口和 Compaction 证据，且不依赖额外服务。

当前最小缺口有两个：

1. 可靠的 Thread ID 到 Rollout 路径映射。本轮证明给定 ID 后可以校验并读取，但读取器刻意不做全盘扫描，尚未实现自动发现当前主 Thread。
2. 面向持续活动大文件的只读增量尾部读取。本轮读取器重新读取整个指定文件，并在读取前后检测变化；没有实现 tail checkpoint、文件旋转处理或长期监听。

因此 Codex Rollout 足以作为首选事实源，但还不能单独宣称 Bridge 已能自动、持续观察任意当前 Desktop 主 Thread。Magpie 不应成为 Thread 上下文用量的生产依赖；它只适合作为无模型副作用的研究对照或请求级成本补充。

### P0 验证命令

本轮实际执行：

- `npm run typecheck`：PASS。
- `npm run build:test`：PASS。
- `node --test dist-test/test/codex-rollout-token-source.test.js`：5/5 PASS。
- `npm run build`：PASS；Windows 构建写出的既有生成文件仅出现换行状态噪声，已恢复到候选 HEAD 内容，未纳入本轮候选修改。
- `npm run validate:plugin`：PASS。
- 两个 P0 探针 `node --check`：PASS。
- 全部 `.evidence` JSON 可解析。
- tracked diff whitespace check 与全部未跟踪候选文本的 no-index whitespace check：PASS。

本轮没有重跑 600 秒级 `npm test`，因为只新增隔离观察文件和显式路径读取器，没有接入 `src/host/stdio.ts`、生产 JSON/SQLite、Worker、任务调度或清理路径。先前全量回归仍是本 Worktree 的既有证据，不能由本轮专项测试结果替代。

## P1：Rollout Reader 路径发现与增量尾读（2026-10-31）

架构决策固定为 `PREFERRED_SOURCE=CODEX_ROLLOUT`。Magpie 对比研究结束，不接入生产；App Server 通知实验只保留历史证据。本节只完成 Bridge 只读接线前的 Reader 能力，不修改生产调度、存储或宿主接入。

### Thread ID → Rollout 路径发现

新增 `discoverCodexRolloutByThreadId()`。调用方必须显式提供已验证 Codex Home 与 Thread ID；发现器只递归检查：

- `<codexHome>/sessions`
- `<codexHome>/archived_sessions`

它拒绝目录或文件 symbolic link，不扫描用户配置、项目目录或其他磁盘路径。文件名必须符合 `rollout-*.jsonl` 且以 `-<threadId>.jsonl` 结束，随后还必须通过第一行 `session_meta` 校验：

- `id === expectedThreadId`
- `session_id` 缺失或等于预期 ID
- `parent_thread_id === null`
- `thread_source === "user"`

发现器不按 mtime 排序或选择“最新”文件。两个目录中存在多个身份有效匹配时返回 `ambiguous`；只有文件名匹配但 metadata 不符时返回 `identity_unverified`；完全不匹配时返回 `not_found`。子 Agent Rollout 因存在 `parent_thread_id` 被拒绝。

### 增量 Tail Reader

`CodexRolloutTailReader` 按调用实例保存以下只读状态，不写 JSON/SQLite：

- Thread ID 与脱敏文件 ID
- `device/inode/birthtime` 文件身份
- 已读取字节 offset
- 未完成行字节数
- 最后有效绝对 TokenCount 快照

每次轮询只读取 `offset` 之后的新字节。完整 JSONL 行才进入解析器；UTF-8 多字节序列可以跨物理读取块，未完成的最后一行保留到下一次轮询。相同 `total/last/modelContextWindow` tuple 的重复 TokenCount 不产生第二个更新。有效新快照使用绝对覆盖；`last` 从不累加。`compacted` 标记以及其后的新快照通过 `observedAfterCompaction` 关联。

文件身份变化被视为替换，文件变短被视为截断，二者都会清空旧 offset/快照并从已验证文件头重建。Reader 还对 offset 之前的 4 KiB 边界计算指纹，因此同一 inode 原地截断后重新增长到超过旧 offset 的情况也会被发现并从文件头恢复。文件短暂缺失返回 `file_changed`，下一次轮询可重新打开。任何 Thread 或子 Agent metadata 不匹配都会清空旧快照并返回 `identity_unverified`。新 Reader 实例从文件开头恢复最新有效快照，不携带其他 Thread 的状态。

Reader 不计算上下文百分比。真实样本的 `last=166,318` 与窗口 `258,400` 只作为两个原始观测值保留；Compaction 后仍以服务端新绝对快照为准。

### 真实活动 Rollout 追加测试

本轮使用当前 Codex Desktop 主 Thread 的明确 ID 执行发现与只读尾读，没有发送模型请求。脱敏证据见 `.evidence/rollout-tail-live-evidence.json`：

- 发现结果：`found`
- 文件名候选：1
- 身份验证文件：1
- Thread 来源：`user`
- `parent_thread_id=null`
- 文件 ID：`rollout#02313287e439`
- 初态 offset：`7,349,999`
- 新追加：1,253 bytes
- 新 offset：`7,351,252`
- 新增 TokenCount：1
- 新事件序号：402
- `total.totalTokens`：`53,737,007 → 53,925,212`
- `last.totalTokens`：`187,845 → 188,205`
- `modelContextWindow`：`258,400`
- 新事件时间：`2026-10-30T16:32:14.829Z`（Asia/Shanghai 为 2026-10-31）
- 轮询次数：10

该追加由当前活动 Desktop 会话自然产生，探针自身没有触发模型请求。它证明独立 Reader 能在不接触 App Server pipe 的情况下观察到主 Thread 的新绝对 TokenCount。

### P1 验收

| 验收项 | 状态 | 证据 / 边界 |
|---|---|---|
| `THREAD_PATH_DISCOVERY` | `PASS` | 官方 Session 目录内显式 Thread ID 发现；真实 Desktop Thread 唯一匹配 |
| `INCREMENTAL_TAIL_READER` | `PASS` | 保存内存 offset/文件身份/最后快照；新增专项测试覆盖追加、去重、UTF-8、半行和 Compaction |
| `LIVE_APPEND_TEST` | `PASS` | 真实活动 Rollout 自然追加 1,253 bytes，并取得下一 TokenCount |
| `FILE_ROTATION_RECOVERY` | `PASS_SYNTHETIC` | 截断、删除后重开、文件替换与 Reader 重新打开的测试通过；没有在真实 Desktop 中制造旋转 |
| `THREAD_ID_PROVENANCE` | `PASS_FOR_EXPLICIT_ID` | Thread ID 来自当前宿主上下文并由文件名 + metadata 双重校验；Reader 不从 mtime 猜测当前 Thread，也不自行取得当前 ID |

专项测试文件为 `test/codex-rollout-token-tail.test.ts`。本轮与既有 P0 Reader 测试合并运行：

- 13 项测试，13 PASS，0 FAIL。
- `npm run typecheck`：PASS。
- `npm run build:test`：PASS。
- `npm run build:core`：PASS。
- `npm run build`：PASS；Windows 构建写出的既有生成文件只出现换行状态噪声，已恢复到候选 HEAD，未纳入 P1 修改。
- `npm run validate:plugin`：PASS。
- 活动追加探针 `node --check`、证据 JSON 解析、脱敏检查与候选 no-index whitespace check：PASS。

### 进入 Bridge 只读接线的判断

Reader 已达到 **`READY_FOR_BRIDGE_READONLY_WIRING_WITH_EXPLICIT_THREAD_ID`**。可以进入设计阶段，把“明确 Thread ID → 官方 Rollout → 增量绝对快照”作为只读数据源。

剩余缺口：

1. 当前主 Thread ID 的可信来源。Reader 能验证给定 ID，但当前 Desktop 宿主如何把活动 Thread ID 交给 Bridge 尚未形成生产合同。
2. Tail checkpoint 只保存在内存。进程重启后重新扫描文件可以得到最新快照，但若要跨重启精确续传 offset 或避免下游重复消费，需要另行设计隔离 checkpoint。
3. 真实 Desktop 的文件旋转尚未发生。截断/替换/短暂缺失已由合成测试覆盖，生产环境旋转概率和命名规则仍需后续观察。
4. 初始打开仍从头扫描整个 JSONL。当前约 7.1 MB 文件可接受；更大文件若需要低延迟启动，应增加有界尾部索引或合法 checkpoint，而不是本轮直接扩大到全盘扫描/监听服务。
5. 子 Agent 的独立真实 Rollout 本轮没有新增测试条件。Reader 已按 `parent_thread_id` 拒绝子 Agent 冒充主 Thread，但若未来需要展示子 Agent 自身用量，应显式支持独立 child Thread 身份，而不是将其归入主 Thread。

因此本轮结论为：主 Thread Rollout 的路径身份和增量读取能力已达到只读接线门槛；自动取得当前 Desktop Thread ID 与持久 checkpoint 仍属于生产接线前的剩余设计项。

## Bridge 只读接线：Master Skill 现有 Token 字段

### 既有字段与原缺口

现有报告结构没有独立的“Master usage”子结构，只有以下既有位置：

- `plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md` 的“任务总览”固定行 `Codex 主会话 token`。
- `src/feedback/template.ts` 的 `FeedbackInput.codex_tokens`（仅 `state` 与 `note`）和同名表格行。

原先的根因不是 Rollout 缺数据，而是组装链路从未填充该可选字段：Skill 明确要求固定写“未取得：当前宿主未提供本次调用统计”，`feedbackInputFromRecord()` 不接收 Thread ID，也没有读取 Rollout。ZCode `usage` 属于另一字段，不能挪用。

该字段原注释把语义定义为 per-turn/本次调用统计。因此本轮没有把 Thread 累计 `total` 或最近 `last` 冒充单轮消耗；只有调用方保存了报告窗口起点时，才用同一 Thread 前后两次绝对 `total` 的差作为窗口累计。`last` 只保留为“最近采样”，且不累加。

### 接入路径

1. Master 从当前 Codex shell 的非敏感 `CODEX_THREAD_ID` 取得显式 Thread ID；缺失时返回 `thread_id_missing`，不按 mtime 扫描活动会话。
2. `CodexMasterTokenUsageSource` 在有效 Codex Home 的官方 `sessions`/`archived_sessions` 内复用 `discoverCodexRolloutByThreadId()` 的文件名与 metadata 双重身份校验。
3. 同一 Thread 的连续查询复用 `CodexRolloutTailReader`；进程重启后重新扫描并恢复最新绝对快照，不持久化 offset。
4. 数据只读映射到既有 `codex_tokens` 字段。缺少起点时在该字段中只显示“未取得”；有起点时才产生 `absolute_total_delta`，并以千位分隔的单个整数渲染。来源、身份校验状态、原始 `last`、上下文窗口和观测时间只保留在查询结果或调试证据中。
5. `plugins/codex-zcode-bridge/skills/zcode-bridge/scripts/codex-master-token-usage.mjs` 是构建出的只读命令，不是 MCP 工具；它不调用模型、不读取认证凭据、不输出 Rollout 路径或会话正文。

容错状态保持分离：`thread_id_missing`、`rollout_not_found`、`thread_identity_unverified`、`rollout_ambiguous`、`no_token_count`、`file_changed`、`source_unavailable`。子 Agent 的 `parent_thread_id` 非空时继续 fail closed，不归入主 Thread。

### 真实报告输出验证

当前宿主 shell 在真实执行中提供了 `CODEX_THREAD_ID`；查询得到的脱敏 Thread 引用为 `thread#aac0f15a0faa`，与既有当前主 Thread 证据一致。两次真实查询之间没有由探针发起模型请求，自然追加后的结果为：

| 时间点 | Thread `total.totalTokens` | `last.totalTokens` | `modelContextWindow` |
|---|---:|---:|---:|
| 报告窗口起点 | 59,912,094 | 205,561 | 258,400 |
| final 查询 | 65,039,309 | 240,425 | 258,400 |

使用本日真实读取和此前保存的合法 baseline 复验精简规则：

| baseline | 当前 `total.totalTokens` | 报告字段 |
|---:|---:|---:|
| 59,912,094 | 68,007,579 | `8,095,485` |

实际查询结果中的 `feedback_codex_tokens.state` 为 `reported`，`note` 为 `8,095,485`。不提供 baseline 的同一真实 Thread 查询得到 `state: unavailable` 与 `note: 未取得`。对应脱敏证据保存在 `.evidence/master-token-compact-output.json` 与 `.evidence/master-token-compact-no-baseline.json`。

计算仍使用同一 Thread 的结束 `total.totalTokens` 减去委派开始时保存的 baseline；输入、缓存、输出、推理、最近采样、上下文窗口、来源和观测时间只保留在查询 JSON 与调试证据中。历史证据保存在 `.evidence/master-token-skill-baseline.json` 与 `.evidence/master-token-skill-final.json`，其原有详细 `note` 未改写。该窗口只覆盖两次采样之间、报告生成前已经发生的模型响应；最终回复自身发生在 `observedAt` 之后，不计入。

### 验证与边界

- `test/codex-master-token-usage.test.ts` 新增 5 项专项覆盖：未绑定、显式 Thread 增量更新、错误/子 Agent 身份、无 TokenCount、文件暂时缺失恢复、重启重扫、无基线不冒充单轮消耗。
- 与既有 Rollout source/tail 和 feedback template 合并定向运行：29/29 PASS。
- MCP server/stdio 定向回归：22/22 PASS；默认 MCP 工具仍为 13 个，没有新增工具。
- `npm run typecheck`、`npm run build`、`npm run validate:plugin` PASS；完整长时间性能回归与全仓 `npm test` 本轮未重跑。
- Worker Token 来源、计算和显示未修改；未写 JSON/SQLite，未改 Desktop 配置，未读取认证凭据，未调用模型。
- 当前 Desktop 可用 `CODEX_THREAD_ID`，但跨版本是否持续提供仍需宿主兼容验证。若缺失，只能显示明确不可用状态。

本接入候选已达到进入 Owner 审查的 `READY_FOR_PROMOTION`：真实主 Thread 数据可读、现有报告字段可填充、单轮口径有显式窗口边界，且无生产状态或 Worker 路径改动。合并前仍需 Owner 接受“由 Master 在委派开始前保存 baseline”的执行约定。
