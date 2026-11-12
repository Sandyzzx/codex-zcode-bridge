# Codex ZCode Bridge 1.3.0-rc.2 — Preview

> GitHub release status: **Pre-release**. This is not a Stable release and is not a general public plugin-directory submission.

## English

### Release status

`1.3.0-rc.2` supersedes `1.3.0-rc.1`. Users affected by `LifecycleGateError: candidate_schema_mismatch` on Windows should install rc.2 and fully restart Codex. Reconnecting the rc.1 plugin does not replace its load-time schema check.

### Highlights

- SQLite is the authority for new Bridge tasks, including lifecycle, claims, cleanup, release, and restart recovery.
- The JSON-to-SQLite upgrade is a stop-the-world cutover with a verified read-only archive of the original JSON history and a fresh, empty SQLite store.
- Local source-directory and optional Git-worktree behavior stays compatible with the JSON workflow; no new `workspace_roots` or trusted-policy list is required for ordinary single-user local use.
- Verified cleanup holds can be closed only through the audited administrative-abandonment path. It preserves `result_absent=true` and `cleanup_verified=false`; it does not fabricate a Result or ordinary Release transition.
- Master/Worker delegation, progress and interaction events, event and result APIs, model selection, progressive Skill guidance, and Optional Worktree execution are retained.
- Codex Master-token reporting can read an explicit local Thread rollout and report a bounded delegation-window delta when a baseline was saved first.
- The Owner-selected Original E icon and logo assets are included.

### Windows schema hotfix

The rc.1 failure was caused by persisted SQLite schema text using CRLF in the packaged Admin Abandonment SQL while the equivalent SQLite schema stored LF. rc.2 compares schema SQL after ignoring only CRLF/CR versus LF. Missing, extra, renamed, or semantically changed schema objects continue to fail closed.

### Compatibility

- Validated deployment target: Windows single-user trusted-local Bridge.
- SQLite Authority requires Node.js `>=24.16.0 <25`.
- ZCode must already be installed, configured, and signed in.
- macOS, Linux, multi-user isolation, hostile same-account processes, and the OpenAI general public plugin directory are outside this Preview's certification.

### Upgrade warning

Finish, cancel, or save important `queued`, `running`, and `waiting_for_master` work before upgrading. Existing JSON task lifecycles are preserved only as an immutable history archive. They are not imported into SQLite, automatically resumed, continued, or recovered. After SQLite accepts new writes, do not restore the pre-cutover JSON snapshot.

### Evidence boundary

- This Preview combines the production-validated SQLite/Admin Abandonment candidate with the approved independent features and a rewritten README.
- Historical G6 and production E2E results apply only to their recorded candidate trees. The final merged Preview tree receives its own build, plugin validation, Full G6, fresh-install/upgrade-path checks, and independent review before publication.
- The Development `.evidence` probe archive is intentionally excluded from the release tree. Source-only research and probe scripts remain available for audit.

### Install this Preview

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.3.0-rc.2
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

After installation, fully restart Codex so the Host loads the rc.2 Bridge bundle.

For a new installation with no legacy Bridge `.tasks` data, explicitly activate SQLite before starting the Bridge:

```powershell
$settings = Join-Path $HOME '.codex\codex-zcode-bridge'
New-Item -ItemType Directory -Path $settings -Force | Out-Null
@'
{
  "schema_version": 1,
  "authority": "sqlite"
}
'@ | Set-Content -LiteralPath (Join-Path $settings 'authority.json') -Encoding ascii
```

The first SQLite startup creates an empty database and fresh-install receipt. Do not use this activation step for an existing JSON installation; follow the stop-the-world archive-and-cutover procedure instead.

## 简体中文

### 发布状态

`1.3.0-rc.2` 取代 `1.3.0-rc.1`。在 Windows 上遇到 `LifecycleGateError: candidate_schema_mismatch` 的用户应安装 rc.2 并完整重启 Codex。仅重新连接 rc.1 插件不会替换其在启动时执行的 Schema 校验。

### 主要变化

- SQLite 成为 Bridge 新任务的 Authority，负责生命周期、Claim、Cleanup、Release 和重启恢复。
- JSON → SQLite 使用停机切换：原 JSON 历史完整保存为只读归档，新 SQLite 数据根从空库开始。
- 普通本地项目目录和可选 Git Worktree 延续原 JSON 工作方式，不需要新增 `workspace_roots` 或可信目录白名单。
- 经过完整证据验证的 Cleanup Hold 只能通过受审计的管理员放弃路径结案；保留 `result_absent=true`、`cleanup_verified=false`，不伪造 Result 或普通 Release。
- 保留 Master/Worker 派发、进度与交互、事件和结果 API、模型选择、Skill 渐进式指导及可选 Worktree。
- Codex Master Token 可在显式 Thread 与已保存 baseline 的前提下报告有边界的委派窗口增量。
- 包含 Owner 确认的 Original E 图标与 Logo。

### Windows Schema 修复

rc.1 的失败原因是打包的 Admin Abandonment SQL 在 Windows 中使用 CRLF，而 SQLite 保存的等价 Schema 文本使用 LF。rc.2 仅在比较 Schema SQL 时忽略 CRLF/CR 与 LF 的差异；缺失、额外、重命名或语义变化的 Schema 对象仍会 fail closed。

### 兼容范围

- 已验证平台：Windows 单用户可信本地环境。
- SQLite Authority 要求 Node.js `>=24.16.0 <25`。
- 需要预先安装、配置并登录 ZCode。
- macOS、Linux、多用户隔离、同账户恶意进程以及 OpenAI 通用公共插件目录不在本次 Preview 认证范围内。

### 升级警告

升级前请完成、取消或保存 `queued`、`running`、`waiting_for_master` 等重要任务。旧 JSON 任务生命周期只作为不可变历史归档保留，不会导入 SQLite，也不会自动 Resume、Continue 或 Recovery。SQLite 接受新写入后，不得恢复切换前的 JSON 快照。

### 安装 Preview

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.3.0-rc.2
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

安装后请完整重启 Codex，确保 Host 加载 rc.2 Bridge Bundle。

全新安装且不存在旧 Bridge `.tasks` 数据时，请在启动 Bridge 前显式启用 SQLite：

```powershell
$settings = Join-Path $HOME '.codex\codex-zcode-bridge'
New-Item -ItemType Directory -Path $settings -Force | Out-Null
@'
{
  "schema_version": 1,
  "authority": "sqlite"
}
'@ | Set-Content -LiteralPath (Join-Path $settings 'authority.json') -Encoding ascii
```

第一次以 SQLite 模式启动时会创建空数据库及 fresh-install receipt。已有 JSON 数据的安装不得使用该首次启用步骤，必须执行停机归档与 Authority 切换流程。
