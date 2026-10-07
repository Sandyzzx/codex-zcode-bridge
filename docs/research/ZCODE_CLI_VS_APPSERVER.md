# ZCode Native CLI 与 app-server 深度审计

研究日期：2026-10-05。结论适用于下述版本和实验范围，不构成对其他安装版本的保证。

## 结论

**两条入口共享 Agent Core；决定实际行为的是 Host 的 materialization、配置、能力端口和生命周期管理。** 本次没有证明 Native CLI 普遍更省 Token、代码质量更高或进程控制更可靠。5 类真实模型执行的隔离编码任务，两边各完成 5 次，独立验收均通过；观察组 app-server 总 Token 比 Native 少 6.65%，但两边 Memory 配置不同，因此不是严格的执行器因果比较。

双向、跨进程的**顺序** Session Handoff 已成功。正在运行的 CLI 会话能被另一 app-server 列出，但该 app-server 的 `read` 和 `stop` 返回未激活错误。没有证据支持安全跨 Host 并发接管。

架构建议为 **GO WITH CONDITIONS**：可以引入双 Executor 的实验实现与顺序交接；目前维持已有 app-server 默认。Native CLI 是否应成为默认 Coding Executor，证据不足，应通过配置对齐后的扩展任务验证决定。详见 [架构建议](ZCODE_EXECUTOR_ARCHITECTURE_RECOMMENDATION.md)。

## 版本与证据边界

| 项目 | 本次记录 |
|---|---|
| Bridge 工作区 | `C:/Users/Sandy/.codex/worktrees/f7bc/codex-zcode-bridge` |
| Bridge 基线 | `2596759198fa826c2b7ac0478c5682da996e9727`，package 1.0.5 |
| 研究分支 | `codex/research-native-cli-appserver-20261005` |
| 官方源码 | [zai-org/ZCode 固定提交](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e)，`29628c9acdb81b703bbd4080c207a0e7ce5e276e` |
| 本机执行文件 | `C:/Users/Sandy/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs`，CLI 0.16.9 |
| Node | 24.16.0，Windows |
| 模型 / Provider | `GLM-5.3-Flash` / `account:bigmodel-individual-coding-plan` |
| 编码实验 | low、yolo；工具限制为 Bash/Edit/Read/Write |
| 身份、存储 | 同一授权账户；复制到专用临时配置及加密凭据目录，独立 SQLite；未修改真实用户配置 |

**UNKNOWN：公开源码提交与已安装 0.16.9 的完整构建对应关系。** 发现了明确差异：公开 `runPrompt` 源码默认关闭动态 Workflow；安装版未经规范化的 CLI 请求却注册了 Workflow 工具。下文 SOURCE 结论指固定源码，RUNTIME 结论指实测安装版，不能互相替代。

证据标签：`CONFIRMED — SOURCE` = 已定位的源代码事实；`CONFIRMED — RUNTIME` = 本次实机证明；`SUPPORTED` = 源码和实验支持、尚非完整证明；`HYPOTHESIS` = 待验证解释；`UNKNOWN` = 不确定。未执行的危险或范围外操作写 `NOT RUN`。

## Q1–Q8 对照

| 问题 | 结果与证据强度 |
|---|---|
| Q1 共享 Core？ | **CONFIRMED — SOURCE**：两边 `createZCodeApp` 创建 `AgentRuntime`，经不同输入 facade 汇合于 `executeTurn`，使用相同 turn loop / model runner。见 [调用链](ZCODE_RUNTIME_CALLCHAIN.md)。 |
| Q2 System Prompt 一致？ | **CONFIRMED — RUNTIME**：默认观察组不一致；Memory 对齐后，同 cwd 同请求的 System Prompt 哈希可以一致。即使 System 相同，meta user context 仍可能不同，不能宣称整个 request 等价。 |
| Q3 Tools 一致？ | **CONFIRMED — RUNTIME**：自然配置 CLI 28 个、app-server 22 个，分别含 Workflow / Cron 特有工具；规范化到 4 工具后 schema 哈希相同。注册表相同也不意味着权限、浏览器端口、MCP 或实际可执行性相同。 |
| Q4 Reasoning 等价？ | **CONFIRMED — RUNTIME**：low/high/max 均映射到 `thinking.type=enabled` 和对应 `output_config.effort`；实际 body 中 model 相同。Catalog 默认 max 不等于已配置会话默认，本次明确指定 low。无显式选择的真实用户默认行为未覆盖。 |
| Q5 Memory 额外调用？ | **CONFIRMED — SOURCE**：use 与 extraction 独立，成功 main turn 后可触发额外 `project_memory_extract`；CLI 默认 extraction=false，Bridge preferences 直接关闭 Memory。小型开启探针未观察到抽取请求，不能证明抽取永远不发生。 |
| Q6 Subagent 策略？ | **CONFIRMED — SOURCE**：共享 subagent runner，背景执行受 profile、runInBackground、autoBackgroundMs 和模型选择覆盖控制。没有两入口必然不同的默认模型证据。编码组禁止 Agent 等工具，app-server 查询子会话为空；未做允许后台 subagent 的配对性能实验。 |
| Q7 Permission 造成 replanning？ | **CONFIRMED — RUNTIME**：build 模式 CLI Write 被拒绝；app-server 有 Host 往返并允许指定实验文件。两边均 2 个 model requests，本探针没有证明拒绝增加 request 数。 |
| Q8 Task Terminal 相同？ | **CONFIRMED — SOURCE**：CLI 有 Workflow settle 和可选 Memory drain；Bridge 以一个 `turn.completed` 收口 prompt，随后 checkpoint / cleanup。**SUPPORTED**：开启背景能力时，仅首个 turn terminal 不足以定义完整 Task 完成；完整 Workflow 实机结算 NOT RUN。 |

## Context 与模型执行

Context builder 共同组织 stable identity、动态行为、session guidance、Memory、环境信息、skills、workspace instructions。AGENTS、skills/MCP、custom commands 与 mid-conversation system 都有配置入口；共同 builder 只能证明处理机制共享，不能证明输入配置相同。Browser 一边可注入 CLI headless runtime，另一边可转发 Host browser interaction。见 [源码索引](ZCODE_RUNTIME_CALLCHAIN.md#context与能力注入)。

实际请求摘要只保留 model、thinking/effort、工具名、System / message 哈希和长度、usage；未保存 headers、API key、原始请求或隐藏推理。reasoning 探针中工具 schema SHA-256 均为 `477fe506ecaa4167913c555851f18d94879e91902491fe79081dc262105afd35`。

观察组 Native 的 system_prompt 为 9,058 字符，app-server 为 6,899；首次 input 每任务 Native 多 504 tokens。Memory 同时开启的探针，两边 System 哈希同为 `de8af4f2c9058feebfd5d498d271c787bc5e2b845f6cb4ba835dad4dee2a6ce7`，但 meta user context 摘要长度仍不同。补充关闭两边 Memory 的 10 次运行，System 哈希均为 `356698f8c09a223757c95d26f7aa1505d66e15d032486eaec1d85f75fe0c320c`；因网络故障没有成功完成的配对编码结果。

Provider Registry 是两边都有的初始化组件，不能简化为“CLI 有 provider、app-server 没有”。Bridge 需要正确处理 account snapshot、builtin revision、模型 ID 映射和 runtime auth。最初使用真实配置路径的 smoke，app-server 成功、CLI resume 后没有有效默认模型；在**临时副本**补齐 default selection 与官方加密凭据后同会话顺序执行成功。这证明配置完整性会影响观测，不能归因于 Agent Core 缺陷。

## 实验覆盖与不确定项

已完成：源码路径复核、真实 Flash 源码研究 worker、5 类任务 × 2 Executor 的成功观察组、另一组 10 次 Memory 对齐但失败的执行、6 次 reasoning 探针、build 权限探针、Memory 开启探针、A/B 顺序 Handoff、C 运行中只读探针、两种实际 ZCode 进程取消、Windows Job Object 专用 helper 树实验。

未覆盖：官方 Desktop 实际启动及其 preferences；完整 MCP/浏览器/skills/custom command 等价 A/B；允许 subagent / Workflow 的负载；项目 Memory 已存在内容的完整跨端恢复；真实 ZCode Job Object 集成；Windows 控制台 Ctrl+C/Ctrl+Break；CPU 与峰值内存；重复种子、统计显著性或计费金额。对这些结论不确定。

研究任务最初通过已安装 Bridge 提交，但排队未启动，已取消，不能记为运行成功；随后直接使用同一安装版 stdio app-server 完成授权源码任务和探针。独立审查与验收由 Codex 完成，worker completed 不等于接受。没有修改生产 Executor、默认值或公共协议，没有提交、推送、发布。

## 交付索引

- [实际调用链与固定源码引用](ZCODE_RUNTIME_CALLCHAIN.md)
- [Session 顺序交接、并发控制边界](ZCODE_SESSION_HANDOFF.md)
- [Benchmark、质量验收、Token 拆分与失败组](ZCODE_EXECUTOR_BENCHMARK.md)
- [架构决策、进程管理与下一步门槛](ZCODE_EXECUTOR_ARCHITECTURE_RECOMMENDATION.md)
- [可复核证据与实验操作说明](experiments/README.md)

