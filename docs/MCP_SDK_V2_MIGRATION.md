# MCP TypeScript SDK v2 迁移记录

本分支使用官方模块化 MCP TypeScript SDK v2.1.0。服务端从 `@modelcontextprotocol/server` 导入 `McpServer` 和 `CallToolResult`，并从 `@modelcontextprotocol/server/stdio` 使用 `serveStdio`。stdio 帧格式和连接生命周期由 SDK 工厂 API 管理。

SDK 工具 schema 使用 Zod 4（`zod/v4`）。SDK v2 不支持 Zod 3；直接依赖使用 Zod `^4.2.0`，这是 SDK 所用 Standard Schema JSON Schema 转换的最低版本。测试客户端和可选的真实集成客户端使用 `@modelcontextprotocol/client` v2.1.0。

现有六个 MCP 工具的名称、参数形状、结果字段和 TaskManager 行为均未改变。`zcode_events` 仍是 Phase 7 增量增加的工具。`docs/ARCHITECTURE.md` 和 `docs/INTERFACES.md` 的契约边界保持冻结。

## 验证范围

本次迁移通过了 TypeScript 类型检查和构建。作为本次依赖/API 迁移的一部分，没有运行完整测试套件。
