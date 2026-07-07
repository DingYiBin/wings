# Wings Python → TypeScript 完整重写计划

> 创建: 2026-07-06

## Context

当前 wings 是 Python 实现的多模型 AI agent CLI（~6,700 LOC，13 模块，283 测试）。核心差异化特性是**多 API 池 + softmax 加权随机选择**（每次 API 调用独立选模型）。

用户决定用 TypeScript (Bun) 完全重写，参考 `reference/claude-code/`（~129K LOC TS/Bun）。重写目标：
- 运行时：**Bun**
- UI：**Ink/React**（匹配参考实现）
- 架构：**移植当前扁平 agent loop**（不做 orchestrator-worker）
- 仓库布局：**完全替换 `src/wings/` Python 代码**

## 依赖链

`messages/routing` (无依赖) → `models` → `tools` → `query/permissions` → `agent` → `config/skills/memory/hooks/mcp` → `cli`

## 目录结构

```
package.json, tsconfig.json, bunfig.toml
src/
  index.ts                    # bin 入口
  messages/{types,normalize}.ts
  routing/{types,selector,manager,tasks,protocol}.ts
  models/{protocol,anthropic,openai,registry,capabilities}.ts
  tools/{types,registry}.ts + builtin/{read,write,edit,bash,glob,grep,skill_view,agent,web_fetch,web_search}.ts
  query/{engine,token_budget}.ts
  permissions/{rules,pipeline}.ts
  agent/{loop,handoff,subagent,agent_loader}.ts
  services/compact.ts
  config/settings.ts
  skills/{types,loader,injector,builtin_data}.ts
  memory/{types,loader,extractor}.ts
  hooks/{types,runner}.ts
  mcp/{client,loader}.ts
  cli/{bootstrap,main,logging}.ts + REPL.tsx + components/*.tsx
tests/*.test.ts
```

## 依赖

`@anthropic-ai/sdk`, `openai`, `@modelcontextprotocol/sdk`, `zod`, `ink`, `react`, `yaml`, `html-to-text`, `zod-to-json-schema`。devDeps: `typescript`, `@types/react`。

## 核心类型

```typescript
// messages
type Role = "user" | "assistant" | "system";
interface Message { role: Role; content: MessageContent[] }  // TextBlock|ToolUseBlock|ToolResultBlock
type StreamEvent = TextDelta | ToolUseDelta | ThinkingDelta | TextBlock | ToolUseBlock | ToolResultBlock | SubAgentStart | SubAgentDelta | SubAgentEnd | PermissionRequest;

// routing (wings 独有)
interface PoolEntry { api_id: string; score: number }  // -Infinity = disabled
interface PoolConfig { version: number; apis: PoolEntry[]; masks: Record<string, Record<string, number>> }

// models
interface ModelConfig { model, max_tokens=8000, escalated_max_tokens=64000, thinking=true, thinking_budget?, context_window=200000, api_key, base_url? }

// tools — buildTool() 模式（参考 claude-code Tool.ts）
type ToolDef<I> = { name, description, search_hint, inputSchema: z.ZodType, call(input, ctx): Promise<ToolResult>, is_read_only?, is_destructive?, ... }
type Tool = Required<ToolDef>
function buildTool<I>(def: ToolDef<I>): Tool  // 填充默认值

// agent
interface AgentContext { task_type, model_override, tool_context, system_prompt }
```

## Agent Loop（异步生成器）

```typescript
async *run(user_input, context, config?): AsyncGenerator<StreamEvent> {
  while (true) {
    const model = this._selectModel(context);  // 每次 API 调用独立选模型
    if (this._needsCompact(context, cfg)) await this._compactMessages(...);
    for await (const event of this._query_engine.stream(...)) yield event;
    // 收集 tool_use_blocks → 权限检查 → 执行 → yield 结果
    if (no tools) return;
  }
}
```

权限同步：Python `asyncio.Event` → TS `Promise` + resolver 模式。`APIPoolManager` 无需锁（JS 单线程）。

## 8 个阶段（每阶段一次 commit）

### Phase 1: 项目初始化 + messages + routing ✅ `4ce6745`
- **[done]** 创建 `package.json`/`tsconfig.json`/`bunfig.toml`
- **[done]** `src/messages/{types,normalize}.ts` — 类型 + Anthropic/OpenAI 双向转换
- **[done]** `src/routing/{types,selector,manager,tasks,protocol}.ts` — softmax 选择、池管理、任务继承链
- **[done]** `tests/ts/messages.test.ts`, `tests/ts/routing.test.ts` — 57 tests

### Phase 2: models ✅ `92b957e`
- **[done]** `src/models/{protocol,anthropic,openai,registry,capabilities}.ts`
- **[done]** AnthropicProvider：流式 + max_tokens 升级（8K→64K）
- **[done]** OpenAIProvider：async streaming
- **[done]** `tests/ts/models.test.ts` — 77 total tests

### Phase 3: tools 框架 + 内置工具 ✅ `16b52f0`
- **[done]** `src/tools/{types,registry}.ts` — `buildTool()` + Zod schema
- **[done]** 9 个内置工具：read/write/edit/bash/glob/grep/skill_view/web_fetch/web_search
- **[done]** agent 工具推迟到 Phase 5（依赖 subagent 模块）
- **[done]** `tests/ts/tools.test.ts` — 112 total tests

### Phase 4: query + permissions ✅ `1fc2c09`
- **[done]** `src/query/{engine,token_budget}.ts` — 重试逻辑 + token 预算
- **[done]** `src/permissions/{rules,pipeline}.ts` — 4 阶段管道
- **[done]** `tests/ts/query.test.ts`, `tests/ts/permissions.test.ts` — 144 total tests

### Phase 5: agent loop + subagent + compaction 🔲
- `src/agent/{loop,handoff,subagent,agent_loader}.ts`
- `src/services/compact.ts`
- `src/tools/builtin/agent.ts` — agent 工具
- `tests/agent.test.ts`, `tests/subagent.test.ts`, `tests/compact.test.ts`

### Phase 6: config + skills + memory + hooks + mcp 🔲
- `src/config/settings.ts` — 2 文件 deep merge（无 pydantic-settings）
- `src/skills/` — 3 层加载、SKILL.md frontmatter
- `src/memory/` — MEMORY.md + 4 类型 + 提取器
- `src/hooks/` — shell 命令钩子
- `src/mcp/` — stdio transport + 工具适配
- 对应 5 个测试文件

### Phase 7: CLI + bootstrap ✅
- **[done]** `src/cli/{bootstrap,main}.ts` — 组合根 + 入口
- **[done]** `src/index.ts` — `wings chat` / `wings run` 可用
- **[done]** Minimal REPL (readline-based), `/pool`, `/help` commands
- Ink/React TUI 保留为后续优化

### Phase 8: 移除 Python + 收尾 🔲
- 删除 `src/wings/`、`tests/`（Python）、`pyproject.toml`、`uv.lock`
- 更新 README
- 全量测试 `bun test`
- 烟雾测试：`bun run src/index.ts chat` 和 `bun run src/index.ts run "hello"`

## 测试策略

283 个 Python 测试 → Bun 测试 1:1 移植。16 个 `*.test.ts` 文件。用 `bun:test` 的 `describe/test/expect`。Mock provider 用假 `ModelProvider` 实现。文件系统测试用 `fs.mkdtemp()` 临时目录。

## 关键决策

1. **buildTool 而非类/装饰器** — 参考 claude-code，plain object + Zod，更简洁
2. **权限同步** — `Promise` + resolver 替代 `asyncio.Event`
3. **APIPoolManager 无锁** — JS 单线程
4. **配置兼容** — 同样的 `~/.wings/config.json` + `.wings/config.json` JSON schema
5. **文件格式兼容** — SKILL.md / MEMORY.md / agents/*.md 格式不变

## 验证

- [ ] `bun test` 全过（16 测试文件，~283 测试）
- [ ] `bun run src/index.ts chat` 交互式 REPL 可用
- [ ] `bun run src/index.ts run "prompt"` 单轮可用
- [ ] `/pool`、`/help`、`/<skill>` 斜杠命令可用
- [ ] MCP server 可连接、工具可见
- [ ] 配置文件加载正确
