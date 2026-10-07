# 已知问题：Start Plan 在 headless app-server 中无法完成认证

> Status: RESEARCH
> Date: 2026-09-27
> 已知问题的观测记录，结论仍成立：headless 路径不伪造验证码。当前可用路径为 Coding Plan。

记录日期：2026-09-27

## 现象

Codex → ZCode Bridge 可同步账户 provider 并在 app-server 会话中选择 `account:bigmodel-start-plan/GLM-5.3-Flash`；但请求开始时，ZCode 要求宿主处理 `interaction/requestProviderRuntimeHeaders`。当前 Bridge 没有 ZCode 桌面渲染器提供的 Start Plan 验证码会话，因此请求在模型生成前失败。

## 本机证据

- 活动运行配置来自 `D:\Program Files\.zcode\v2`。该路径的 `coding-plan-cache.json`（2026-09-17）将 BigModel Coding Plan 标记为可用、Start Plan 标记为不可用。
- `C:\Users\Sandy\.zcode\v2` 的缓存（2026-09-06）将两个套餐都标记为可用，但该缓存较旧，不能证明当前账户状态。
- 使用 C 盘快照仅验证了 app-server 能列出并选择 Start Plan 模型；运行时随后因缺少桌面验证码会话失败，没有产生模型输出。
- 活动 D 盘快照下，BigModel Coding Plan 的 GLM-5.3-Flash 已通过 Bridge TaskManager 的隔离 worktree 真实运行。

## 处理结论

- 当前 headless 自动开发使用 `builtin:bigmodel-coding-plan` + `GLM-5.3-Flash`。
- 不尝试伪造或绕过验证码。Start Plan 需要 ZCode 提供官方 headless 认证接口，或允许宿主复用桌面验证会话。
- 若账户状态变化，先刷新并确认活动数据根下的套餐缓存；不能以旧的 C 盘缓存覆盖活动 D 盘状态。

## 后续

跟踪 ZCode app-server 是否提供官方 Start Plan runtime-header/验证码宿主接口；接口可用后再实现并做真实模型调用验证。

## Coding Plan 回归验证（2026-09-27）

为验证当前可用路径，已通过 Bridge TaskManager 派发隔离真实任务，使用 BigModel Coding Plan 的 `GLM-5.3-Flash`（runtime 返回 provider `account:bigmodel-individual-coding-plan`，reasoning `max`）。

- 任务：`TASK_ACCOUNT_PROVIDER_REGRESSION_20260927`
- ZCode session：`sess_7f867a52-7fe0-4b91-9695-dc5bfe8eb0fe`
- 隔离分支：`codex-zcode/TASK_ACCOUNT_PROVIDER_REGRESSION_20260927`
- 隔离工作树：`D:\\codex-zcode-bridge\\.tasks\\coding-plan-regression-data\\.tasks\\workspaces\\TASK_ACCOUNT_PROVIDER_REGRESSION_20260927`
- 任务产物：工作树 `.tasks/e2e-tests/account-provider.test.mjs`，只使用合成 fixture，不读真实 ZCode 凭据；9 项测试全部通过。
- 复核：Master 在该工作树独立重跑 `node --experimental-strip-types --test .tasks/e2e-tests/account-provider.test.mjs`，9/9 通过；主仓库仍干净，测试产物留在被忽略的 E2E 工作树中。
- 首轮审查发现 provider ID 与 runtime 实际值不一致，已续作修正为 `account:bigmodel-individual-coding-plan`，并保留 `GLM-5.3-Flash` 大小写；再次验证通过。

这证明 Coding Plan 路径可启动模型并完成真实开发任务；不代表 Start Plan 验证码问题已解决。
