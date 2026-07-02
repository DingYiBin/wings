# Claude Code — 架构设计

## 分层架构

```
[CLI Entry (Commander.js)]
    --> [Init Layer (config, env, auth, telemetry)]
        --> [REPL Screen (React/Ink TUI)]
            --> [Query Engine (API communication)]
                --> [Tool System (40+ tools)]
                    --> [Tool Orchestration]
                --> [Permission System (hooks/classifiers)]
            --> [Command System (50+ slash commands)]
        --> [Bridge System (IDE integration)]
    --> [Services Layer (MCP, LSP, OAuth, analytics 等)]
```

## 核心设计模式

### 1. Tool-As-Module 模式

每个工具 (`src/tools/XTool/`) 是自包含模块:
- TypeScript `Tool<Input, Output, Progress>` 定义
- Zod input schema
- `call()` 方法 (执行逻辑)
- `description()` 方法 (动态 prompt 文本)
- `isEnabled()`, `isReadOnly()`, `isConcurrencySafe()`, `isSearchOrReadCommand()` 钩子
- `UI.tsx` 组件 (终端进度渲染)
- `prompt.ts` (工具的系统提示描述)

### 2. Command-As-Module 模式

与工具类似，每个斜杠命令 (`src/commands/`) 都是自包含模块，有 `isEnabled()`, `name`, 和执行处理器。

### 3. Feature Flag 死代码消除 (`bun:bundle`)

`feature()` 函数在构建时由 Bun 剥离未激活 flags 对应的代码路径。开发时 shim 通过 `FEATURE_FLAGS` 环境变量解析。关键 flags: `PROACTIVE`, `KAIROS`, `BRIDGE_MODE`, `DAEMON`, `VOICE_MODE`, `AGENT_TRIGGERS`, `COORDINATOR_MODE`, `DIRECT_CONNECT`, `SSH_REMOTE`。

### 4. 双层状态系统

- **Bootstrap state** (`src/bootstrap/state.ts`): 可变、会话级状态。每个字段导出独立的 getter/setter 函数对。
- **AppState** (`src/state/AppStateStore.ts`): 不可变、React 管理的 UI 状态，通过 `createStore` (轻量级 Redux-like store) 管理。

### 5. 延迟加载 / 动态导入

- OpenTelemetry SDK (~400KB) 延迟加载
- gRPC exporters (~700KB) 仅在 telemetry 激活时加载
- React/Ink 组件在调用点动态加载

### 6. 启动时并行预取

在模块图评估前并行发起多个异步操作:
- `startMdmRawRead()` — MDM 子进程
- `startKeychainPrefetch()` — macOS keychain 读取
- 在 Commander `preAction` 钩子中 await 结果

### 7. 权限管道模式

多层权限检查组合为管道:
1. 静态规则 (always-allow / always-deny / always-ask)
2. Hooks (PreToolUse shell hook)
3. Classifier (AutoMode: 轻量级 Claude 调用自动分类)
4. 交互式对话框 (回退到终端对话框)

每层可以做出决定或传递给下一层。`ResolveOnce` 模式确保只有一层"胜出"。

### 8. Schema-First 校验

所有用户配置 (settings.json, CLAUDE.md, MCP configs, keybindings) 都通过 Zod schema 校验。

### 9. 事件汇架构

Analytics 事件排队直到 sink 被附件。`initSinks()` 是幂等的，可从多个代码路径调用。
