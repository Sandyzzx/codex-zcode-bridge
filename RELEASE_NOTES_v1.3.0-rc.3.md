# Codex ZCode Bridge 1.3.0-rc.3 — Preview

> GitHub release status: **Pre-release**. This is not a Stable release.

## English

### Release status

`1.3.0-rc.3` supersedes `1.3.0-rc.2` for SQLite lifecycle users. Install rc.3 and fully restart Codex.

### Fix

rc.2 could fail a valid running task when another Manager instance started Recovery and observed the task's exact live Worker. The non-owning Manager persisted a global `cleanup_incomplete` Recovery Hold. That Hold was invalid for a live managed Worker and prevented the owning Worker from recording its next interaction request.

rc.3 keeps the non-owning Manager read-only for the lifetime of the live Worker, but does not persist a global Hold. Verified exit, unknown identity, missing identity, and unresolved cleanup still fail closed.

### Compatibility and safety boundaries

- SQLite remains the authority only after the previously documented stop-the-world cutover.
- This release does not alter Authority selection, Claim, Capacity, Cleanup, Release, Workspace Admission, or JSON archive contracts.
- A task already blocked by an rc.2 global Hold cannot be resumed by replacing the Bundle. Close Codex normally so the old Worker exits, then use the existing Bridge recovery tooling for that persisted Operation before retrying the task.
- The fix is limited to Windows single-user trusted-local Bridge deployments. The OpenAI general public plugin directory is out of scope.

### Install this Preview

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.3.0-rc.3
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

After installation, fully restart Codex so the Host loads the rc.3 Bridge bundle.

## 简体中文

### 发布状态

`1.3.0-rc.3` 取代 SQLite 生命周期场景中的 `1.3.0-rc.2`。安装 rc.3 后必须完整重启 Codex。

### 修复

rc.2 中，如果另一个 Manager 实例启动 Recovery 并观察到某任务精确存活的 Worker，它可能写入全局 `cleanup_incomplete` Recovery Hold。对于受管理且仍存活的 Worker，该 Hold 是错误的，并会阻止原 Worker 记录后续 interaction request。

rc.3 在该 Worker 精确存活期间仅让非所属 Manager 保持只读，不再持久化全局 Hold。Worker 已验证退出、身份未知、身份缺失或 Cleanup 未决时，仍保持 fail-closed。

### 兼容与安全边界

- 只有完成既有停机切换后，SQLite 才作为 Authority。
- 本版本不改变 Authority 选择、Claim、Capacity、Cleanup、Release、Workspace Admission 或 JSON 归档合同。
- 已被 rc.2 全局 Hold 阻塞的任务不能仅靠替换 Bundle 恢复。请正常关闭 Codex，等待旧 Worker 退出，再使用 Bridge 现有的恢复工具处理该持久化 Operation，然后重新创建任务。
- 修复范围是 Windows 单用户可信本地 Bridge；不包含 OpenAI 通用公共插件目录发布。

### 安装本 Preview

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.3.0-rc.3
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

安装后请完整重启 Codex，确保 Host 加载 rc.3 Bridge Bundle。
