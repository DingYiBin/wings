# OpenCode — 可参考的设计模式

## 1. Effect-TS 作为核心架构骨架

整个系统深度集成 **Effect-TS 4.0**，不只是库依赖，而是架构骨架：

```
Service 定义 → Layer 组装 → Effect 运行 → Fiber 管理
```

- **每一层都是 Effect Service**: 数据库、配置、LLM、文件系统、PTY 全都定义为 Effect Service
- **结构化并发**: 用 `Fiber` 和 `Scope` 管理子代理生命周期、会话超时
- **可测试性**: Effects 可通过注入 Mock Layer 完全替换依赖
- **资源安全**: 所有可释放资源（文件句柄、子进程、数据库连接）通过 `Scope` 管理

```typescript
// 模式: Service 定义 + Layer 注册
class DatabaseService extends Effect.Service<DatabaseService>()("DatabaseService", {
  effect: Effect.gen(function*() {
    const db = yield* createConnection();
    return { query, insert, transaction };
  }),
  dependencies: [ConfigLayer]
}) {}

// 使用: yield* 注入
const result = yield* DatabaseService.query("SELECT * FROM sessions");
```

**参考价值**: 对比 Wings 当前的状态管理模式，Effect-TS 提供了一种类型安全、可组合的依赖管理和并发方案。

---

## 2. Monorepo 边界清晰的包拆分

26 个包按照**严格依赖方向**组织，形成一个有向无环图（DAG）：

```
schema (纯数据类型)
  → protocol (通信协议)
    → core (业务核心)
      → server (HTTP 服务)
    → client (HTTP 客户端, 不依赖 core/server)
  → llm (LLM 抽象)
  → plugin (插件 SDK)
```

关键设计决策：
- **`@opencode-ai/client`** 仅依赖 schema + protocol，不依赖 core 或 server——外部用户可以只用 client 包与远程 OpenCode 服务通信
- **`@opencode-ai/plugin`** 作为公共 SDK，暴露有限的 API 表面
- **条件适配包**: `effect-sqlite-node`、`effect-drizzle-sqlite` 封装基础设施细节

**参考价值**: Wings 可以参考这种包拆分方式，将协议定义、核心逻辑、客户端分离。

---

## 3. 条件平台适配（Conditional Sub-path Imports）

利用 Bun 的 `imports` 条件子路径机制，为 Bun 和 Node.js 提供不同的实现：

```json
{
  "imports": {
    "#sqlite": {
      "bun": "./src/sqlite/bun.ts",
      "default": "./src/sqlite/node.ts"
    },
    "#pty": {
      "bun": "./src/pty/bun.ts",
      "default": "./src/pty/node.ts"
    }
  }
}
```

这允许：
- 同一代码库同时支持 Bun 和 Node.js
- 编译时/运行时自动选择正确实现
- 避免运行时检测开销

**参考价值**: 如果 Wings 需要在多个运行时部署，这是很好的适配模式。

---

## 4. 二进制分发策略

OpenCode 通过 npm 分发平台特定的原生二进制文件：

```
opencode-darwin-arm64
opencode-darwin-x64
opencode-linux-arm64
opencode-linux-x64
```

`packages/opencode/bin/opencode` 是一个轻量 Node.js 包装脚本：
1. 检测平台 (darwin/linux/windows) 和架构 (x64/arm64)
2. 检查 CPU 特性（AVX2 支持）
3. 从 `node_modules` 选择正确的平台包
4. 生成原生二进制进程，转发信号

**参考价值**: 适用于需要分发编译后二进制文件的项目。

---

## 5. Multi-Model Prompt 模板系统

每个模型系列有独立的系统提示模板：

```
packages/opencode/src/session/prompts/
├── anthropic.txt
├── gemini.txt
├── gpt.txt
├── codex.txt
├── kimi.txt
├── meta.txt
├── trinity.txt
└── beast.txt
```

每个模板针对特定模型系列的 behavior 特性优化 prompt 风格（如 Claude 的 XML 标签风格 vs GPT 的 markdown 风格）。

**参考价值**: Wings 的 prompt 可以按模型架构分离维护。

---

## 6. 事件溯源 + Projector 模式

会话状态管理使用事件溯源架构：

```
Event (用户消息, 工具调用, 系统事件)
  → Event Store (SQLite, 持久化)
    → Projector (投影到当前状态)
      → Session State (供查询/渲染)
```

优势：
- **完整历史可回溯**: 所有事件都有记录
- **状态重建**: 可以从任何时间点重放事件重建状态
- **撤消/还原**: 通过事件回滚实现
- **会话压缩**: 老旧事件可压缩为摘要

---

## 7. 工具系统的自描述元数据

`packages/core/src/tool/` 中的工具定义包含丰富的自描述元数据：

```typescript
interface Tool<Input, Output> {
  name: string;
  description: (input: Input, options: Options) => string; // 动态 prompt 文本
  inputSchema: Schema;           // 输入校验
  isReadOnly: (input: Input) => boolean;   // 是否为只读
  isDestructive: (input: Input) => boolean; // 是否有破坏性
  isConcurrencySafe: () => boolean;         // 是否可并发
  isEnabled: () => boolean;                 // 是否启用
}
```

这允许：
- 运行时自动决策（并发策略、权限检查）
- 自动生成 prompt（工具描述动态构建）
- UI 自动分类（只读工具高亮、破坏性工具确认）

**参考价值**: Wings 工具系统可以采纳类似的元数据模式。

---

## 8. OpenTUI — Solid.js 驱动的 TUI 框架

自定义 TUI 框架 `@opentui/core` + `@opentui/solid`：
- 使用 Solid.js 的响应式原语（Signal, Effect, Memo）
- 终端事件循环集成
- 组件化终端 UI 开发（与 React Terminal UI 不同，用 Solid.js）
- 支持键盘映射、主题系统

**参考价值**: 如果在终端 UI 方面有需求，Solid.js 的细粒度响应式特别适合 TUI（无虚拟 DOM，直接操作终端缓冲区）。

---

## 9. ACP / MCP 双协议支持

同时实现两种 Agent 通信协议：
- **MCP** (Model Context Protocol): 标准化的外部工具集成协议
- **ACP** (Agent Communication Protocol): 自定义的 Agent-to-Agent 通信协议

架构上使用 Hono 作为服务端框架，支持 JSON-RPC over HTTP/SSE/WebSocket。

---

## 10. Plugin SDK 作为独立包

`packages/plugin/` 作为独立的公共 SDK 包发布，提供：
- 类型安全的插件 API
- 工具 API 扩展
- TUI 集成
- Effect v2 集成

插件可以扩展系统的几乎任何方面：新工具、新命令、新 UI 组件、新 LLM 提供商。

---

## 11. SST IaC 集成

使用 SST v4 管理云基础设施：
- `sst.config.ts` 定义完整的云部署
- 集成 Cloudflare Workers, AWS, Stripe, PlanetScale, Honeycomb
- 基础设施即代码，与应用代码在同一个仓库

---

## 12. Schema-First 设计

`packages/schema/` 定义所有核心数据类型（使用 Effect Schema）：
- 会话 Schema
- 消息 Schema
- 工具调用 Schema
- 配置 Schema

所有包共享同一套类型定义，确保跨包的类型安全。
