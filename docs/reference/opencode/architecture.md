# OpenCode — 架构设计

## 分层架构

```
[Binary Wrapper (packages/opencode/bin/opencode)]
    --> [CLI Layer (yargs 18)]   packages/opencode/src/cli/
        --> [Bootstrap / Runtime Init]
            --> [Session Loop]   packages/opencode/src/session/
                --> [Tool System]    packages/core/src/tool/
                --> [Agent System]   packages/opencode/src/agent/
                --> [LLM Integration] packages/llm/
            --> [TUI Layer]      packages/tui/
            --> [Server Layer]   packages/server/
        --> [Core Foundation]    packages/core/
            --> [Database (SQLite via Drizzle)]
            --> [Plugin System]
            --> [Configuration]
            --> [Effect-TS Services]
        --> [Plugin Ecosystem]   packages/plugin/
    --> [Infrastructure (SST / Cloudflare / AWS)]
```

## 包依赖流向

```
Schema → Protocol → Core → Server
                    Core → TUI → Session-UI → App
                    Core → Plugin
Client (depends on Schema + Protocol only, NOT Core/Server)
SDK-Next (composes Client + Core + Server)
```

## 核心架构设计

### 1. Effect-TS 驱动的微架构

整个系统构建在 **Effect-TS 4.0** 之上，提供：
- **依赖注入**: 通过 Effect `Layer` / `Service` 模式管理所有服务依赖
- **结构化并发**: 通过 Effect `Fiber` / `Scope` 管理并发任务生命周期
- **类型安全错误处理**: Effect 的类型系统保证所有错误路径被处理
- **资源安全**: `Scope` / `Scope.Fork` 确保资源自动清理

```typescript
// 典型 Effect 服务模式
class MyService extends Effect.Service<MyService>()("MyService", {
  effect: Effect.gen(function*() {
    const db = yield* DatabaseService;
    return {
      doThing: (input: string) => db.query(input)
    };
  })
}) {}
```

### 2. 会话驱动架构 (Session-Centric)

核心抽象是 **Session** — 所有交互（CLI、Server、Web）最终都归结为一个会话：
- 会话管理完整的消息历史
- 事件溯源（Event Sourcing）驱动状态变更
- Projector 模式用于派生视图状态
- 支持会话压缩（Compaction）以控制上下文长度

### 3. 插件系统架构

分层插件模型：
- **Host Plugin**: 运行时级别的插件（修改行为）
- **Agent Plugin**: 代理行为插件（修改工具/权限）
- **Command Plugin**: 扩展 CLI 命令
- **Skill Plugin**: 可复用工作流定义
- **Provider Plugin**: LLM 提供商适配
- **TUI Plugin**: 自定义 TUI 组件/主题

30+ 内置提供商实现（Anthropic, OpenAI, Google, AWS Bedrock, Azure, Mistral, Groq, Cohere, xAI 等）。

### 4. 条件平台适配

利用 Bun 的 `imports` 条件子路径导入实现双运行时支持：

| 条件路径 | Bun 实现 | Node.js 实现 |
|----------|----------|-------------|
| `#sqlite` | bun:sqlite 绑定 | better-sqlite3 |
| `#pty` | bun:pty | node-pty |
| `#fff` | Bun 文件 API | Node fs |
| `#db` | Bun SQLite | Node SQLite |

### 5. 多形态部署架构

```
                    ┌─────────────┐
                    │  opencode   │
                    │   binary    │
                    └──────┬──────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
      ┌────▼────┐   ┌─────▼─────┐   ┌─────▼─────┐
      │  CLI    │   │   TUI     │   │  Server   │
      │ (yargs) │   │ (OpenTUI) │   │  (Hono)   │
      └─────────┘   └───────────┘   └─────┬─────┘
                                          │
                          ┌───────────────┼───────────────┐
                          │               │               │
                     ┌────▼────┐    ┌─────▼─────┐   ┌────▼────┐
                     │  Web   │    │  Desktop  │   │  SDK   │
                     │ (Vite) │    │ (Electron)│   │  (API) │
                     └─────────┘    └───────────┘   └─────────┘
```

### 6. Agent-Host 架构

- **Host Agent**: 主协调代理，管理会话、工具分发、权限
- **Sub-Agent**: 通过 `AgentTool` 生成，获得受限工具集
- 支持 **ACP**（Agent Communication Protocol）用于代理间通信
- 支持 **MCP**（Model Context Protocol）用于外部工具集成

### 7. 权限管道

```
静态规则 (always-allow / always-deny)
  → Tool 级权限分类 (isReadOnly, isDestructive, isConcurrencySafe)
  → 用户交互确认 (TUI/CLI 对话框)
  → 执行
```
