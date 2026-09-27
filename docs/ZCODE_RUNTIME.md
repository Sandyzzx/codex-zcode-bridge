# ZCode Runtime 验证

最近复核日期：2026-09-26（Asia/Shanghai），本机 Windows x64。本版本取代同日较早的记录：provider 配置阻塞已找到根因和受支持的修复方式，真实 headless smoke task 及 `--resume` 已通过。除标记为其他状态的事项外，下文均在当时的验证过程中检查。

状态标签：

- **已验证（VERIFIED）** — 本机复现，并有命令输出、文件证据或 minified 源码检查记录。
- **推测（ASSUMED）** — 根据代码或参考资料判断合理，但未完成端到端验证。
- **不支持（UNSUPPORTED）** — 已确认本机安装不存在或不可用。
- **未验证（NOT VERIFIED）** — 未测试，结果未知；Bridge 不得依赖这些行为。

## 环境信息（已验证）

| 项目 | 结果 | 证据 |
|---|---|---|
| ZCode Desktop | **3.14.3.7762**，路径位于当前用户本地程序目录 | `(Get-Item '...\ZCode.exe').VersionInfo` |
| Runtime CLI | **zcode 0.16.9** | `node <zcode.cjs> version` |
| Runtime 入口 | `<ZCode 安装目录>\resources\glm\zcode.cjs`（14.8 MB） | 文件列表 |
| Node | **v24.16.0**，路径 `C:\Program Files\nodejs\node.exe` | `node --version`、`where node` |
| doctor | `node: v24.16.0`、`platform: win32/x64`、`sea: no (optional)`、`default artifact: node-bundle` | `node <zcode.cjs> doctor` |
| Desktop 数据基目录 | Desktop 安装可配置的数据目录；另有用户目录下的 `.zcode` | Desktop 启动进程继承的环境变量 |
| CLI 帮助参数 | `--prompt/-p`、`--json`、`--mode <build\|edit\|plan\|yolo>`（`--prompt` 默认 `yolo`）、`--cwd`、`--resume <sessionId>`（`sess_...`）、`-c/--continue`、`--target`、`--target-replace`、`--attach`、`--surface`、`--browser-use`、`--disallowed-tools`、`--verbose`、`--no-browser`、`--no-color` | `node <zcode.cjs> --help` |
| 随包提供的 provider 配置 | `<ZCode 安装目录>\resources\config\provider\zcode-builtin.json` 存在；顶层 key 为 `schemaVersion`、`revision`、`config`（未输出配置值） | 文件列表和 key 名称 |

### 文档声明与实际生效情况

| 参数 | 帮助中列出 | 成功任务中实际验证 |
|---|---|---|
| `--prompt` | 是 | **已验证**（所有 smoke run） |
| `--json` | 是 | **已验证**（stdout 为单个 JSON 对象，见下文 schema） |
| `--mode yolo` | 是 | **已验证**：接受此参数并能在 smoke task 中自主写文件；未单独探测逐工具权限语义 |
| `--cwd` | 是 | **已验证**：驱动程序从其他 cwd 启动时，Agent 仍在 `--cwd` 指定工作区创建文件；通过独立目录列表确认 |
| `--resume <sessionId>` | 是 | **已验证**（见 Resume 部分） |
| `-c/--continue` | 是 | 未验证（未运行） |
| `--target`、`--attach`、`--surface`、`--browser-use`、`--disallowed-tools`、`--memory-bench`、`--verbose` | 是（`--verbose` 曾在一次成功运行中使用，未破坏 JSON 输出） | 其余均未验证 |

## 早期 headless 失败的根因（已验证）

可确定复现：从子进程环境中移除所有 `ZCODE_*` key 后启动 CLI，约 0.8 秒以退出码 1 退出，stdout 为空，stderr 精确为：

```text
无法定位 CLI ZCode Built-in Provider Config：`<ZCode 安装目录>\resources\glm\provider\zcode-builtin.json`、`<用户数据目录>\config\provider\zcode-builtin.json`
```

检查 minified CLI 函数 `resolveBundledZCodeBuiltinProviderConfig`：在非 SEA binary 环境中，CLI 根据入口目录检查两个候选路径：`<entrypoint dir>\provider\zcode-builtin.json`，然后 `resolve(dir, "../../../../../config/provider/zcode-builtin.json")`。从 `...\ZCode\resources\glm` 向上五级的位置与随包配置 `resources\config\provider\zcode-builtin.json` 不一致。本机 Windows 版本已确认同样存在参考 B 在 Linux 说明中记录的路径偏移。两个候选位置在当时的环境都不存在，因此清理过的环境无法启动。

### 受支持的修复：设置环境变量，无需复制文件（已验证）

检查 CLI 启动时调用的 `prepareCliProviderRuntimeEnv`：

- 如果环境中同时设置 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 和 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`，函数会原样返回这两个路径，绕过错误的自动查找。
- Desktop 启动 CLI 时会注入这两个变量（以及其他变量），因此从 Desktop 关联的 shell 启动 headless 任务此前可以正常运行。Bridge 从该环境之外启动时，必须自行设置这两个变量。
- 整个验证过程中没有复制文件，也没有修改 ZCode 安装。之前考虑的“把配置复制到预期路径”没有必要，并且没有执行。

本机验证可用的路径：

- `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` → 随安装提供的 `<ZCode 安装目录>\resources\config\provider\zcode-builtin.json`，或 Desktop 运行目录下的活动副本。两者均已在本机成功运行中验证。
- `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` → **真实且有效**的个人配置文件。指向不存在的文件或 CLI 自动创建的 stub 时，模型创建会失败；指向有效配置后，在瞬时网络问题消退时运行成功。
- 最小可用环境**只需要以上两个变量**，即使移除了其他所有 `ZCODE_*` key 和 proxy 变量，也没有失败（3/3 次及后续运行）。继承完整 Desktop 环境的运行也成功，因此额外变量无害但非必需。

### 瞬时失败模式（已验证其间歇性，原因未验证）

`Error: Bundled 与 Active ZCode Built-in Release 均不可用`（退出码 1、无 stdout）曾在几分钟内连续出现，涉及不同环境配置，也包括完整继承 Desktop 环境；随后停止出现，相同配置之后多次成功。可能与远端 release 刷新不稳定或短时间内连续模型调用触发限流有关，但没有找到根因。因此 Bridge 应区分 provider 配置错误（`无法定位 ... Provider Config`、`Model creation failed`）和可重试错误，并且只对已确认可重试类别进行有限重试。

## Smoke task（已验证）

通过 Node `spawn` 使用 argv 数组、`shell: false`，从系统临时目录下的隔离目录运行：

```text
node <zcode.cjs> --prompt <prompt> --json --mode yolo --cwd <temp workspace>
```

同时设置上述两个 provider 环境变量。Prompt 要求只创建 `bridge-smoke.txt`，文件内容为单行 `ZCODE_HEADLESS_SMOKE_OK`，不得修改其他内容。

观察结果：

- 退出码 **0**，耗时约 6.8 秒，stderr 为空。
- stdout 是**单个可解析的 JSON 对象**，对全部 stdout 执行 JSON parse 成功，没有混入其他行。
- 独立文件检查（不依赖 Agent 自己的报告）确认工作区恰有一个文件 `bridge-smoke.txt`，内容精确为 `ZCODE_HEADLESS_SMOKE_OK\n`。这证明 `--cwd` 生效，且该任务的文件改动在指定工作区内。

### 实测 JSON 结果结构（本机 CLI 0.16.9 已验证；仅适用于该版本观察）

顶层 key 精确为：`sessionId`、`traceId`、`turnId`、`response`（字符串）、`usage`（对象）、`eventCount`（数字）、`projection`（对象）。

- `sessionId` 格式为 `sess_<uuid>`。
- `usage` key：`source`（`"provider"`）、`modelRequestCount`、`inputTokens`、`outputTokens`、`totalTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`、`webFetchRequests`、`webSearchRequests`。
- `projection` key：`status`（`"idle"`）、`turnCount`、`totalTokenCount`、`contextUsed`、`contextWindow`（200000）。
- 配置/启动失败时，进程以退出码 1 退出，stdout **为空**，stderr 是一行普通文本错误。因此 Bridge 只应在退出码 0 时解析 JSON（并继续验证必需字段）；其他情况保留原始 stderr 以供诊断。

## Resume（已验证）

使用 smoke task 返回的 session ID 调用 `--resume sess_c7862fca-...`，其他参数形状相同，且使用相同 `--cwd`：

- 退出码 0；返回的 `sessionId` 与请求值**完全相同**；`traceId` / `turnId` 是新值，符合在同一 session 中开始新 turn 的行为。
- 同一工作区文件独立验证后追加了要求的文本行（原有 `ZCODE_HEADLESS_SMOKE_OK` 后新增 `RESUME_CONTINUATION_OK`）；`usage.cacheReadTokens` 约为 39.8k，说明复用了对话缓存。工作区仍只有一个文件。
- 未测试跨 `--cwd` 的 Resume，属于**未验证**。

## 推测 / 未验证

- 新登录机器（此前未使用 Desktop）是否能仅依赖两个环境变量，以随包 builtin 和 CLI 创建的个人配置运行 headless。CLI 本次自动创建了个人配置 stub，但它无法创建模型；如何修复无效个人配置仍未验证。
- 退出码 0（成功）和 1（目前观察到的配置发现、模型创建、瞬时刷新失败）以外的退出码分类。超时和取消码、Windows 进程树强制终止行为均未验证。
- 长任务行为：smoke task 约 7 秒；流式输出、部分 JSON、stdout 超过管道缓冲区时的表现均未验证。
- 并发 session，以及对同一 session 并发 `--resume`，均未验证。
- `--json` 结构、`usage`、`projection` 或 `sess_` ID 格式会否随 CLI 版本变化，均未验证。上文结构只是版本特定观察，不是契约。
- 网络依赖细节：所有成功的最小环境运行都使用直连网络。代理/防火墙环境下，除已观察到的瞬时刷新错误外，其他行为未验证。

## 不支持 / 本机不可用（已验证）

- PATH 中没有 `zcode` 命令（`where.exe zcode` 无结果）；预检后通过 Node 调用已验证的完整 `zcode.cjs` 路径。
- 此 CLI 的帮助中没有 `--max-turns`（匹配 0 次）；参考 B 的 adapter 使用了该参数，不得传给本机 runtime。
- 不设置两个 provider 环境变量直接调用时，本机版本会在 provider 路径发现阶段稳定失败。
- 无人值守地复制 provider 文件以修复路径并无必要（环境变量已足够），本次也刻意没有这样做。

## 根据本次验证得出的 Bridge 预检要求

1. 解析 Node 和 `zcode.cjs`；Bridge 必须能设置两个 provider 环境变量：builtin 指向已发现安装目录下的 `resources\config\provider\zcode-builtin.json`；personal 必须指向**真实且已存在**的配置（如有 `ZCODE_DATA_BASE_DIR` 则据此解析，否则检查已知数据目录候选路径）。任一文件缺失时，使用独立配置错误快速失败。
2. 使用 argv 数组启动，设置 `shell: false` 和显式子进程 cwd，捕获 stdout/stderr，并设置硬超时；超时行为本身仍需另行验证。
3. 仅在退出码为 0 时解析 stdout JSON，然后要求存在 `sessionId`（并验证格式）才视为任务成功；其他情况保留原始 stdout/stderr。
4. 对 `Bundled 与 Active ... 均不可用` 错误重试；probe/model 创建错误不可重试。
5. 每次 ZCode 升级后重新执行验证，因为路径、环境变量名和 JSON 结构都可能随版本变化。

## 证据与说明

- 临时测试驱动和原始结果日志保存在系统临时目录中；发布版本不包含这些文件。
- 诊断期间，CLI 自行创建了个人 provider 配置 stub，并在 ZCode 数据目录下创建了 session 状态。没有手工修改任何 ZCode 配置，也未登录、注销或升级。诊断期间发起了多次小型模型调用。
- 本文描述的是 2026-09-26 的 runtime 观察，不是跨版本保证。当前工作区已是 Git 仓库并连接远端；本文早期调研时的工作区状态以历史记录为准。
