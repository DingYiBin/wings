# OpenSquilla — 关键模块

## 1. Engine (`src/opensquilla/engine/`)

系统核心。

- **`agent.py`**: `Agent` 类 — 显式状态机，核心循环 < 500 行。管理模型/工具循环：发送 prompts，接收流式工具使用/文本事件，分发工具，处理退避重试，管理上下文溢出压缩。使用 `AgentConfig` 进行所有预算/超时/策略设置。

- **`runtime.py`**: `TurnRunner` 类 — 所有入口路径的汇聚点。编排 8 阶段 turn 分解。拥有 SessionManager, ModelSelector, ToolRegistry, UsageTracker, SessionFlushService, 记忆同步管理器, hooks 链。`_run_turn()` 方法是生成 `AgentEvent` 项的中心异步生成器。

- **`pipeline.py`**: 预 turn 管道，有序步骤 (模型解析、路由决策、技能过滤、prompt 缓存、coding mode 注入、meta command 处理等)。

- **`types.py`**: 定义 `AgentConfig` (50+ 字段), `AgentEvent` 联合类型 (18 种事件变体), `ThinkingLevel` 枚举, `AgentState` 枚举。

- **`hooks/types.py`**: 定义 `TurnHook` (turn 前后生命周期), `ToolHook` (工具分发前后), `CompactionHook` (压缩前后) Protocols。

### 阶段分解 (`engine/steps/`)

8 个阶段各自独立实现，通过 harness 适配器连接。

### Turn Runner 子模块 (`engine/turn_runner/`)

- `harness.py`: ~30 个适配器类
- `outcome.py`: StageOutcome 不相交联合类型
- `context.py`: TurnContext 跨阶段状态累积

## 2. Provider 层 (`src/opensquilla/provider/`)

最干净的设计之一。

- **`protocol.py`**: `LLMProvider` Protocol — `chat(messages, tools, config) -> AsyncIterator[StreamEvent]` 和 `list_models() -> list[ModelInfo]`。`ProviderPlugin` 有 `failover_hook` 和 `quota_hook`。

- **`registry.py`**: 30+ `ProviderSpec` 条目注册表，每个指定后端类型 (`openai_compat`, `anthropic`, `ollama`, `openai_responses`)、环境变量键、默认 base URL、推理形状、所需能力。

- **`selector.py`**: `ModelSelector` 类，`build_provider()` 工厂根据 spec 实例化正确的 provider 类。

- **`openai.py`, `anthropic.py`, `ollama.py`, `openai_responses.py`**: 具体实现，各自说原生协议，统一输出为 `StreamEvent`。

- **`model_catalog.py`**: 从内置模型配置文件解析模型能力 (上下文窗口、最大令牌、工具支持、视觉)。

- **`smart_routing.py`**: Provider 级拒绝检测 (`should_refuse()`)，用于智能故障转移。

- **`failures.py`**: 错误分类 (`ProviderFailureKind`) 和恢复动作决策 (`ProviderRecoveryAction`)。

## 3. 工具系统 (`src/opensquilla/tools/`)

- **`registry.py`**: `ToolRegistry` — 中心注册表，支持按 profile (full, safe, read-only) 和调用者上下文进行工具可见性过滤。`@tool` 装饰器用 JSON Schema 参数定义注册函数。

- **`types.py`**: `ToolContext` — 综合上下文对象 (50+ 字段)，携带入口身份、调用者类型、交互模式、工作区配置、沙箱设置、策略配置等。

- **`builtin/`**: 20+ 内置工具:
  - `shell.py` — Shell 命令执行 (沙箱化)
  - `filesystem.py` — 文件 read/write/edit/grep/find
  - `code_exec.py` — 代码执行 (Python, JS, Rust, Go 等)
  - `web.py`, `web_fetch.py` — 网络搜索和页面获取
  - `file_authoring.py` — 文档创建 (DOCX, PPTX, XLSX, PDF)
  - `git.py` — Git 操作
  - `memory_tools.py` — 记忆读写
  - `sessions.py` — 会话管理
  - `patch.py` — 文件补丁
  - `agents.py` — 子 agent 委托
  - `media.py` — 媒体处理
  - `skill_tools.py` — 技能调用
  - `meta_tools.py` — Meta-skill 控制

- **`policy/`**: 工具执行策略链 (`chain.py`, `checks.py`, `finalize.py`)。

- **`dispatch.py`, `envelope.py`**: 工具分发和结果信封规范化。

- **`ssrf.py`**: Web 获取工具的 SSRF 保护。

## 4. 技能系统 (`src/opensquilla/skills/`)

- **`types.py`**: `SkillSpec` — 核心技能类型，包含 name, description, triggers, content, 平台元数据, 来源, 入口配置, meta-composition 元数据。

- **`loader.py`**: `SkillLoader` — 从 6 层 (Extra, Bundled, Managed, Personal, Project, Workspace) 解析带 YAML frontmatter 的 SKILL.md 文件。

- **`injector.py`**: `SkillInjector` — 在特定注入点将技能内容注入 system prompt。

- **`bundled/`**: 67 个预装技能：文件格式 (DOCX, XLSX, PPTX, PDF)、Web (HTTP fetch, 网页研究)、媒体 (视频生成/合并/配音)、开发 (git-diff, GitHub, stack traces)、研究 (深度研究, 论文写作)、meta (技能创建器, 项目规划器)、工具 (记忆, 天气, cron, 子 agent)。

- **`meta/`**: Meta-skill 子系统:
  - `orchestrator.py`: `MetaOrchestrator` — 运行基于 DAG 的多步技能计划
  - `scheduler.py`: 并行 DAG 调度器，事件流合并
  - `parser.py`: 将 meta-skill SOP 文档解析为 `MetaPlan` DAG
  - `sop_compiler.py`: 编译 SOP 文档为可执行计划
  - `templating.py`: 受限 Jinja2 模板
  - `clarify_*.py`: 用户澄清/交互流程

- **`hub/`**: 社区技能中心 — 安装器、GitHub 扫描器、锁文件管理。

## 5. 记忆系统 (`src/opensquilla/memory/`)

- **`manager.py`**: `MemoryManager` — 每个 agent 的门面。

- **`store.py`**: `LongTermMemoryStore` — SQLite + sqlite-vec 向量数据库 + FTS5 全文搜索。实现混合搜索 (语义向量相似度 + 关键词/词法)，分块嵌入，CJK 感知文本处理 (jieba)。

- **`retrieval.py`**: `MemoryRetriever` — 多源记忆搜索接口 (memory, sessions, all)。

- **`sync_manager.py`**: `MemorySyncManager` — 监视记忆源目录变化并同步到搜索索引。

- **`turn_capture.py`**: `TurnCaptureService` — 将 turn 转录捕获到持久记忆。

- **`flush.py`**: `SessionFlushService` — 会话关闭/重置时将转录刷新到持久记忆。

- **`dream/`**: "Dream" — 离线记忆巩固系统:
  - `runner.py`: `Dream` — 处理记忆源为巩固证据
  - `candidates.py`, `evidence.py`, `ranking.py` — 候选生成、证据提取、排序
  - `curated_apply.py` — 策划应用
  - `rehydrate.py` — 将压缩证据恢复为结构化格式

- **`embedding.py`**: 嵌入 provider 抽象 (ONNX 本地嵌入 via sqlite-vec)。

## 6. Gateway (`src/opensquilla/gateway/`)

- **`app.py`**: `create_gateway_app()` — Starlette ASGI 应用工厂，带中间件 (auth, rate limiting, CORS, security headers, error handling)。

- **`boot.py`**: `GatewayServer` — 启动序列编排。管理生命周期：应用迁移、加载配置、构建服务、启动后台任务、通过 uvicorn 启动 ASGI 服务器。

- **`config.py`**: `GatewayConfig` — 综合 Pydantic Settings 模型。

- **`rpc/registry.py`**: `RpcRegistry` / `RpcDispatcher` — RPC 方法注册表，方法分类、作用域执行、授权检查。

- **`middleware.py`**: AuthMiddleware, RateLimitMiddleware, SecurityHeadersMiddleware, ErrorHandlingMiddleware。

- **`session_streams.py`**: 管理每个会话的 WebSocket fan-out。

## 7. 频道系统 (`src/opensquilla/channels/`)

- **`types.py`**: `Channel` 和 `ManagedChannel` Protocols, `IncomingMessage`, `OutgoingMessage`。
- **`registry.py`**: 通过 `pkgutil` 自动发现频道模块。支持 `entry_points` 外部频道插件。
- **`manager.py`**: `ChannelManager` — 所有活跃频道适配器的生命周期管理。
- 9 个适配器: Slack, Discord, Telegram, 飞书, 钉钉, 企业微信, QQ, Matrix, Teams

## 8. SquillaRouter (`src/opensquilla/squilla_router/`)

设备端模型路由器:
- ONNX 模型运行时 + BGE 嵌入
- 特征提取 + LightGBM 集成推理
- 后处理 + 轨迹跟踪
- 将任务难度分类为 T0-T3 层级，选择合适模型

## 9. 沙箱 (`src/opensquilla/sandbox/`)

三个后端:
- `bubblewrap.py` — Linux 命名空间隔离 (bwrap)
- `seatbelt.py` — macOS 沙箱 (sandbox-exec + SBPL profiles)
- `noop.py` — 无操作后端 (沙箱禁用时)

## 10. MCP 支持

- **MCP 客户端**: 连接外部 MCP 服务器 via stdio/SSE，发现工具，注册到工具注册表。
- **MCP 服务端**: 将 OpenSquilla 能力暴露为 MCP 服务器。

## 11. Web UI (`opensquilla-webui/`)

Vue 3 + Vite + TypeScript + Pinia + vue-router + vue-i18n。
marked (markdown), highlight.js (代码), KaTeX (数学), DOMPurify (清理)。

## 12. 桌面应用 (`desktop/electron/`)

Electron v42 壳包裹 Vue.js Web UI，捆绑 Python gateway 用于本地使用。
