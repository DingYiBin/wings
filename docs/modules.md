# 模块详细设计 (TypeScript)

## 1. messages — 消息类型系统

**位置**: `src/wings/messages/`
**依赖**: 无

### 设计目标

定义一套统一的内部消息格式。每个 model adapter 将各 API 消息格式转换为此内部格式，agent 层只处理一种消息类型。

### 消息类型

```typescript
// types.ts

type Role = "user" | "assistant" | "system";

type MessageContent = TextBlock | ToolUseBlock | ToolResultBlock;

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

interface Message {
  role: Role;
  content: MessageContent[];
}

// 流式事件
type StreamEvent = TextDelta | ToolUseDelta | ThinkingDelta;

interface TextDelta {
  type: "text_delta";
  text: string;
}

interface ToolUseDelta {
  type: "tool_use_delta";
  id: string;
  name?: string;        // 只在首个 delta 中提供
  inputDelta: Record<string, unknown>;  // 增量 JSON
}

interface ThinkingDelta {
  type: "thinking_delta";
  text: string;
}

type StopReason = "end_turn" | "max_tokens" | "tool_use" | "stop_sequence";
```

### 跨模型转换 (MessageNormalizer)

各模型的 tool calling 格式：

| 操作 | Anthropic | OpenAI | Gemini |
|------|-----------|--------|--------|
| tool_use | `content[type="tool_use"]` | `tool_calls[]` | `parts[functionCall]` |
| tool_result | `content[type="tool_result"]` + `tool_use_id` | `role="tool"` + `tool_call_id` | `parts[functionResponse]` |
| text | `content[type="text"]` | `content` (string) | `parts[text]` |
| image | `content[type="image"]` | `content[type="image_url"]` | `parts[inlineData]` |

```typescript
// normalize.ts
interface MessageNormalizer {
  /** 将 SDK 原始消息转为内部 Message[] */
  toInternal(provider: string, rawMessages: unknown[]): Message[];
  /** 将内部 Message[] 转为目标模型的 API 格式 */
  toProvider(provider: string, messages: Message[]): unknown[];
  /** 将内部 ToolSchema[] 转为目标模型的 tools 格式 */
  toolsToProvider(provider: string, tools: ToolSchema[]): unknown[];
}
```

### 关键文件

- `types.ts` — 消息类型定义
- `normalize.ts` — `MessageNormalizer` 实现，每种 provider 一个转换函数

---

## 2. models — 模型适配层

**位置**: `src/wings/models/`
**依赖**: messages

### ModelProvider 接口

```typescript
// models/index.ts
interface ModelProvider {
  readonly providerName: string;

  chat(
    messages: Message[],
    tools: ToolSchema[] | undefined,
    config: ModelConfig,
  ): Promise<ModelResponse>;

  stream(
    messages: Message[],
    tools: ToolSchema[] | undefined,
    config: ModelConfig,
  ): AsyncGenerator<StreamEvent>;
}

interface ModelResponse {
  content: MessageContent[];
  stopReason: StopReason;
  usage: TokenUsage;
}

interface ModelConfig {
  model: string;
  temperature?: number;
  maxTokens: number;
  topP?: number;
  thinking: boolean;
  apiKey: string;
  baseUrl?: string;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
```

### Registry

```typescript
// registry.ts
class ModelRegistry {
  private providers = new Map<string, ModelProvider>();

  register(name: string, provider: ModelProvider): void;
  get(name: string): ModelProvider;
  list(): string[];
  resolveAlias(alias: string): string;  // e.g. "opus" -> "claude-opus-4-6"
  route(task: TaskRequirements): string; // 智能路由
}
```

### 首批适配器

| 文件 | 模型 | SDK |
|------|------|-----|
| `anthropic.ts` | Claude (Opus, Sonnet, Haiku) | `@anthropic-ai/sdk` |
| `openai.ts` | GPT-4o, o4-mini, o-series | `openai` |
| `google.ts` | Gemini 2.5 Pro/Flash | `@google/generative-ai` |
| `openrouter.ts` | 统一网关 | OpenAI-compatible SDK |

### capabilities.ts

```typescript
interface ModelCapabilities {
  contextWindow: number;        // 最大上下文 (tokens)
  maxOutputTokens: number;      // 最大输出
  supportsVision: boolean;      // 图片理解
  supportsThinking: boolean;    // extended thinking
  supportsTools: boolean;       // function calling
  supportsStreaming: boolean;   // 流式输出
  supportsParallelTools: boolean; // 并行 tool calls
  speedTier: "fast" | "normal" | "slow";
  costPerMInput: number;
  costPerMOutput: number;
}
```

---

## 3. tools — 工具系统

**位置**: `src/wings/tools/`
**依赖**: 无（独立模块）

### Tool 接口（泛型）

```typescript
// base.ts
interface Tool<I = any, O = any> {
  /** 唯一标识符，对应 LLM tool_use 的 name */
  name: string;
  /** 给 LLM 看的自然语言描述 */
  description: string;
  /** Zod schema 用于校验 LLM 传来的 input */
  inputSchema: z.ZodType<I>;
  /** 一句话能力描述，用于 ToolSearch 关键词匹配 */
  searchHint: string;

  /** 执行工具 */
  call(input: I, context: ToolContext): Promise<ToolResult<O>>;

  /** 环境是否可用 */
  isEnabled(): boolean;
  /** 是否只读 */
  isReadOnly(input: I): boolean;
  /** 是否不可逆 */
  isDestructive(input: I): boolean;

  /** 结果渲染 */
  renderResult(result: ToolResult<O>): string;
  /** spinner 文案 */
  getActivityDescription(input: I): string;
}

interface ToolContext {
  workingDir: string;
  env: Record<string, string>;
  sessionId: string;
  signal: AbortSignal;
}

interface ToolResult<O = any> {
  output: string;
  error?: string;
  metadata: O;
  /** 结果超过此值则写文件而不是放消息里 */
  maxResultSizeChars?: number;
}
```

### Registry

```typescript
// registry.ts
class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  listAll(): Tool[];
  listEnabled(): Tool[];
  getSchemas(): ToolSchema[];  // 生成给 LLM 的 tool schemas
  filterDenied(denyList: string[]): void;
}
```

### 首批内置工具

| 工具 | 文件 | 优先级 | 说明 |
|------|------|--------|------|
| `read` | `builtin/read.ts` | P0 | 读取文件 |
| `write` | `builtin/write.ts` | P0 | 创建/覆盖文件 |
| `edit` | `builtin/edit.ts` | P0 | 精确字符串替换 |
| `bash` | `builtin/bash.ts` | P0 | shell 命令 |
| `glob` | `builtin/glob.ts` | P1 | 文件名模式匹配 |
| `grep` | `builtin/grep.ts` | P1 | 内容正则搜索 |
| `web_fetch` | `builtin/web_fetch.ts` | P1 | 网页内容抓取 |
| `web_search` | `builtin/web_search.ts` | P1 | 网络搜索 |
| `agent_tool` | `builtin/agent_tool.ts` | P1 | 生成子 agent |

### MCP 工具加载

`tools/mcp/loader.ts` — 从 MCP 服务器加载工具，命名格式 `mcp__serverName__toolName`，支持可选 prefix 剥离。

---

## 4. query — 查询引擎

**位置**: `src/wings/query/`
**依赖**: models, messages, tools

### engine.ts

```typescript
// engine.ts
class QueryEngine {
  constructor(
    private normalizer: MessageNormalizer,
    private registry: ModelRegistry,
  ) {}

  /** 流式查询 — 返回 AsyncGenerator */
  async *stream(
    messages: Message[],
    model: string,
    tools: ToolSchema[],
    config: ModelConfig,
  ): AsyncGenerator<StreamEvent | Message> {
    const provider = this.registry.get(model);
    const providerMessages = this.normalizer.toProvider(provider.providerName, messages);
    const providerTools = this.normalizer.toolsToProvider(provider.providerName, tools);

    for await (const event of provider.stream(providerMessages, providerTools, config)) {
      yield this.normalizer.toInternalEvent(event);
    }
  }

  /** 非流式查询 */
  async chat(
    messages: Message[],
    model: string,
    tools: ToolSchema[],
    config: ModelConfig,
  ): Promise<ModelResponse>;
}
```

职责：
- 通过 normalizer 转换消息格式
- 调用 model provider 的 `stream()` / `chat()`
- 将响应转回内部格式
- 处理 API 错误，重试 + 降级 fallback 模型
- Token 计数

### token_budget.ts

```typescript
// token_budget.ts
class TokenBudget {
  constructor(
    private contextWindow: number,
    private reservedForOutput: number,  // 留给输出的配额
    private systemPromptTokens: number,
  ) {}

  remaining(messages: Message[]): number;
  needsCompact(messages: Message[]): boolean;
  estimateTokens(text: string): number;
}
```

---

## 5. agent — Agent 核心循环

**位置**: `src/wings/agent/`
**依赖**: query, tools, messages, permissions

### loop.ts

```typescript
// loop.ts
class AgentLoop {
  async *run(
    userInput: string,
    context: AgentContext,
  ): AsyncGenerator<AgentEvent> {
    const messages = this.assembleMessages(userInput, context);
    const model = this.selectModel(context);

    while (true) {
      let hadToolUse = false;

      for await (const event of this.queryEngine.stream(messages, model, tools, config)) {
        if (event.type === "tool_use") {
          // 权限检查
          const decision = await this.permissionPipeline.check(event.name, event.input, toolContext);
          if (decision === "deny") {
            messages.push(this.injectError(event.id, "Permission denied"));
            hadToolUse = true;
            break;
          }
          // 执行工具
          const tool = this.toolRegistry.get(event.name);
          const result = await tool!.call(event.input, toolContext);
          messages.push({ role: "user", content: [{ type: "tool_result", toolUseId: event.id, content: result.output }] });
          hadToolUse = true;
          break;
        }
        yield event; // 文本、thinking 等直接输出
      }

      if (!hadToolUse) return; // end_turn
    }
  }
}
```

### subagent.ts

子 agent 生成：
- 独立 AgentLoop 实例，受限工具集（只读为主）
- fork 语义：继承父 agent 的部分上下文
- `builtin/agent_tool.ts` 调用此逻辑

### coordinator.ts

多 agent 协调器：
- 复杂任务分解
- 分配给不同子 agent（可用不同模型）
- 结果汇总

### resume.ts

从持久化 transcript 恢复会话：
- 重建 Message[] 历史
- 恢复 agent 状态

---

## 6. permissions — 权限系统

**位置**: `src/wings/permissions/`
**依赖**: tools

### pipeline.ts

```typescript
type PermissionResult = "allow" | "deny" | "ask";

class PermissionPipeline {
  async check(
    toolName: string,
    toolInput: unknown,
    context: ToolContext,
  ): Promise<PermissionResult> {
    // Stage 1: 静态规则
    const staticResult = this.rules.match(toolName);
    if (staticResult !== "ask") return staticResult;

    // Stage 2: 自动分类（只读操作自动放行）
    const tool = this.toolRegistry.get(toolName);
    if (tool?.isReadOnly(toolInput)) return "allow";

    // Stage 3: hooks
    const hookResult = await this.hookRunner.runPreToolUse(toolName, toolInput);
    if (hookResult) return hookResult;

    // Stage 4: 交互式审批
    return "ask"; // 交给 UI 处理
  }
}
```

### rules.ts

```typescript
class PermissionRules {
  allowlist: Set<string>;   // 始终允许
  denylist: Set<string>;    // 始终拒绝
  asklist: Set<string>;     // 每次询问

  match(toolName: string): "allow" | "deny" | "ask";
  addAllow(toolName: string): void;
  addDeny(toolName: string): void;
}
```

---

## 7. hooks — 生命周期钩子

**位置**: `src/wings/hooks/`
**依赖**: 无

### types.ts

```typescript
enum HookEvent {
  PreToolUse = "pre_tool_use",
  PostToolUse = "post_tool_use",
  UserPromptSubmit = "user_prompt_submit",
  SessionStart = "session_start",
  Stop = "stop",
  PreCompact = "pre_compact",
  Notification = "notification",
}

interface HookConfig {
  event: HookEvent;
  command: string;           // shell 命令或脚本路径
  matcher?: string;          // 可选：仅匹配特定工具名的正则
}
```

### runner.ts

钩子可以：
- `updatedInput` — 修改工具输入
- `decision: "block"` — 阻止操作
- `additionalContext` — 向模型注入额外上下文
- `systemMessage` — 向用户显示系统消息
- `suppressOutput` — 隐藏工具输出

---

## 8. config — 配置系统

**位置**: `src/wings/config/`
**依赖**: 无

### 分层配置（优先级从高到低）

```
CLI 参数 > 环境变量 > 项目配置 (.wings.toml) > 全局配置 (~/.wings/config.json) > 内置默认
```

### global_config.ts

```typescript
interface GlobalConfig {
  defaultModel: string;         // 默认模型，如 "claude-sonnet-4-6"
  apiKeys: Record<string, string>; // { anthropic: "sk-...", openai: "sk-..." }
  theme: "dark" | "light";
  autoCompact: boolean;
  customEndpoints: Record<string, string>; // 自定义 API endpoint
}

function loadGlobalConfig(): GlobalConfig;
function saveGlobalConfig(config: GlobalConfig): void;
```

### project_config.ts

```typescript
interface ProjectConfig {
  allowedTools: string[];         // 工具白名单
  deniedTools: string[];          // 工具黑名单
  model: string | null;           // 项目级模型覆盖
  mcpServers: string[];           // 启用的 MCP 服务器
  hooks: Record<string, string[]>; // 项目级 hooks
  personality: string | null;     // 追加到 system prompt
}

function loadProjectConfig(dir: string): ProjectConfig;
```

### settings.ts

多层设置合并，通过 `getSetting(key, sources)` API 按优先级 fallback。

---

## 9. context — 上下文收集

### system_prompt.ts

组装系统提示词，包含：
- 工具列表描述（从 ToolRegistry.getSchemas() 生成）
- 环境信息（OS, shell, date, git status）
- 行为指引（"一切皆工具"、"先读再改"、"简洁回复" 等）

### environment.ts

```typescript
interface Environment {
  os: string;
  shell: string;
  workingDir: string;
  date: string;
  gitBranch?: string;
  gitStatus?: string;
}
```

---

## 10. 其他模块

### memory — 持久化记忆
- `memory/store.ts` — 文件系统存储，按类型分文件（user, project, feedback, reference）
- 格式：markdown + frontmatter

### skills — 可复用技能
- `skills/loader.ts` — 从 `~/.wings/skills/` 等目录加载 `.md` 技能定义
- 技能 = 预定义 prompt + 可选工具组合

### plugins — 插件系统
- `plugins/loader.ts` — 从 npm 包或本地路径加载插件
- 插件可提供：tools、模型适配器、hooks

### services — 外部服务
- `services/api/` — HTTP 客户端（重试、超时、代理）
- `services/mcp/` — MCP client/server 实现
- `services/analytics/` — 用量统计

---

## 11. 实施顺序

| 阶段 | 模块 | 关键文件 | 可验证 |
|------|------|----------|--------|
| 1 | messages | `types.ts`, `normalize.ts` | 单元测试：Anthropic/OpenAI 消息转换 |
| 2 | models | `index.ts`, `anthropic.ts`, `openai.ts`, `registry.ts`, `capabilities.ts` | 单元测试：mock API |
| 3 | tools | `base.ts`, `registry.ts`, `builtin/read.ts`, `builtin/write.ts`, `builtin/bash.ts` | 单元测试：工具执行 |
| 4 | query | `engine.ts`, `token_budget.ts` | 集成测试：model + messages + tools |
| 5 | permissions | `pipeline.ts`, `rules.ts` | 单元测试：权限判断 |
| 6 | agent | `loop.ts`, `subagent.ts` | E2E：完整 agent 运行 |
| 7 | config | `global_config.ts`, `project_config.ts`, `settings.ts` | 单元测试：配置读取 |
| 8 | cli | `main.ts`, `bootstrap.ts`, `repl.ts` | 手动：`wings "hello"` |
| 9+ | hooks, memory, skills, plugins, MCP | 各模块 | 后续迭代 |
