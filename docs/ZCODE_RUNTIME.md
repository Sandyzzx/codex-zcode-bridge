# ZCode 运行配置边界

> Status: AUTHORITATIVE
> Last updated: 2026-10-03
> Last verified: 未逐条核对

当前生产路径是 `node zcode.cjs app-server --stdio`，不是历史 CLI `--prompt --json`。解析入口为 `NodeRuntimeResolver`，配置项与用户设置方法见仓库 README。

Bridge 只读取官方 builtin/personal provider 配置，不复制、不改写内容，也不将环境或凭据写入任务 metadata。personal 配置的 `config.providerConfigRules.providerRules` 必须为非空数组或对象；已知空 stub 被拒绝。结构验证不能证明 provider 可用或账号有权限。

persisted runtime-config 中已知字段只能是字符串或 null；缺文件允许环境/发现回退，存在但损坏、非 object 或超过 64 KiB 会报配置错误。默认 mode 仍为已披露的 yolo；不能把坏配置当成首次未设置而回退到该模式。

执行和模型目录 RPC 客户端都是私有集成实现，当前假运行时测试覆盖调用选择、事件、交互和清理。真实协议随安装版本变化；此前会话的 capability 记录属于历史观察，本轮没有新建真实 session 进行版本认证。
