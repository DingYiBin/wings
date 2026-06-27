# Wings 架构设计

## 项目定位

Wings 是一个多模型聚合 Agent 系统。核心理念：不同 AI 模型各有所长 —— 有的推理强，有的速度快，有的擅长代码，有的精于创意。Wings 将各模型统一接入，根据任务特点智能调度。每个模型都是一只翅膀（wing）。

架构设计大量参考 [claude-code](https://github.com/anthropics/claude-code)，该项目在 Agent 工程上是最成熟的实现之一。

## 技术选型

| 选项 | 选择 | 理由 |
|------|------|------|
| 运行时 | **Bun** | 启动速度接近 Python，原生 TS/JSX 支持，内置 test runner |
| 语言 | **TypeScript** | 泛型协议系统比 Python Protocol 更强，编译期保证正确性 |
| 类型校验 | **Zod v4** | claude-code 同款，工具 input/output 校验 |
| CLI 框架 | **Commander.js** | claude-code 同款，TS 类型推导好 |
| SDK | Anthropic SDK + OpenAI SDK | 首批两只翅膀 |

## 设计原则

### 1. 一切皆工具 (Everything is a Tool)

所有能力 —— 文件读写、shell 执行、搜索、网络请求、子 agent 调用 —— 都实现统一的 `Tool<Input, Output>` 泛型接口。

```typescript
// 参考 claude-code src/Tool.ts
interface Tool<I = any, O = any, P = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  call(input: I, context: ToolContext): Promise<ToolResult<O>>;
  isEnabled(): boolean;
  isReadOnly(input: I): boolean;
  isDestructive(input: I): boolean;
  renderResult(result: ToolResult<O>): string;
}
```

好处：
- **LLM 视角统一**：所有能力都是同一套 tool calling 格式
- **权限集中管理**：所有操作经过同一条权限管道
- **可扩展**：新增能力只需实现 Tool 接口并注册

### 2. 协议驱动 (Protocol-Driven)

模块之间通过 TypeScript 接口定义边界：

```typescript
// 模型适配器协议
interface ModelProvider {
  providerName: string;
  chat(messages: Message[], tools: ToolSchema[], config: ModelConfig): Promise<ModelResponse>;
  stream(messages: Message[], tools: ToolSchema[], config: ModelConfig): AsyncGenerator<StreamEvent>;
}

// 消息标准化器协议
interface MessageNormalizer {
  toInternal(provider: string, raw: unknown): Message[];
  toProvider(provider: string, messages: Message[]): unknown[];
}
```

### 3. 分层服务化

```
┌────────────────────────────────────────┐
│              CLI / REPL                 │  ← 用户界面
├────────────────────────────────────────┤
│              Agent 核心                 │  ← agent loop, subagent, coordinator
├──────────┬──────────┬──────────────────┤
│  Query   │  Tools   │  Permissions     │  ← 核心能力层
├──────────┼──────────┼──────────────────┤
│  Models  │ Messages │  Hooks           │  ← 抽象层
├──────────┴──────────┴──────────────────┤
│           Services (API, MCP)           │  ← 基础设施
└────────────────────────────────────────┘
```

### 4. 懒加载

重型模块（特定模型 SDK、MCP）使用 dynamic `import()` 按需加载，最小化 CLI 启动时间。claude-code 的入口点 `cli.tsx` 完全没有静态 import —— 全是按子命令动态加载。

### 5. 权限管道

多阶段权限检查，从自动到人工逐级升级：

```
请求 → 静态规则 → 自动分类器 → hooks → 交互式审批
         ↓             ↓          ↓          ↓
      允许/拒绝      允许/拒绝   允许/拒绝    待用户决策
```

## Agent 核心循环

```
用户输入
  │
  ▼
组装消息列表 (system prompt + history + new user message)
  │
  ▼
选择模型 (根据任务类型、配置、可用性)
  │
  ▼
query() ─── 调用 LLM API，流式返回 (AsyncGenerator)
  │
  ▼
解析响应
  │
  ├── text ──→ 输出给用户
  │
  ├── tool_use ──→ 权限检查 ──→ 执行工具
  │                    │              │
  │                    ▼              ▼
  │               拒绝 → 注入错误   tool_result
  │                              │
  └──────────────────────────────┘
                    │
                    ▼
         将 tool_result 追加到消息列表
                    │
                    ▼
            继续下一轮 query()
                    │
                    ▼
              stop_reason == "end_turn" → 结束
```

用 TypeScript async generator 表达：

```typescript
async function* runLoop(
  messages: Message[],
  tools: Tool[],
  model: ModelProvider,
): AsyncGenerator<StreamEvent> {
  while (true) {
    const stream = model.stream(messages, toToolSchemas(tools), config);
    let hadToolUse = false;

    for await (const event of stream) {
      if (event.type === "tool_use") {
        const tool = tools.find(t => t.name === event.name);
        if (tool && permissionPipeline.check(tool, event.input)) {
          const result = await tool.call(event.input, context);
          messages.push({ role: "user", content: [toToolResult(event.id, result)] });
          hadToolUse = true;
          break; // 退出 stream 循环，回到外层 while
        }
      }
      yield event; // 文本、thinking 等直接输出
    }

    if (!hadToolUse) return; // end_turn
  }
}
```

## 关键模块

| 模块 | 职责 | 核心依赖 |
|------|------|----------|
| `messages` | 消息类型 + 跨模型格式转换 | 无 |
| `models` | ModelProvider 接口 + 各 API 适配器 | messages |
| `tools` | Tool 接口 + 注册表 + 内置工具 | 无 |
| `query` | LLM API 调用封装（retry, fallback） | models, messages, tools |
| `agent` | 核心循环 + 子 agent + 协调器 | query, tools, permissions |
| `permissions` | 多阶段权限管道 | tools |
| `hooks` | 生命周期钩子 | 无 |
| `config` | 全局/项目配置 | 无 |
| `context` | system prompt + 环境信息 | 无 |
| `cli` | Commander.js 入口 + REPL | agent, config |
| `memory` | 持久化记忆 | 无 |
| `skills` | 可复用技能/工作流 | tools |
| `plugins` | 插件加载 | tools |
| `services` | 外部服务封装（API, MCP） | 无 |

## 与 claude-code 的模块对应

| claude-code | wings |
|-------------|-------|
| `src/tools/*.ts` (58 tools) | `tools/builtin/*.ts` |
| `src/Tool.ts` | `tools/base.ts` |
| `src/utils/model/` | `models/` |
| `src/QueryEngine.ts` | `query/engine.ts` |
| `src/query.ts` (query loop) | `agent/loop.ts` |
| `src/tools/AgentTool/` | `agent/subagent.ts` |
| `src/coordinator/` | `agent/coordinator.ts` |
| `src/utils/messages.js` | `messages/` |
| `src/utils/hooks.ts` | `hooks/` |
| `src/utils/config.ts` | `config/` |
| `src/entrypoints/cli.tsx` | `cli/main.ts` |
| `src/services/mcp/` | `services/mcp/` |
| `src/skills/` | `skills/` |
| `src/plugins/` | `plugins/` |
| `src/context/` | `context/` |
| `src/memdir/` | `memory/` |

## 模型路由

```
任务请求
  │
  ▼
registry.route(taskRequirements)
  │
  ├── "需要长上下文" → Claude (200K context)
  ├── "需要代码生成" → Claude / o4-mini
  ├── "需要快速响应" → Gemini Flash / Haiku
  ├── "需要视觉理解" → GPT-4o / Claude Vision
  └── "默认" → 用户配置的默认模型
```

## 扩展性

### 添加新模型

```typescript
// models/deepseek.ts
export const deepseek: ModelProvider = {
  providerName: "deepseek",
  async chat(messages, tools, config) { /* ... */ },
  async *stream(messages, tools, config) { /* ... */ },
};

// models/registry.ts
registry.register("deepseek", deepseek);
```

### 添加新工具

```typescript
// tools/builtin/my_tool.ts
export const myTool: Tool = {
  name: "my_tool",
  description: "Does something useful",
  inputSchema: z.object({ query: z.string() }),
  async call(input, context) { /* ... */ },
  isEnabled: () => true,
  isReadOnly: () => true,
  isDestructive: () => false,
  renderResult: (r) => r.output,
};

// tools/registry.ts
registry.register(myTool);
```
