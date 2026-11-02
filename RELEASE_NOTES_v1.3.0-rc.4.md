# Codex ZCode Bridge 1.3.0-rc.4 — Preview

> GitHub release status: **Pre-release**. This is not a Stable release.

## English

### Release status

`1.3.0-rc.4` supersedes `1.3.0-rc.3` for Windows single-user SQLite deployments. Install rc.4 and fully restart Codex.

### Fixes

- A secondary Manager that observes a running Operation's Worker as `alive` or transiently `unknown` now remains read-only without writing a global `cleanup_incomplete` Recovery Hold. The owning Manager can continue recording interaction replies and cancellation intent.
- SQLite now uses the fixed single-user trusted-local `yolo` execution profile. Ordinary workspace reads, edits, builds, tests, and cleanup inside task scope can run unattended, matching the JSON path's default local workflow.
- The change does not weaken the fail-closed path for a conclusively exited Worker with missing Result, Cleanup, or Release evidence.

### Safety boundaries

`yolo` runs with the current Windows account's permissions. It is not a sandbox or an elevation mechanism. Push, merge, tag, release, production Authority changes, deletion outside task scope, credential changes, and access to real production task data remain explicit user decisions. Workspaces, worktrees, `allowed_paths`, `forbidden_paths`, prompts, and Skills are not OS security boundaries.

An existing durable Recovery Hold is not removed by replacing the Bundle. Close Codex normally, verify the Worker has exited, and use the existing evidence-bound administrative recovery path for that exact Operation.

### Install this Preview

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.3.0-rc.4
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

After installation, fully restart Codex so the Host loads the rc.4 Bridge bundle.

## 简体中文

### 发布状态

`1.3.0-rc.4` 取代 Windows 单用户 SQLite 部署中的 `1.3.0-rc.3`。安装 rc.4 后必须完整重启 Codex。

### 修复

- 第二个 Manager 观察到运行中 Operation 的 Worker 为 `alive` 或临时 `unknown` 时，只让自身保持只读，不再写入全局 `cleanup_incomplete` Recovery Hold。原 Manager 仍可记录 interaction reply 和取消意图。
- SQLite 改用固定的单用户可信本机 `yolo` 执行档案。工作区内的普通读取、编辑、构建、测试和任务范围内清理可以无人值守执行，与 JSON 路径的默认本机工作流一致。
- 已确认 Worker 退出但 Result、Cleanup 或 Release 证据不完整时，仍保持 fail-closed，不放宽既有安全合同。

### 安全边界

`yolo` 以当前 Windows 账户权限运行，不是沙箱，也不是提权。Push、Merge、Tag、Release、生产 Authority 切换、任务范围外删除、凭据修改和真实生产任务数据访问仍需用户明确决定。Workspace、worktree、`allowed_paths`、`forbidden_paths`、Prompt 和 Skill 都不是 OS 安全边界。

替换 Bundle 不会自动删除已有的持久 Recovery Hold。请正常关闭 Codex，确认 Worker 已退出，再使用 Bridge 现有的证据绑定行政恢复路径处理该精确 Operation。

### 安装本 Preview

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.3.0-rc.4
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

安装后请完整重启 Codex，确保 Host 加载 rc.4 Bridge Bundle。
