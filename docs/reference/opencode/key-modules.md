# OpenCode — 关键模块

## 1. 核心库 — `packages/core/`

整个系统的业务核心，包含：

### 会话管理 (`src/session/`)
- **runner**: 会话运行器，管理 turn loop
- **execution**: 工具执行编排
- **context**: 上下文组装（系统提示、附件、引用）
- **history**: 消息历史管理
- **compaction**: 上下文压缩（auto-compact）
- **events**: 事件溯源
- **projectors**: 事件投影器（从事件流重建状态）
- **prompts**: 提示模板管理
- **message**: 消息类型和处理

### 工具系统 (`src/tool/`)
内置工具集：
- **文件**: read, write, edit, glob
- **搜索**: grep, ripgrep
- **Shell**: bash 执行（PTY）
- **Web**: web_search, web_fetch
- **Agent**: agent（生成子代理）
- **其他**: question, skill, apply-patch, registry
- 工具注册中心和调度器

### 插件系统 (`src/plugin/`)
- **host**: 主机插件（运行时级别）
- **agent**: 代理插件
- **command**: 命令插件
- **skill**: 技能插件
- **variants**: 变体/模型特定插件
- 30+ 内置 LLM 提供商实现

### 配置 (`src/config/`)
- agent config
- attachments config
- commands config
- experimental features
- formatter config
- LSP config
- MCP config
- plugins config
- providers config
- references config
- watcher config

### 数据库 (`src/database/`)
- SQLite 适配器（Bun 和 Node 两种实现）
- Drizzle ORM Schema
- ~40 个数据库迁移
- 会话持久化

### Effect 层 (`src/effect/`)
- app-node: 应用级别的 Effect 运行时
- runtime: Effect 运行时配置
- service: 全局 Service 注册

### 其他模块
- **filesystem**: 文件系统（watcher, search, ignore patterns, protected paths）
- **pty**: 伪终端管理（Bun 和 Node 适配器）
- **github-copilot**: GitHub Copilot API 集成
- **config**: 配置 Schema
- **observability**: 日志、OTLP 追踪
- **ripgrep**: ripgrep 搜索（含二进制管理）
- **skill**: 技能系统（发现、指导）
- **credential**: 凭据管理
- **event**: 事件中心
- **util**: 工具函数（数组、glob、hash、path、retry、slug、token 等）
- **v1**: 遗留 v1 配置兼容和迁移

---

## 2. 主应用 — `packages/opencode/`

### CLI 命令 (`src/cli/`)
- **cmd/**: 各命令实现
  - **cmd/run/**: run 命令（主交互会话）
    - runtime.ts — 运行时生命周期
    - stdin.ts — 标准输入处理
    - scrollback.ts — 回滚
    - streaming.ts — 流式输出
    - prompts.ts — 提示处理
    - permissions.ts — 权限对话框
    - footers.ts — 状态栏
    - replay.ts — 会话回放
- **bootstrap.ts**: 启动初始化
- **error.ts**: 错误处理
- **tui.ts**: TUI 管理

### 会话层 (`src/session/`)
- **llm/**: LLM 集成层（Vercel AI SDK + 自定义运行时）
- **prompts/**: 每个模型的独立提示模板（anthropic.txt, gemini.txt, gpt.txt 等）
- **message.ts**: 消息处理
- **overflow.ts**: 上下文溢出处理
- **retry.ts**: 重试逻辑
- **reminders.ts**: 恢复提醒

### Agent 系统 (`src/agent/`)
- 子代理管理（compaction, explore, title 等专用代理）
- 权限系统
- 代理间通信

### 协议实现
- **`src/acp/`**: Agent Communication Protocol
- **`src/mcp/`**: Model Context Protocol（auth, OAuth, browser, catalog）

### 服务端 (`src/server/`)
- Hono HTTP 服务器
- REST API 路由 (`routes/instance/httpapi/`)
- 中间件（auth, compression, CORS, error, workspace routing）
- WebSocket 支持

### 插件加载 (`src/plugin/`)
- GitHub Copilot 插件
- Azure 插件
- Cloudflare 插件
- OpenAI Codex 插件
- xAI 插件

### 项目/工作区 (`src/project/`)
- bootstrap: 项目初始化
- instances: 多实例管理
- VCS: 版本控制集成

### 控制平面 (`src/control-plane/`)
- 多工作区管理
- Adapters: 工作区适配器
- Worktrees: Git worktree 支持

---

## 3. TUI 框架 — `packages/tui/`

Solid.js 驱动的终端用户界面：

- **Context Providers**: args, epilogue, exit, KV, project, runtime, SDK, sync, theme, editor, clipboard
- **Feature Plugins**: builtins, slots, command-shim
- **UI Components**: dialog, spinner, toast
- **Keymap**: 键盘映射系统
- **Attention**: 注意力管理
- **Terminal**: 终端支持（Win32 兼容）
- **Plugin Runtime**: TUI 插件运行时

---

## 4. UI 组件库 — `packages/ui/`

共享 Solid.js UI 组件：

- **Components**: conversation, diff, markdown, message, code block
- **Icons**: provider icons, file type icons, app icons
- **Theme**: 主题系统
- **i18n**: 国际化（多语言翻译）
- **v2**: 新版组件系统
- **Pierre**: 渲染引擎集成

---

## 5. Schema 包 — `packages/schema/`

核心数据类型的 **Effect Schema** 定义：

- Session Schema
- Message Schema
- Tool Call Schema
- Config Schema
- 所有跨包共享的类型定义
- 自动类型推导和运行时校验

---

## 6. Protocol 包 — `packages/protocol/`

客户端-服务器通信协议定义：

- HTTP API 协议 Schema
- WebSocket 消息协议
- 序列化/反序列化
- 版本控制

---

## 7. LLM 抽象层 — `packages/llm/`

低级别 LLM 提供商抽象：

- **Protocol-specific 实现**: Anthropic Messages API, Bedrock Converse, Gemini API, OpenAI Chat/Responses API
- **Provider-specific 实现**: Amazon Bedrock, Anthropic, Azure, Google, OpenAI, 等
- **Route-based 解析**: 根据配置路由到正确的提供商

---

## 8. 沙箱执行引擎 — `packages/codemode/`

Effect 原生的受限代码执行引擎：

- 安全沙箱执行用户代码
- 支持多种语言
- 资源限制（CPU、内存、时间）
- 结果收集和格式化

---

## 9. 插件 SDK — `packages/plugin/`

公开发布的插件开发工具包：

- Plugin API 类型定义
- Tool API 扩展
- TUI 集成接口
- Effect v2 集成
- 钩子系统

---

## 10. HTTP 录制器 — `packages/http-recorder/`

HTTP 流量录制/回放测试工具：

- 录制实际的 LLM API 调用
- 回放录制数据用于测试
- 避免测试中实际调用付费 API

---

## 11. 桌面端 — `packages/desktop/`

Electron 桌面应用：

- **Auto-updater**: electron-updater 自动更新
- **Native menu**: 原生菜单
- **Window state**: 窗口状态管理
- **Native PTY**: node-pty 原生终端支持
- **Build**: electron-builder 构建配置
