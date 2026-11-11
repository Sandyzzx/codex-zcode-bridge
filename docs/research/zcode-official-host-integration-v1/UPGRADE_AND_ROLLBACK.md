> Status: RESEARCH
> Date: 2026-11-11
> Bridge baseline: `9710303397fe2d544c75698f783a8174404b2d51` / tree `a9ec733ac02a22b6d27b7cb150abeaae3020569c`
> Observed upstream: ZCode `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d` / `3.18.0`
> Architecture authority: ADR-032 Existing Worker Official Host Integration
> Current state: 设计、隔离构建和 POC 证据；无 OfficialHostAdapter、无 Worker 生产接线、未执行升级或回滚

# G6：上游升级与回滚设计

## 1. 结论

官方 Host 只能以固定源码、固定工具链和 hash-addressed 制品升级。不得把新的官方 checkout 直接覆盖当前运行目录，也不得在启动时解析浮动版本。

```text
UPGRADE_PATH: PINNED_BUILD_AND_CONTRACT_GATES
ROLLBACK_TARGET: EXISTING_ZCODE_APP_SERVER_ADAPTER
ROLLBACK_SCHEMA_CHANGE: NONE
ROLLBACK_TASK_DATABASE_MIGRATION: NONE
KNOWN_GOOD_ARTIFACT_POLICY: HASH_ADDRESSED / IMMUTABLE
CURRENT_PRODUCTION_SWITCH_AUTHORIZED: NO
RAW_FRAME_GUARD: BLOCKED
CLEANUP_PROOF_MAPPING: BLOCKED_FAIL_CLOSED
ACCOUNT_MULTIWORKER: FAIL_SYNTHETIC
UPGRADE_TEST_EXECUTED: NO
ROLLBACK_TEST_EXECUTED: NO
```

本文定义进入实现后必须遵守的升级和回滚程序。它不是已执行的生产 Runbook，也不把任何隔离 POC 结果写成生产切换批准。

## 2. 固定身份

### 2.1 Bridge

| 项 | 固定值 |
|---|---|
| Worktree | `D:\codex-zcode-bridge\.run\official-host-integration-v1-20261111` |
| Branch | `codex/official-host-integration-v1-20261111` |
| Commit | `9710303397fe2d544c75698f783a8174404b2d51` |
| Tree | `a9ec733ac02a22b6d27b7cb150abeaae3020569c` |
| Existing execution mode | `zcode_app_server` |
| Existing adapter source | `src/adapters/zcode-app-server-adapter.ts` |
| Adapter interface | `src/interfaces.ts:181-199` |

本分支没有修改现有 Bridge 生产源码、SQLite、插件 bundle 或运行配置。

### 2.2 Official source

| 项 | 固定值 |
|---|---|
| Source | `D:\codex-zcode-bridge\.run\companion-runtime-validation-20261111\source` |
| Commit | `b95ebaffeab641907b38652f45c1502bd762972d` |
| Tree | `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d` |
| Root version | `3.18.0` |
| AppServer version | `0.17.1` |
| Official Node pin | `24.14.0` |
| Official pnpm pin | `10.33.2` |
| Actual build Node | `v24.16.0` |

Node pin 没有逐项验证为等价。升级门禁必须使用新的精确工具链构建，不能继续把 `24.16.0` 当作官方 pin 的替代。

## 3. 已观测制品身份

### 3.1 ZCode CLI/AppServer

首个构建：

```text
zcode.cjs
bytes: 30,999,438
SHA256: DF4637F2E31AEDE37DB15B3E4E8D8BE35F59BF7564E4EECFFC0A6A6B1EEDB4F2E

zcode.cjs.map
bytes: 57,001,458
SHA256: 205404F621D86A0D2B5A30C0A8F1392C4679133917CFC907F9D17D3F627FE29B
```

独立 clean-install 首次构建：

```text
zcode.cjs
bytes: 30,998,734
SHA256: 5EEEB739E646952D3DD2F1109006C7C0BA56CF2E406B5B8012686C5D1EA3140B

zcode.cjs.map
bytes: 57,001,106
SHA256: 91EB5C8F90E46E1B452DCA32120C849B649633EF3672E538FC33CA51347DFF9A
```

两次 `zcode.cjs` 与 map 不同，因此当前不能承诺“clean install 必然生成相同字节”。生产只能升级到一个经批准、完整登记且不可覆盖的 artifact bundle；不能把另一个 rebuild 输出直接写入相同路径。

两次构建中以下资源相同：

```text
provider/zcode-builtin.json
bytes: 265,884
SHA256: BC760A3B0C6D096EA07EE4E963471F135AE75AB207DB6ED4C372E1B183C856CD

THIRD-PARTY-NOTICES.md
bytes: 3,465,209
SHA256: C4CC6DC747EB6026E41D2CEFC6679392C33E1192629EA96DC0DC702BCFE7C51C
```

### 3.2 Windows runtime-host

| Artifact | Bytes | SHA256 |
|---|---:|---|
| `zcode-runtime-host.exe` | 167,424 | `04E1794F8325B3C46D4159420CDD04041E9AFC58516E03FC3DC8E78576EEFC24` |
| `zcode-runtime-host-acceptance.exe` | 190,976 | `33E70B20A430393081920225E6A2848A2F28CB68881B03E97EBF88ADEB8E70A3` |

`BUILD_PROVENANCE.json` 记录官方 build script 因本机缺少 Visual Studio 17 2022 generator 和独立 Windows SDK 未直接运行；等价 CMake 构建使用已安装 MSVC 与 Windows SDK CPP NuGet packages。未来正式制品仍需在可固定前提、可由 CI 重现的镜像中执行。

## 4. Known-good artifact 门禁

一个 artifact 只有在以下事实全部登记后，才能成为 known-good：

1. 官方 commit 和 tree 精确匹配；
2. root package version 和 AppServer version 分别记录；
3. Node、pnpm、npm registry 和 lockfile 完整固定；
4. `zcode.cjs`、source map、provider data、notices、helper 和所有必需 native/resource 文件都有 path + bytes + SHA256；
5. tracked source 在构建前 clean；
6. clean build 和同依赖树 repeat build 结果分别记录；
7. native ABI、optional dependency、WASM、动态库和资源 closure 完成；
8. 许可证和再分发结论允许目标分发方式；
9. artifact 解压后直接 AppServer Mock smoke 通过；
10. Windows helper acceptance 和 ProcessManager Mock lifecycle 通过；
11. artifact 目录不可原地覆盖，选择由完整 manifest digest 或 artifact version 决定。

若 clean rebuild 与已批准 manifest 不同，不能覆盖旧目录或只更新几个 hash。必须建立新的 artifact version，重新跑全部兼容性和回归门禁，再决定是否晋升。

## 5. 不可改变的 Bridge 合同

### 5.1 CodingAgentAdapter

现有接口保持五个方法：

```text
startTask
continueTask
getStatus
getResult
cancelTask
```

不得增加官方私有类型到参数或返回值。`OfficialHostAdapter` 只能作为内部实现，Bridge Core、Manager、SQLite 和 MCP 不导入官方协议类型。

### 5.2 Worker 与 SQLite Authority

Worker 继续负责：

- 单个已 Claim Attempt；
- 私有 execution envelope；
- Prompt/continuation；
- interaction；
- Result frame；
- Cleanup evidence 收集；
- Release 前 fail-closed。

SQLite 继续持有 Task/Attempt、Claim、Hold、Recovery、Cleanup 和 Release 权威。不得新增 Companion 业务数据库、第二套 Task 状态机或第二套 Recovery。

### 5.3 ADR-030

每 Issuer/Task 的一次权威 entitlement verdict、Private Lease、HANDLE、ACK 和同任务绑定继续生效。官方账户刷新不能替代 Bridge entitlement 权威，不能引入重复 Billing GET。

### 5.4 Worker 并发

现有 Capacity、路径 admission、Claim、Hold、Recovery、Cleanup、Release 和 Worker slots 保持不变。升级不得通过“每账户只跑一个 Worker”静默规避账户竞争。

G4 synthetic harness 已经复现同 profile 双 Worker 的双 refresh：

```text
SAME_ACCOUNT_MULTIWORKER: FAIL_SYNTHETIC
TOKEN_REFRESH_RACE: FAIL_SYNTHETIC
```

该问题解决前，G4 不是 PASS，官方 Host 不得宣称可安全使用共享账户 profile。

## 6. 单所有者拓扑

正常路径必须保持：

```text
one Worker
  -> one CodingAgentAdapter instance
    -> one OfficialHostAdapter
      -> one ZCodeAgentProcessManager
        -> one execution AppServer
          -> optional one Windows runtime-host helper
```

Bridge 保留异常清理与最终证据审核责任，但不得另建常规 ProcessManager。禁止：

- shared AppServer pool；
- 一个 Adapter 跨 Attempt 复用旧 official runtime；
- 两个管理器同时常规拥有同一 AppServer；
- 以官方 `dispose()` resolved 代替 Bridge cleanup verification；
- 新 IPC 或独立 Companion Service。

## 7. 升级前合同门禁

### 7.1 Raw frame guard

现有 Bridge Adapter 对 raw stdout frame 有 16 MiB UTF-8 上限。官方 3.18.0 transport 以 LF 分隔并累积完整 frame，没有等价的 raw-byte cap；parse 后检查字符串大小不等价。

在官方 transport 或 Bridge binding 边界实现等价 guarded frame reader，且至少通过以下测试前，升级为 `BLOCKED`：

- 小于上限的 multi-frame 输入；
- 接近上限的输入；
- 超过 16 MiB 的 raw bytes 被关闭；
- 多字节 UTF-8 边界；
- 超限后无继续 parse、转发或 release；
- partial frame 和 EOF；
- 错误归因能区分 frame limit 与普通 transport close。

### 7.2 Cleanup Proof

官方正常关闭能够观察 root exit、Job empty 和 helper exit，但没有向公开 API 导出 Bridge verifier 接受的持久 Job identity/receipt。`disposeAndWait()` resolved、日志、Job empty 或目标 PID 为空都不是自动转换成 `cleanup_verified` 的依据。

在 Proposed Cleanup ADR 被正式接受、exact-key mapping 实现并有跨崩溃测试前：

```text
NEW_RELEASE_PATH: BLOCKED_FAIL_CLOSED
```

不合格 Attempt 必须保持 Hold/未验证，不能释放容量。

### 7.3 Workspace identity

当前设计假设：

```text
project source path -> workspaceIdentity
canonical/worktree path -> workspacePath
```

该假设仍需 G2-style fixture 覆盖：

- canonical project identity；
- worktree cwd；
- nested path 与 workspace escape；
- Browser scope；
- project instructions；
- same session resume；
- 两个 Task 不串 workspace。

### 7.4 Timeout、cancel 与恢复

官方 Client 的 180 秒 request timeout 可能 evict/restart runtime。若 Prompt send 已发生但 acceptance 未知：

- 当前 Attempt 失败关闭；
- 不自动重发 Prompt；
- 不把旧 turn outcome 拼接到新 runtime；
- 不伪造 cancel ACK；
- 由现有 Hold/Recovery 决定可恢复状态；
- 任何重试必须是现有 Task 合同下的新明确决定，而不是 transport retry。

## 8. 正式升级流程

后续升级应由一个受控任务执行，并按以下顺序推进：

1. **冻结输入**：记录 Bridge commit/tree、官方 commit/tree、版本、lockfile、Node、pnpm、SDK 和构建脚本。
2. **隔离构建**：在独立 worktree 和独立 artifact 目录执行，禁止写入已知 good 目录。
3. **生成 manifest**：登记全部 product/runtime 文件、资源、native 依赖、许可证和 hash。
4. **AppServer smoke**：以 loopback Mock 完成 session、model、tool、replay、resume、cancel、close。
5. **Helper acceptance**：在固定 Windows x64 环境执行七个 helper 场景。
6. **ProcessManager lifecycle**：验证单 Worker、多 generation、PID/helper 清理和 resume。
7. **Binding contract**：实现候选 `OfficialHostAdapter`，验证五方法、event、usage、terminal、error、cancel 和 raw frame guard。
8. **Worker integration**：验证 Claim、Hold、Recovery、Cleanup、Release 与 SQLite Authority。
9. **账户并发**：保持现有 Worker slots；解决同 profile refresh coordination，不能通过串行化 Worker 绕过。
10. **定向回归**：运行 Adapter、Worker、SQLite、routing、cleanup 和 auth 的受影响测试。
11. **性能比较**：按 `PERFORMANCE_COMPARISON.md` 的有效测量门槛比较，不用单次 POC 推断收益。
12. **Astra 独立审查**：审查实际 diff、源码、测试和 artifact，不以完成报告替代。
13. **晋升决策**：由 Owner 根据证据决定是否成为候选。Push/PR/Merge/Release 另需授权。

任何一步失败都不得用手工覆盖 artifact、mock-only 绕过、降低 proof 或删除测试解决。

## 9. 正常关闭与回滚顺序

### 9.1 候选路径正常停止

1. 停止从 Bridge Manager 给候选路径分配新 Claim。
2. 等待当前 Attempt 到明确 terminal；不把“无新日志”当作完成。
3. 通过 Official ProcessManager 执行 normal `disposeAndWait`。
4. 观察 AppServer root exit、Windows Job 为空和 helper exit。
5. 用 owner-specific facts 检查 Browser、MCP 和其他外部资源。
6. 保存 Worker exact identity exit 与第 4/5 步事实。
7. 交给现有 Cleanup verifier；只有现有合同接受后才允许 Release。

若关闭在 deadline 内未完成：

- 不释放容量；
- 不产生伪造 `cleanup_verified`；
- 保留 ownership 和 evidence；
- 进入现有 Hold/Recovery/Cleanup 异常路径；
- 报告实际未清理 PID/resource。

### 9.2 回滚到现有 Adapter

生产回滚路径是恢复现有 direct app-server 适配器：

```text
src/adapters/zcode-app-server-adapter.ts
```

具体要求：

1. 停止给 official Host 候选分配新 Attempt。
2. 保留现有 SQLite schema、Task/Attempt、Claim、Result、Hold 和 Recovery 记录。
3. 对已经正常结束的候选进程执行官方 normal close，并按异常路径处理未知状态。
4. 切换内部 adapter/factory 选择回 `ZCodeAppServerAdapter`；不新增持久化 `official_host` 模式，不迁移 Agent mode。
5. 保持 `zcode_app_server` 外部语义，旧 Adapter 继续实现现有五方法。
6. 对新 Attempt 使用旧 Adapter，禁止把旧 session 与新的 official session 混接。
7. 对 timeout/cancel 后 acceptance unknown 的 Prompt 不自动重发，按原 Task Hold/Recovery 合同处理。
8. 核对 Worker、AppServer、helper 和 Browser/MCP 资源；不得只确认根 PID。
9. 运行受影响 Adapter、Worker、SQLite、Cleanup、Recovery 和 auth 回归。
10. Git 回滚通过 revert 或恢复已批准代码路径完成，不覆盖工作区 WIP。

回滚不读取真实账户，不修改设备身份，不清理生产数据库，也不要求新的 Companion 进程或协议。

## 10. 回滚触发条件

出现以下任一条件时，应停止扩展候选流量并进入回滚/证据保留：

- artifact commit/tree/hash 不匹配；
- raw frame guard 不满足或超限后进程仍继续 parse；
- Cleanup verifier 不能接受关闭事实；
- Worker capability/capacity 被静默减少；
- 同 profile 多 Worker refresh 出现不可恢复竞争；
- Prompt acceptance unknown 后发生隐式重发；
- workspace/session/result 发生跨 Task 串用；
- SQLite Result/Claim/Recovery 合同被绕过；
- Model routing 或 ADR-030 entitlement 语义改变；
- Browser/MCP 资源无法确定 owner；
- 真实进程或后代残留；
- 定向回归或完整发布门禁失败且根因未解释。

回滚不是“删除新分支”或“清理 `.run` 证据”。必须先保留 artifact、日志、PID/Process 证据和失败原因。

## 11. 尚未解决的升级阻断项

| 阻断项 | 状态 | 影响 |
|---|---|---|
| Official Host Adapter | `NOT_IMPLEMENTED` | 无法执行真实 candidate contract tests |
| Worker 内生产接线 | `NOT_IMPLEMENTED` | 无法切换或回滚生产路径 |
| Raw frame guard | `BLOCKED` | 官方 transport 与 Bridge 防御合同不一致 |
| Cleanup Proof mapping | `BLOCKED_FAIL_CLOSED` | 不能授权 Release |
| Workspace identity fixtures | `NOT_RUN` | project/worktree/Browser/instructions 映射未证明 |
| Timeout/restart semantics | `DESIGN_REQUIRED` | unknown acceptance 可能导致不安全重发 |
| 同 profile refresh single-flight | `FAIL_SYNTHETIC` | 共享账户多 Worker 不安全 |
| Real account E2E | `NOT_RUN` | 不能宣称真实账户闭环 |
| Desktop 独立性 | `NOT_RUN` | 未覆盖一般 Desktop Main 路径 |
| Official Node pin | `NOT_VERIFIED` | 构建使用 `24.16.0`，pin 为 `24.14.0` |
| Native/resource closure | `PARTIAL` | optional native 与完整资源 closure 未完成 |
| 再分发审查 | `PARTIAL` | 不可假定可进入对外包 |
| Cross-install reproducibility | `FAIL` | 必须使用已批准 immutable artifact |
| Full regression | `NOT_RUN` | 生产接入尚不存在 |

## 12. 其他记录

没有找到可引用的 OCEAN 结果：

```text
OCEAN_RESULT: NOT_FOUND / NOT_RUN
```

本轮没有执行上游版本升级，也没有执行回滚演练：

```text
UPGRADE_EXECUTED: NO
ROLLBACK_EXECUTED: NO
PRODUCTION_CODE_CHANGED: NO
REAL_MODEL_REQUESTS: 0
REAL_ACCOUNT_REQUESTS: 0
STARTPLAN_REQUESTS: 0
BILLING_REQUESTS: 0
```

只有 G5 候选、raw frame guard、Cleanup Proof mapping 和账户并发合同得到证据支持后，才可进入正式升级与回滚演练。
