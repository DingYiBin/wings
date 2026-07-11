# Claude Code Subagent 系统

## 架构概述

Subagent 是**进程内的独立 `query()` 循环**。主 agent 调用 `Agent` tool 来 spawn，child 在自己的 query loop 中运行，完成后结果返回 parent。

## Agent 类型

Agent 通过 `AgentDefinition` 类型定义，有三种子类型：

| 子类型 | 来源 | 说明 |
|--------|------|------|
| `BuiltInAgentDefinition` | `'built-in'` | 动态 system prompt 函数 |
| `CustomAgentDefinition` | `userSettings/projectSettings/policySettings/flagSettings` | 闭包捕获的 system prompt |
| `PluginAgentDefinition` | `'plugin'` | 携带 plugin 元数据 |

### 内置 Agent（6 种）

| 类型 | 用途 | 工具 | 模型 | 备注 |
|---|---|---|---|---|
| `general-purpose` | 通用研究、搜索、多步骤任务 | `*`（全部） | inherit | 默认 agent |
| `Explore` | 只读文件搜索 | 禁止 Write/Edit/Agent/ExitPlanMode | haiku（外部）/ inherit（内部） | omitClaudeMd: true |
| `Plan` | 软件架构设计、实现计划 | 禁止 Write/Edit/Agent/ExitPlanMode | inherit | omitClaudeMd: true |
| `statusline-setup` | 配置状态行设置 | 仅 Read/Edit | sonnet | |
| `claude-code-guide` | 回答 Claude Code/Agent SDK/API 问题 | Glob/Grep/Read/WebFetch/WebSearch | haiku | permissionMode: dontAsk |
| `verification` | 验证实现正确性（PASS/FAIL/PARTIAL） | 禁止 Write/Edit/Agent | inherit | background: true（始终后台） |

Explore 和 Plan 被标记为 `ONE_SHOT_BUILTIN_AGENT_TYPES`，跳过 agentId/SendMessage/usage trailer 以节省 token。

### 自定义 Agent

通过 `.claude/agents/` 目录下的 markdown 文件定义（YAML frontmatter + markdown body）。也支持 JSON 设置定义。

优先级（从低到高）: built-in < plugin < userSettings < projectSettings < flagSettings < policySettings

### AgentDefinition 字段

```
agentType, whenToUse, tools, disallowedTools, skills, mcpServers, hooks,
color, model, effort, permissionMode, maxTurns, filename, baseDir,
background, initialPrompt, memory, isolation, omitClaudeMd
```

## Agent 生命周期

### Spawn 流程

1. 权限检查
2. Agent 类型解析（从 activeAgents 查找 effectiveType）
3. MCP server 等待（如有 requiredMcpServers，最多等 30s）
4. 模型解析（`getAgentModel()` 优先级链）
5. Worktree 设置（如 `isolation === 'worktree'`）
6. System prompt 构建 + 环境信息增强
7. 异步/同步决策

### 同步执行

- Parent 阻塞等待 child 完成
- 通过 generator 流式传递进度消息
- 120s 后自动转为 background（可配置）
- 完成后调用 `finalizeAgentTool()` 构建结果

### 异步执行

- 注册到 AppState 作为 async task
- 返回 `{ status: 'async_launched', agentId, outputFile }`
- 完成后通过 `<task-notification>` 注入 parent 会话
- 生命周期: 运行 → completeAsyncAgent / killAsyncAgent / failAsyncAgent

### runAgent() 核心

所有 agent 类型共享的 `runAgent()` 函数（~975 行）:
1. 构建 system prompt + user context + system context
2. 配置 permission mode
3. 解析工具集
4. 初始化 MCP server
5. 预加载 skills
6. 执行 SubagentStart hooks
7. 在循环中调用 `query()` 直到完成
8. finally: 清理 MCP/session hooks/cache/todos/bash tasks

## 上下文隔离

### 普通 Subagent（指定 subagent_type）

- **零上下文启动** — 只有 task prompt 作为初始 user message
- 独立的 system prompt
- 可选的 CLAUDE.md 上下文（omitClaudeMd 控制）
- 独立的 readFileState cache
- 独立的 MCP 连接

### Fork Subagent（不指定 subagent_type）

- **继承 parent 全部上下文** — 所有 parent 消息作为 forkContextMessages
- 共享 parent system prompt（最大化 prompt cache 命中）
- 使用 parent 的 exact tool pool
- 继承 thinking config
- `buildForkedMessages()` 构建消息，使只有最后的 text block 不同
- 递归 fork 保护：`isInForkChild()` 检查历史防嵌套

### Isolation 模式

- **Worktree**: 创建临时 git worktree，干净沙箱。有修改时保留，无修改自动清理
- **Remote**（内部）: 在远程 CCR 环境中启动

## 工具访问

### 全局禁止列表 (ALL_AGENT_DISALLOWED_TOOLS)

TaskOutput, ExitPlanMode, EnterPlanMode, AskUserQuestion, TaskStop, Agent（外部用户）

### 异步 Agent 额外限制

仅允许: Read, WebSearch, TodoWrite, Grep, WebFetch, Glob, 所有 shell 工具, Edit, Write, NotebookEdit, Skill, SyntheticOutput, ToolSearch, EnterWorktree, ExitWorktree

### 工具解析流程 (resolveAgentTools)

1. `filterToolsForAgent()` — 过滤全局禁止工具
2. 应用 agent 的 `disallowedTools`
3. 如果 `tools` 为 undefined 或 `['*']` → 全部通过
4. 否则精确匹配 tools 列表

## 模型选择

优先级（`getAgentModel()`）:
1. `CLAUDE_CODE_SUBAGENT_MODEL` 环境变量（最高优先级）
2. Tool 调用的 `model` 参数
3. Agent 定义的 `model` 字段
4. 默认 `'inherit'`（使用 parent 模型）

`inherit` 逻辑：
- 调用 `getRuntimeMainLoopModel()` 获取 parent 主循环模型
- 如果 alias 匹配 parent 模型 tier，使用 parent 的精确模型字符串
- 否则解析用户指定的模型名
- Bedrock 用户继承跨区域推理前缀

Fork subagent 始终 `model: 'inherit'`，保持 context 长度一致和 prompt cache 兼容。

## 并发

- 单次 assistant message 可包含多个 Agent tool_use → 并行启动
- Foreground: parent 阻塞，结果立即可用
- Background (`run_in_background: true`): parent 立即继续
- Auto-background: 同步 agent 超时（默认 120s）后自动转后台
- Agent 级别 `background: true`（如 verification）始终后台
- 防递归: teammates 不能再 spawn teammates

## 权限模型

- 默认 permission mode: `'acceptEdits'`
- `claude-code-guide`: `'dontAsk'`（自动批准一切）
- Async agent: `shouldAvoidPermissionPrompts: true`
- Fork subagent: `'bubble'` mode（权限提示冒泡到 parent 终端）
- Handoff 安全检查: `classifyHandoffIfNeeded()` 对 subagent transcript 运行安全分类器

## Agent Memory

通过 `memory` 字段支持持久化记忆（`'user'`/`'project'`/`'local'` scope）。启用时自动注入 Write/Edit/Read 工具。记忆存储为 markdown 文件。

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/tools/AgentTool/AgentTool.tsx` | Agent tool 定义、input/output schema、call()、spawn 逻辑 |
| `src/tools/AgentTool/runAgent.ts` | 核心执行引擎（975行），所有 agent 类型共用 |
| `src/tools/AgentTool/loadAgentsDir.ts` | AgentDefinition 类型、markdown/JSON 解析、优先级 |
| `src/tools/AgentTool/builtInAgents.ts` | 内置 agent 注册表 |
| `src/tools/AgentTool/prompt.ts` | Agent tool 的 tool description/system prompt 文本生成 |
| `src/tools/AgentTool/agentToolUtils.ts` | 工具过滤/解析、结果构建、async 生命周期、handoff 分类 |
| `src/tools/AgentTool/forkSubagent.ts` | Fork subagent 上下文继承、消息构建、递归保护 |
| `src/tools/AgentTool/resumeAgent.ts` | Agent transcript 恢复 |
| `src/tools/AgentTool/constants.ts` | 常量定义 |
| `src/tools/AgentTool/agentMemory.ts` | Agent 持久化记忆 |
| `src/utils/model/agent.ts` | Agent 模型选择逻辑 |
| `src/constants/tools.ts` | 全局工具 allow/deny 集合 |
| `src/utils/swarm/inProcessRunner.ts` | 进程内 teammate 执行 |
