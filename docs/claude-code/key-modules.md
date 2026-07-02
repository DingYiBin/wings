# Claude Code — 关键模块

## 1. 入口点 (`src/entrypoints/`)

- **`cli.tsx`**: 实际入口。启动 CLI。
- **`init.ts`**: `init()` 函数：启用配置、安全环境变量、优雅关闭、遥测初始化、预连接 Anthropic API、全局代理/MTLS。用 `memoize()` 包装以实现幂等性。

## 2. Bootstrap 状态 (`src/bootstrap/state.ts`)

~600 行可变状态模块，持有会话级值:
- `originalCwd`, `projectRoot`, `cwd`
- 模型设置 (`mainLoopModelOverride`, `initialMainLoopModel`, `modelStrings`)
- 成本/令牌跟踪累加器
- 遥测 providers (OTEL meters, loggers, tracers)
- Session ID, parent session ID
- 分析计数器 (代码行数, PRs, commits)
- 认证令牌
- Feature flags
- Agent 颜色映射
- Hook 事件切换状态

## 3. AppState (`src/state/`)

- **`store.ts`**: 最小 Redux-like store。`createStore(initialState, onChange?)` 返回 `{ getState, setState, subscribe }`。
- **`AppStateStore.ts`**: AppState 类型定义 — `DeepImmutable` 对象，包含 UI 状态 (消息、命令、工具、权限上下文、瞬态 UI flags)。
- **`AppState.tsx`**: React Context Provider。

## 4. 工具系统 (`src/tools/`)

**`Tool.ts`** 定义了 ~450 行的 `Tool` 接口:
- `name`, `aliases`, `searchHint`
- `call(args, context, canUseTool, parentMessage, onProgress?)` 返回 `ToolResult<Output>`
- `description(input, options)` 返回动态 prompt 文本
- `inputSchema` (Zod), `inputJSONSchema`, `outputSchema`
- `inputsEquivalent(a, b)` 判断输入是否等价
- `isConcurrencySafe(input)`, `isEnabled()`, `isReadOnly(input)`, `isDestructive(input)`
- `isSearchOrReadCommand(input)` 返回 `{ isSearch, isRead, isList? }`
- `isOpenWorld(input)`, `requiresUserInteraction()`, `shouldDefer`, `alwaysLoad`

**核心工具 (始终加载)**: BashTool, FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool, NotebookEditTool, WebFetchTool, WebSearchTool, TaskCreateTool, TaskUpdateTool, TaskOutputTool, AskUserQuestionTool, LSPTool, ToolSearchTool, EnterPlanModeTool, ExitPlanModeV2Tool, EnterWorktreeTool, ExitWorktreeTool

**Feature-gated 工具**: REPLTool, SleepTool, CronCreateTool/DeleteTool/ListTool, RemoteTriggerTool, MonitorTool, SendUserFileTool 等

## 5. 命令系统 (`src/commands/`)

~50+ 斜杠命令:
- **核心**: commit, review, compact, mcp, config, doctor, login/logout, memory, skills, tasks, vim, diff, cost, theme, context, resume, share, desktop, mobile, init, status
- **Feature-gated**: proactive, bridge, voice, assistant, workflows

## 6. Query Engine (`src/QueryEngine.ts`)

核心 LLM API 调用器 (~46KB):
- 使用 @anthropic-ai/sdk 客户端
- 调用 `processUserInput()` 编排主查询循环
- 委托 `query()` 执行实际 API 往返
- 处理流式响应、工具调用循环、thinking mode
- 管理令牌计数、成本跟踪、重试逻辑
- 支持多模型提供商 (Anthropic API, AWS Bedrock, Google Vertex, GCP Foundry)

## 7. 查询管道 (`src/query.ts`)

查询循环:
1. 构建消息 (system prompt, user context, attachments)
2. 调用 Claude API (带 tools)
3. 解析流式响应
4. 执行工具调用 via `runTools()` 编排
5. 应用工具结果预算
6. 处理 auto-compact 边界
7. 管理令牌警告状态

## 8. 服务层 (`src/services/`)

| 服务 | 用途 |
|------|------|
| API Client | Anthropic SDK 初始化/配置 |
| MCP | 完整 MCP 客户端：连接管理、配置、OAuth、传输层 (SSE, WebSocket, InProcess) |
| LSP | Language Server Protocol 管理器 |
| OAuth | OAuth 2.0 认证流程 |
| Analytics | GrowthBook feature flags, Statsig, 事件日志, OpenTelemetry, Datadog |
| Compact | 上下文压缩 (auto-compact, micro-compact, reactive compact) |
| Policy Limits | 组织级使用限制 |
| Plugins | 插件 CLI 命令 |
| Voice | 语音输入处理 |

## 9. 桥接系统 (`src/bridge/`)

IDE 扩展 (VS Code/JetBrains) 与 CLI 的双向通信:
- `bridgeMain.ts` — 主循环，指数退避重连
- `bridgeMessaging.ts` — 消息协议
- `replBridge.ts` — 将本地 REPL 桥接到远程会话
- `sessionRunner.ts` — 生成和管理桥接会话
- 支持 capacity wake, trusted device tokens, work secrets

## 10. Coordinator (`src/coordinator/`)

多 agent 编排模式:
- 通过 `AgentTool` 生成的 worker 获得受限工具集
- `isCoordinatorMode()` 检查环境变量
- `matchSessionMode()` 确保恢复的会话重新进入正确模式

## 11. 技能系统 (`src/skills/`)

- **`bundled/`**: 内置技能 (update-config, keybindings, verify, debug, skillify, remember, simplify, batch, stuck, loop, dream, hunter 等)
- 每个技能有 `isEnabled()` 回调用于动态门控
- 技能在启动时通过 `registerBundledSkill()` 注册
- 用户安装的技能从目录加载

## 12. 快捷键系统 (`src/keybindings/`)

- **`schema.ts`**: Zod schema
- **`parser.ts`**: 解析组合键字符串 (如 `Ctrl+C`)
- **`resolver.ts`**: 按键匹配
- **`defaultBindings.ts`**: 默认快捷键
- **`useKeybinding.ts`**: React hook

## 13. Vim 模式 (`src/vim/`)

有限状态机实现:
- **`types.ts`**: Vim 模式类型 (Normal, Insert, Visual)
- **`motions.ts`**: 光标移动 (w, b, e, f, t)
- **`operators.ts`**: 操作 (d, c, y) 与 motion 组合
- **`textObjects.ts`**: 文本对象 (iw, aw, i")
- **`transitions.ts`**: 模式间状态转换

## 14. 记忆系统 (`src/memdir/`)

- MEMORY.md 自动记忆
- 会话结束时自动保存学习内容
- 入口大小限制 (200行, 25KB)
- 团队记忆同步 (feature-gated)
- 作为 `nested_memory` attachments 注入 system prompt
