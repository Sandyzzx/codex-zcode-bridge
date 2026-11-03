# ADR-023：完成窗口预热 Windows 清理事务 helper

> Status: DECISION
> Date: 2026-11-03
> Decision: 修复 permission-reply 后 Worker close 超时；不改变清理证据合同

## Context

Windows `zcode_app_server` close 每次启动 ADR-009 PowerShell 事务 helper。
真实 fixture 中 runtime 回复 permission 后，close 事务需要约 3.1–6.4 秒；
5 秒 close 验收在负载或 helper 冷启动较慢时失败。诊断显示业务 Result 可能
尚未提交、runtime 可能已被证明退出，但没有 Worker 残留或假清理结论。

## Rationale

报告规范化、checkpoint、desktop 同步和 browser close 已经形成一个有界窗口。
在这个窗口只启动空事务 helper，可以把冷启动移出 close 关键路径，同时保留
ADR-009 在 close 时的全部身份、归属和失败闭合检查。任何预热失败都必须
回退到原 terminator，而不是降低清理证据。

## Decision

Windows 默认身份绑定 terminator 在 `turn.completed` 处理窗口启动清理 helper，
供紧随的 close 复用。预热只启动 PowerShell helper，不枚举、不 hold、不杀
进程；身份捕获、根指纹、树归属、终止和失败保留等检查全部留在 close。
使用注入 terminator 的测试与调用方不预热。

若预热 helper 启动失败或已过期，close 回退到原 ADR-009 terminator；若
helper 已被终止事务使用，由该事务的 finally 负责关闭。自然退出分支仍走
ADR-009 recorded-tree claimant scan，不得凭 PID 消失或预热成功宣称清理。

## Consequences

常见成功路径把 helper 冷启动移入 close 前的既有窗口，降低 Worker 5 秒
close 竞争。它不改变公共 MCP schema、任务状态、失败分类或清理验证等级；
POSIX 与注入 terminator 路径不变。
