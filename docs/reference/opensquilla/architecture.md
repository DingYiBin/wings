# OpenSquilla — 架构设计

## 微内核架构

系统围绕 `TurnRunner` 采用**微内核模式**，所有入口路径通过同一个 turn loop，确保工具分发、重试和决策日志在所有入口行为一致。

## TurnRunner — 8 阶段管道

`TurnRunner` 分解为 **8 个顺序阶段**，每个阶段有定义的 Protocol 端口接口：

1. **InputStage** — 规范化输入消息，解析会话状态
2. **AttachmentStage** — 处理文件附件为 LLM 兼容消息
3. **ProviderAndToolsStage** — 解析 LLM provider，构建工具定义
4. **PromptAssemblerStage** — 运行预 turn 管道 (路由、技能过滤、prompt 缓存) 生成最终 system prompt
5. **AgentBootstrapStage** — 用解析的配置、超时、记忆快照构建 Agent 实例
6. **CompactionAndHistoryStage** — 加载历史，处理上下文溢出压缩
7. **StreamConsumerStage** — 运行 agent turn，消费事件流，处理内联压缩
8. **TurnFinalizerStage** — 持久化转录、捕获 turn 记忆、汇总成本/令牌

每个阶段接收类型化 `StageInput` dataclass，返回 `StageOutcome[Output]` (`.success(output)` 或 `.terminate_with(early_yield=event)`)。`TurnContext` dataclass 累积跨阶段状态。

## 核心设计模式

### 1. Protocol 驱动的依赖注入

每个阶段接受 "ports" (Protocol 类如 `AgentRunPort`, `MemorySnapshotPort`, `ProviderResolverPort`) 而非具体实现。这是主要的 DI/IoC 机制。

### 2. 适配器模式

`harness.py` 提供 ~30 个适配器类 (如 `_TurnRunnerProviderResolverAdapter`, `_TurnRunnerToolBuilderAdapter`)，将 TurnRunner 实例方法绑定到 Protocol 端口。避免循环导入同时保持阶段可测试。

### 3. StageOutcome 不相交联合类型

`StageOutcome[OutputT]` 强制阶段要么返回成功输出，要么以 early-yield 事件终止 — 不能同时。`__post_init__` 在构造时验证。

### 4. Fail-Open 预 Turn 管道

`pipeline.py` 运行有序异步步骤，转换 `TurnContext`。步骤失败被捕获并记录，但管道继续 (非致命语义)。

### 5. 插件/扩展契约

- Provider 系统使用 `ProviderPlugin` Protocol
- Hooks 系统使用 `TurnHook`/`ToolHook`/`CompactionHook` Protocols
- Channels 使用 `Channel`/`ManagedChannel` Protocols

### 6. PEP 562 延迟导入

`engine/__init__.py` 使用 `__getattr__` 和 `_LAZY_MAP` 在首次访问时延迟导入重量级模块 (Agent, SubagentManager, ContextAssembly)。

### 7. Feature Flags (Env/Config 分层)

所有功能开关通过分层优先级解析: 环境变量 > toml 配置 > 默认值。
