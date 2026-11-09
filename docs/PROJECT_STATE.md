# Project State

> Status: AUTHORITATIVE
> Last updated: 2026-11-07
> Last verified: 2026-11-07，核对集成基线与 ADR-029 退役候选范围；最终回归数据见交付报告。
> Verified against: a46137fe46b567271a7756be819361132625278c + ADR-029 本地候选（未发布）

已发布基线为 v1.6.0 / aabbb0a959ee234508c62731ed5122f28dfcf5b0。R1–R5 的本地集成为 a46137fe；本轮在独立 Worktree 退役旧运行时，不代表 master、安装插件或生产数据库已经更新。

## 当前候选

- 一个 SQLite Task Authority（v14）、一个 Lifecycle Manager、一条 Worker→ZCode app-server 生产链。旧 JSON TaskStore/Manager/Worker、CLI Adapter 和 GitWorktreeProvider 已删除。
- R1 stderr 排水、R2 32 MiB Result 与显式离线升级、R3 阶段期限、R4 pre-Intent 拒绝、R5 重启后的显式取消保持；Claim 永久、Result 与 Cleanup/Release 独立。
- Attention/Thin Waiter 使用只读 SQLite snapshot；Doctor 绑定同一 Authority。旧 JSON 用户文件不读取、不迁移、不删除。
- 公共 Core API 退役获 Owner 批准，未来按主版本发布；Marketplace MCP 工具/schema 与 SQLite v14 不变。外部 fork 升级未验证。
- JSON B3-05 随旧 Store 退役；SQLite 功能回归保留，资源压力单独运行或由实际影响选择。完整 Windows 结果与前后指标以本轮报告为准。

## 明确边界

当前运行支持受信任的单用户 Windows 本地部署。任务使用固定 yolo profile，以当前账户权限执行；路径声明与 worktree 不是 OS 沙箱。公开完成状态表示执行结束，Owner 仍需独立验收。

Host 大 Result 接收限制和 1.1 MB 续作输入限制按 Owner 决定延后；不得重派已完成任务绕过读取问题。不新增 Chunk API、不扩大输入、不开展 R6/R7。

原生 Ubuntu 本轮尚未运行；已知 admin-abandonment 测试的平台错误改为 Windows 保留成功/CAS、其他平台断言拒绝且数据库不变，生产身份限制不变。历史 QEMU MCP 超时原因未定，不能当作原生 Ubuntu 产品缺陷或 PASS。

## 未认证能力

真实 Provider 长时/四小时墙钟运行、当前 Native Host 最大 Result 完整接收、外部 dsh/fork 升级、Claude 后台唤醒、跨 Host attach/control、其他平台生产身份生命周期均未由本轮证明。浏览器默认关闭，限定版本的历史证据不推广到所有模型/runtime。

当前设计从 [架构](ARCHITECTURE.md) 与 [接口](INTERFACES.md) 阅读；需要解释取舍时从 [ADR 索引](decisions/README.md) 按主题加载。历史审计和原始失败证据保留，默认不读取 archive/research。
