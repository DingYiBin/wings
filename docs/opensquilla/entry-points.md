# OpenSquilla — 入口点与流程

## CLI 入口

定义在 `pyproject.toml`:
```
opensquilla = "opensquilla.cli.main:app"
gateway = "opensquilla.cli.main:gateway_app"
```

Typer `app` 提供子命令: `agent` (单 turn), `chat` (交互式), `channels`, `agents`, `config`, `cost`, `diagnostics`, `cron`, `dist`, `mcp-server`, `migrate`, `models`, `providers`, `sandbox`, `search`, `sessions`, `skills`, `swebench`, `code-task`, `init`, `doctor`, `uninstall`, `onboard`, `configure`, `memory`, `gateway`, `replay`。

## Gateway 入口

`opensquilla gateway run` 启动 ASGI 服务器。启动序列:
1. 加载环境变量 (.env files)
2. 加载配置 (opensquilla.toml 或环境变量)
3. 应用数据库迁移 (yoyo)
4. 构建服务 (SessionManager, ModelSelector, ToolRegistry, ChannelManager, UsageTracker 等)
5. 启动后台任务 (频道适配器, cron, heartbeat, Dream 巩固)
6. 创建 Starlette 应用 + 中间件
7. 启动 uvicorn

## Turn 执行流程

```
1. Input 规范化: 消息从 WebSocket, CLI, 或频道到达
2. InputStage: 规范化原始输入 -> 运行时消息，解析额外上下文
3. AttachmentStage: 处理文件附件
4. ProviderAndToolsStage: 解析 LLM provider，构建工具定义
5. PromptAssemblerStage:
   - 通过预 turn 管道解析模型 (或 SquillaRouter)
   - 基于相关性过滤技能
   - 注入技能上下文到 system prompt
   - 应用 prompt 缓存断点
   - 组装最终 prompt
6. AgentBootstrapStage: 用解析的配置创建 Agent
7. CompactionAndHistoryStage: 加载历史，处理上下文溢出
8. StreamConsumerStage: 运行 agent turn，消费事件流
9. TurnFinalizerStage: 持久化转录，捕获记忆，汇总成本
```

## 频道消息流

```
1. 频道适配器从平台接收消息
2. 创建 IncomingMessage (规范化内容 + 发送者身份)
3. 通过 ChannelManager 路由到分配的 agent
4. 构造 ToolContext (频道身份 + 调用者类型)
5. 调用 TurnRunner._run_turn() -> AsyncIterator[AgentEvent]
6. 通过适配器输出机制将事件流式传输到频道
7. 频道适配器为特定平台格式化最终响应
```

## 关键文件速查

| 模块 | 关键文件 |
|------|---------|
| 入口点 | `src/opensquilla/cli/main.py` |
| 配置模板 | `opensquilla.toml.example` |
| 项目配置 | `pyproject.toml` |
| Gateway 启动 | `src/opensquilla/gateway/boot.py` |
| Gateway 应用 | `src/opensquilla/gateway/app.py` |
| Gateway 配置 | `src/opensquilla/gateway/config.py` |
| TurnRunner | `src/opensquilla/engine/runtime.py` |
| Agent 核心 | `src/opensquilla/engine/agent.py` |
| 引擎类型 | `src/opensquilla/engine/types.py` |
| 预 Turn 管道 | `src/opensquilla/engine/pipeline.py` |
| 阶段 Harness | `src/opensquilla/engine/turn_runner/harness.py` |
| 阶段结果 | `src/opensquilla/engine/turn_runner/outcome.py` |
| Turn 上下文 | `src/opensquilla/engine/turn_runner/context.py` |
| Hooks | `src/opensquilla/engine/hooks/types.py` |
| Provider 协议 | `src/opensquilla/provider/protocol.py` |
| Provider 注册表 | `src/opensquilla/provider/registry.py` |
| Provider 选择器 | `src/opensquilla/provider/selector.py` |
| 工具注册表 | `src/opensquilla/tools/registry.py` |
| 工具类型 | `src/opensquilla/tools/types.py` |
| 技能加载器 | `src/opensquilla/skills/loader.py` |
| 技能类型 | `src/opensquilla/skills/types.py` |
| Meta 编排器 | `src/opensquilla/skills/meta/orchestrator.py` |
| 记忆存储 | `src/opensquilla/memory/store.py` |
| 记忆管理器 | `src/opensquilla/memory/manager.py` |
| Dream 运行器 | `src/opensquilla/memory/dream/runner.py` |
| SquillaRouter | `src/opensquilla/squilla_router/controller.py` |
| 沙箱后端 | `src/opensquilla/sandbox/backend/__init__.py` |
| 频道契约 | `src/opensquilla/channels/contract.py` |
| RPC 注册表 | `src/opensquilla/gateway/rpc/registry.py` |
| Web UI | `opensquilla-webui/package.json` |
| 桌面应用 | `desktop/electron/package.json` |
