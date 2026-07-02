# OpenSquilla — 可参考的设计模式

## 1. StageOutcome 不相交联合类型 (铁路导向错误处理)

`StageOutcome[OutputT]` frozen dataclass 是建模"要么成功要么终止"的优雅模式。`__post_init__` 验证 `terminate=True` 要求 `early_yield` 且 `output=None`，反之亦然。消除了整个类别的 bug（部分状态通过错误路径泄露）。

## 2. Protocol 驱动的端口注入 + 适配器类

不使用 DI 容器，每个 TurnRunner 阶段接受 "port" Protocols。Harness 提供 ~30 个适配器类将 TurnRunner 方法桥接到这些端口。零依赖、完全类型化的 DI 模式，保持核心运行时可测试。

## 3. Fail-Open 语义的预 Turn 管道

预 turn 管道运行有序步骤，每个步骤转换 `TurnContext`。步骤可单独失败而不中止管道 — 失败步骤被记录，其元数据被回滚。对 prompt 组装来说很健壮。

## 4. 多层技能系统

6 层技能加载 (Extra < Bundled < Managed < Personal < Project < Workspace) 带显式优先级。更高优先级层按名称覆盖较低层，每层独立可发现。

## 5. Provider 抽象 + 统一 StreamEvent 联合

Provider 层将 30+ LLM 后端规范化为单一 `AsyncIterator[StreamEvent]` 接口。每个 provider (OpenAI, Anthropic, Ollama) 说原生协议，产出统一事件。`ProviderSpec` 注册表使添加新后端只需注册。

## 6. 混合搜索 + 降级路径

记忆搜索结合语义向量搜索 (sqlite-vec) 和 FTS5 词法搜索，嵌入失败时优雅降级 (raw fallback receipts)。"Dream" 离线巩固系统是后台 LLM 驱动过程，从原始对话转录中提取结构化知识。

## 7. RPC 注册表 + 作用域执行

网关 RPC 系统使用类型化注册表，处理器在导入时注册 (通过模块级装饰器/副作用)。每个处理器声明所需作用域，分发器在调用前执行授权。注册表在启动后锁定，防止延迟导入表面增长。

## 8. Agent 状态机 + 丰富事件类型

`Agent` 类是显式有限状态机 (IDLE -> THINKING -> TOOL_CALLING -> STREAMING -> DONE/ERROR)，产出 18 种 `AgentEvent` 类型的丰富联合。每个事件携带类型化元数据，流消费者阶段处理分发到 WebSocket fan-out。

## 9. PEP 562 延迟导入

`engine/__init__.py` 使用 `__getattr__` 在首次访问时延迟重量级导入。保持类型检查快速，运行时完全加载。

## 10. 配置分层

```
环境变量 > opensquilla.toml > 默认值
```

关键配置段:
- `[llm]` — provider, model, api_key
- `[auth]` — token, password, mode
- `[sandbox]` — backend, network, filesystem
- `[memory]` — source directory, flush settings
- `[agent]` — timeouts, iteration limits, thinking budget
- `[channels]` — 每个频道平台配置
- `[squilla_router]` — 路由器层级映射, 阈值

## 11. 扩展点汇总

| 扩展类型 | 方式 |
|---------|------|
| Provider 插件 | 实现 `LLMProvider` Protocol, 注册到 `ProviderSpec` |
| 频道适配器 | 实现 `ManagedChannel` Protocol, 自动发现 |
| 技能 | 在 6 层目录中创建 SKILL.md 文件 |
| Meta-Skills | 定义 SOP 文档, 编译为 DAG MetaPlan |
| 工具 | 使用 `@tool` 装饰器 + JSON Schema 参数 |
| Hooks | 实现 TurnHook/ToolHook/CompactionHook Protocols |
| MCP 服务器 | 在配置中配置, 自动发现工具 |
| 搜索 Providers | 实现 provider 接口 |
| 沙箱后端 | 实现 Backend protocol |
