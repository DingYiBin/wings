# Claude Code — 项目概述

## 是什么

Claude Code 是 Anthropic 的官方 CLI 工具，让用户在终端中直接与 Claude 交互，完成软件工程任务：编辑文件、执行 shell 命令、搜索代码库、管理 git 工作流等。

- **语言**: TypeScript (strict mode)
- **运行时**: Bun (v1.3+)
- **终端 UI**: React 19 + Ink (React 的 CLI 渲染器)
- **规模**: ~1900 文件, ~512,000 行代码
- **入口**: `bun run src/entrypoints/cli.tsx`
- **CLI 框架**: Commander.js

## 顶层目录结构

| 目录 | 用途 |
|------|------|
| `src/entrypoints/` | CLI 启动入口 (`cli.tsx`, `init.ts`) |
| `src/bootstrap/` | 全局可变状态 (session, telemetry, config flags) |
| `src/state/` | 不可变 UI 状态: `AppState` + React Context + `createStore` |
| `src/screens/` | 全屏 Ink UI 组件 (REPL, Doctor, ResumeConversation) |
| `src/components/` | ~140 个 Ink/React 组件 (消息显示、输入框、对话框、权限等) |
| `src/tools/` | ~40 个 agent 工具实现 (Bash, FileRead/Write/Edit, Grep, Glob, Agent, MCP, LSP 等) |
| `src/commands/` | ~50 个斜杠命令实现 (commit, review, doctor, mcp, config 等) |
| `src/services/` | 外部服务集成和业务逻辑 |
| `src/hooks/` | REPL UI 的 React hooks (权限、输入、轮询、状态管理) |
| `src/utils/` | ~200+ 工具模块 (文件 I/O, git, auth, 权限, 设置, shell 等) |
| `src/bridge/` | IDE 集成桥接 (VS Code / JetBrains 双向通信) |
| `src/coordinator/` | 多 agent 协调模式 |
| `src/plugins/` | 插件系统 (内置注册、市场、加载) |
| `src/skills/` | 技能系统 (可复用工作流) |
| `src/keybindings/` | 可定制快捷键系统 |
| `src/vim/` | Vim 模式输入处理 |
| `src/ink/` | Ink 渲染器封装、终端 I/O、主题系统 |
| `src/memdir/` | 持久化记忆 (MEMORY.md 自动记忆) |
| `src/migrations/` | 配置迁移脚本 |
| `src/schemas/` | Zod 校验 schema |
| `src/mcp/` | MCP 客户端 (连接管理、OAuth、传输层) |
| `src/lsp/` | LSP 管理器 |
