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

## 12. Channel 适配器模式 (以飞书为例)

**文件**: `src/opensquilla/channels/feishu.py` (1581 行)

OpenSquilla 支持 9 个聊天平台，每个平台一个适配器，实现 `Channel` + `ManagedChannel` Protocol。飞书适配器是其中最完整的实现。

### 核心结构：五个部分

```
FeishuChannel
  ├── 1. 配置 + 认证
  │     FeishuChannelConfig (app_id, app_secret, connection_mode, domain)
  │     _get_token() → tenant_access_token (缓存 + 自动刷新)
  │
  ├── 2. 入站：收消息
  │     webhook 模式: FeishuWebhookTransport (HTTP endpoint, 签名验证, 去重)
  │     websocket 模式: FeishuWebSocketTransport (lark-oapi SDK, 独立线程 event loop)
  │     parse_event() → 平台消息 → IncomingMessage (标准化)
  │
  ├── 3. 入站：附件下载 (按需, 不阻塞收消息)
  │     resolve_inbound_attachment() → 存 resource_key metadata → 调用时下载
  │
  ├── 4. 出站：发消息
  │     send_text()     → POST /im/v1/messages
  │     reply_text()    → POST /im/v1/messages/{id}/reply
  │     send_file()     → 图片: POST /im/v1/images; 文件: POST /im/v1/files
  │     send()          → text 或 interactive card
  │     edit() / delete() → PUT/DELETE
  │     send_streaming()  → STREAM_UPDATE_STRATEGY = "final_only" (收集完一次性发送)
  │     出站前自动 Markdown → 飞书纯文本转换 (去 heading/bold/link 标记)
  │
  └── 5. 辅助
        is_mentioned()     → 群聊 @提及检测 (门控用)
        session_key()      → feishu:{sender}:{chat_id} (每对话一个 opensquilla session)
        parse_approval_card_action() → 审批按钮 → /approve 命令
        parse_clarify_card_action()  → 表单提交 → key: value 文本
```

### 关键设计决策

**输入标准化**。无论 webhook 还是 WebSocket，进入 opensquilla 的都是统一的 `IncomingMessage`:
```python
IncomingMessage(
    sender_id="ou_xxx",
    channel_id="oc_xxx",
    content="你好",           # 已提取为纯文本
    attachments=[...],        # 附件 metadata (resource_key), 不下载
    metadata={                # 平台特定元数据
        "chat_type": "group",
        "is_group": True,
        "mention_map": {...},
        "native_message_id": "...",
    },
)
```

`metadata` 的区分很重要——`content` 是标准化的（agent 关心的），`metadata` 是平台特定的（adapter 自己用的，如 `reply_message_id` 用于回复、`mention_map` 用于群聊门控）。

**附件延迟下载**。入站时只存 `resource_key`，不下载文件内容。当 agent 需要访问附件时才调用 `resolve_inbound_attachment()` 下载。避免为每个消息都下载大文件。

**Session 隔离**。`session_key(sender_id, chat_id)` 生成唯一 session key。同一个飞书群 → 同一个 opensquilla session → 消息历史连续。私聊和群聊自动隔离。

**流式策略**。`STREAM_UPDATE_STRATEGY = "final_only"` — 飞书不支持逐 token 编辑消息，所以收集完所有 chunk 后一次性发送。不同平台有不同的策略（Slack 支持 edit 流式，飞书不支持）。这个策略作为 class 常量声明，让上层 `TurnRunner` 知道如何处理该平台的流式输出。

### 对 wings 的参考价值

如果 wings 未来要支持聊天频道（Slack、Discord、飞书等），可以直接复制这个模式：

1. **Protocol 定义**: `Channel` Protocol 定义 `start/stop/receive/send/health_check` 生命周期
2. **消息标准化**: 每个平台的消息格式 → 统一的 `IncomingMessage` / `OutgoingMessage`
3. **metadata 分离**: `content` 是 agent 关心的（标准纯文本），`metadata` 是 adapter 自己用的（reply_to、message_id 等平台特定字段）
4. **附件按需下载**: 入站只存 resource_key，真正需要时再下载
5. **Session 绑定**: `session_key()` 决定如何将平台对话映射到 agent session
6. **流式策略**: 每个平台声明自己的 `STREAM_UPDATE_STRATEGY`（`final_only` / `edit` / `stream`）
7. **自动发现**: `channels/registry.py` 通过 `pkgutil` 扫描所有 Channel 实现，不需手动注册
