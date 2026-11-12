# Node、pnpm 与 Native ABI 兼容性

> Status: RESEARCH — WINDOWS X64 CANDIDATE PASS / CLOSURE PARTIAL
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对 fixed artifact build、helper smoke、BOM、当前 Worker gate 与完整回归
> Verified against: Bridge candidate `ba25f837` + documentation changes

## 已确认

- 当前 Bridge SQLite/Lifecycle Gate 接受 Node `>=24.16.0 <25`。
- 固定官方 Host 制品已用 Node `24.16.0` 在 Windows x64 构建和加载。
- `zcode-runtime-host.exe` 与官方 AppServer 在同一候选路径成功启动并由 ProcessManager 关闭。
- BOM 记录 Windows x64 keyring Node-API binding 及 license metadata；6 个对应文件已通过精确 `.gitignore` 例外纳入本地候选提交。
- loopback Mock 性能路径每次生命周期均观察到 helper 与 AppServer 两个进程，shutdown 后为 0。

## 选择

当前候选固定使用：

```text
win32-x64-node24.16.0-zcode3.18.0-b95ebaff
```

Adapter 在非 Windows x64 上 fail closed，且 Worker bundle 从自身位置加载固定目录，不接受用户环境或持久设置重定向。该限制属于 Preview.4 候选支持面，不是全部 Bridge 功能的跨平台结论。

## 已验证范围

- Host module 加载与官方 ProcessManager 构造
- AppServer `0.17.1` 启动
- Runtime-host helper 启动与正常关闭
- loopback Mock 请求、Read、resume、cancel 与目标进程清理
- 提交后的 clean checkout 中 6 个 Node-API keyring 文件均存在，bytes 与 SHA-256 和 BOM 一致，且 binding 可加载
- 固定源码两次构建和 same-tree repeatability

## 仍为 PARTIAL

- 完整 optional native dependency closure
- 不同机器、空 dependency cache 与完整动态资源的 native/resource closure
- 官方 release/CI prerequisites 下的 helper rebuild
- 不同 patch-level Node 24.x 的 binary/module 行为
- 安装机器缺少 VC runtime 或 Windows component 的明确失败矩阵
- 插件、字体、WASM、Browser、MCP、tool 后代等全部资源的加载/清理闭包
- Linux/macOS helper/Host build

## 未运行

- Node 25+、Node 22/24.14 的 production path
- ARM64、Windows Server、Ubuntu、macOS
- 长期 soak 与持续内存/句柄峰值
- 真实 model/account request

## 结论

共同 Node 24.16.0 路径在固定 Windows x64 合成范围内为 `PASS`。六个 keyring 文件已在提交后的 clean checkout 解析、加载，且 bytes/hash 与 BOM 一致；不同机器、空 dependency cache 与完整动态资源闭包仍未认证，因此整体只能给 `PARTIAL`。
