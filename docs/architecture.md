# Wings 架构设计

## 项目定位

Wings 是一个多模型聚合 Agent 系统。核心理念：不同 AI 模型各有所长 —— 有的推理强，有的速度快，有的擅长代码，有的精于创意。Wings 将各模型统一接入，根据任务特点智能调度。每个模型都是一只翅膀（wing）。

架构设计参考两个成熟项目：
- [claude-code](https://github.com/anthropics/claude-code) — Agent CLI 的标杆，Tool/Command 接口抽象、权限管道、双层状态管理
- [opensquilla](https://github.com/opensquilla/opensquilla) — 微内核 Agent 运行时，8 阶段 TurnRunner、Protocol 驱动 DI、StageOutcome 铁路导向错误处理

初始开发语言选择 **Python**，与 opensquilla 一致，便于深度参与设计和迭代。模块边界通过 Protocol 定义清晰后，未来可逐模块迁移到 TypeScript。

## 技术选型

| 选项 | 选择 | 理由 |
|------|------|------|
| 运行时 | **Python 3.12+** | opensquilla 同款，AI/ML 生态完整 |
| 类型校验 | **Pydantic v2** | JSON Schema 原生输出，opensquilla 同款 |
| CLI 框架 | **Typer + Rich** | 类型驱动 CLI，opensquilla 同款 |
| LLM SDK | anthropic + openai + google-generative-ai | 首批三只翅膀 |
| MCP | `mcp` (官方 Python SDK) | |
| 配置 | TOML + Pydantic Settings | 分层配置，环境覆盖 |
| 测试 | **pytest** + pytest-asyncio | |
| 包管理 | **uv** | 快速替代 pip/poetry |

## 设计原则

### 1. 一切皆工具 (Everything is a Tool)

所有能力 —— 文件读写、shell 执行、搜索、网络请求、子 agent 调用 —— 都实现统一的 `Tool` Protocol。参考 opensquilla 的 `@tool` 装饰器模式。

```python
# 参考 opensquilla src/opensquilla/tools/types.py
from pydantic import BaseModel
from typing import Protocol, Any

class ToolResult(BaseModel):
    output: str
    error: str | None = None
    metadata: dict[str, Any] = {}

class ToolContext(BaseModel):
    working_dir: str
    env: dict[str, str]
    session_id: str

class Tool(Protocol):
    name: str
    description: str

    async def call(self, input: Any, context: ToolContext) -> ToolResult: ...
    def is_enabled(self) -> bool: ...
    def is_read_only(self, input: Any) -> bool: ...
    def is_destructive(self, input: Any) -> bool: ...
    def render_result(self, result: ToolResult) -> str: ...
    def input_schema(self) -> dict[str, Any]: ...  # JSON Schema
```

好处：
- **LLM 视角统一**：所有能力都是同一套 tool calling 格式
- **权限集中管理**：所有操作经过同一条权限管道
- **可扩展**：新增能力只需实现 Tool 协议并注册

### 2. 协议驱动 (Protocol-Driven)

模块之间通过 `typing.Protocol` 定义边界，参考 opensquilla 的端口注入模式 —— 每个阶段接受 Protocol 端口而非具体实现。

```python
from typing import Protocol, AsyncIterator
from wings.messages.types import Message, StreamEvent, ToolSchema
from wings.models.config import ModelConfig

# 模型适配器协议
class ModelProvider(Protocol):
    provider_name: str

    async def chat(
        self, messages: list[Message], tools: list[ToolSchema] | None,
        config: ModelConfig,
    ) -> ModelResponse: ...

    async def stream(
        self, messages: list[Message], tools: list[ToolSchema] | None,
        config: ModelConfig,
    ) -> AsyncIterator[StreamEvent]: ...

# 消息标准化器协议
class MessageNormalizer(Protocol):
    def to_internal(self, provider: str, raw: list[dict]) -> list[Message]: ...
    def to_provider(self, provider: str, messages: list[Message]) -> list[dict]: ...
    def tools_to_provider(self, provider: str, tools: list[ToolSchema]) -> list[dict]: ...
```

### 3. StageOutcome — 铁路导向错误处理

参考 opensquilla 的 `StageOutcome` 模式：每个阶段要么返回成功输出，要么以 early-yield 事件终止，不能同时。

```python
from dataclasses import dataclass
from typing import Generic, TypeVar

T = TypeVar("T")

@dataclass(frozen=True)
class StageOutcome(Generic[T]):
    output: T | None = None
    early_yield: StreamEvent | None = None
    terminate: bool = False

    def __post_init__(self):
        if self.terminate and self.early_yield is None:
            raise ValueError("terminate=True requires early_yield")
        if not self.terminate and self.output is None:
            raise ValueError("non-terminate outcome requires output")

    @classmethod
    def success(cls, output: T) -> "StageOutcome[T]":
        return cls(output=output, terminate=False)

    @classmethod
    def abort(cls, event: StreamEvent) -> "StageOutcome[T]":
        return cls(early_yield=event, terminate=True)
```

### 4. 分层服务化

```
┌────────────────────────────────────────┐
│              CLI / REPL                 │  ← Typer + Rich
├────────────────────────────────────────┤
│              Agent 核心                 │  ← agent loop, subagent, coordinator
├──────────┬──────────┬──────────────────┤
│  Query   │  Tools   │  Permissions     │  ← 核心能力层
├──────────┼──────────┼──────────────────┤
│  Models  │ Messages │  Hooks           │  ← 抽象层
├──────────┴──────────┴──────────┬───────┤
│           Services (API, MCP)  │ Config│ ← 基础设施
└────────────────────────────────┴───────┘
```

### 5. 权限管道

多阶段权限检查，从自动到人工逐级升级（参考 claude-code）：

```
请求 → 静态规则 → 自动分类器 → hooks → 交互式审批
         ↓             ↓          ↓          ↓
      允许/拒绝      允许/拒绝   允许/拒绝    待用户决策
```

## Agent 核心循环

```
用户输入
  │
  ▼
组装消息列表 (system prompt + history + new user message)
  │
  ▼
选择模型 (根据任务类型、配置、可用性)
  │
  ▼
query() ─── 调用 LLM API，流式返回 (AsyncIterator)
  │
  ▼
解析响应
  │
  ├── text ──→ 输出给用户
  │
  ├── tool_use ──→ 权限检查 ──→ 执行工具
  │                    │              │
  │                    ▼              ▼
  │               拒绝 → 注入错误   tool_result
  │                              │
  └──────────────────────────────┘
                    │
                    ▼
         将 tool_result 追加到消息列表
                    │
                    ▼
            继续下一轮 query()
                    │
                    ▼
              stop_reason == "end_turn" → 结束
```

用 Python async generator 表达：

```python
from typing import AsyncIterator

async def run_loop(
    messages: list[Message],
    tools: list[Tool],
    model: ModelProvider,
    perms: PermissionPipeline,
    context: ToolContext,
) -> AsyncIterator[StreamEvent]:
    config = build_config()
    while True:
        had_tool_use = False
        async for event in model.stream(messages, to_schemas(tools), config):
            if event.type == "tool_use":
                tool = next((t for t in tools if t.name == event.name), None)
                if tool and perms.check(tool, event.input).decision == "allow":
                    result = await tool.call(event.input, context)
                    messages.append(tool_result_message(event.id, result))
                    had_tool_use = True
                    break  # 退出 stream，回到外层 while
            yield event  # 文本、thinking 直接输出

        if not had_tool_use:
            return  # end_turn
```

## 关键模块

| 模块 | 职责 | 核心依赖 |
|------|------|----------|
| `messages` | 消息类型 + 跨模型格式转换 | 无 |
| `models` | ModelProvider 协议 + 各 API 适配器 | messages |
| `tools` | Tool 协议 + 注册表 + 内置工具 | 无 |
| `query` | LLM API 调用封装（retry, fallback） | models, messages, tools |
| `agent` | 核心循环 + 子 agent + 协调器 | query, tools, permissions |
| `permissions` | 多阶段权限管道 | tools |
| `hooks` | 生命周期钩子 | 无 |
| `config` | 全局/项目配置 | 无 |
| `context` | system prompt + 环境信息 | 无 |
| `cli` | Typer 入口 + REPL | agent, config |
| `memory` | 持久化记忆 | 无 |
| `skills` | 可复用技能/工作流 | tools |
| `plugins` | 插件加载 | tools |
| `services` | 外部服务封装（API, MCP） | 无 |

## 与参考项目的模块对应

| claude-code (TS) | opensquilla (Python) | wings (Python) |
|------------------|---------------------|----------------|
| `src/tools/` | `tools/builtin/` | `tools/builtin/` |
| `src/Tool.ts` | `tools/types.py` | `tools/base.py` |
| `src/utils/model/` | `provider/` | `models/` |
| `src/QueryEngine.ts` | `engine/agent.py` | `query/engine.py` |
| `src/query.ts` | — | `agent/loop.py` |
| `src/tools/AgentTool/` | `tools/builtin/agents.py` | `agent/subagent.py` |
| `src/coordinator/` | `skills/meta/orchestrator.py` | `agent/coordinator.py` |
| `src/utils/messages.js` | — | `messages/` |
| `src/utils/hooks.ts` | `engine/hooks/` | `hooks/` |
| `src/utils/config.ts` | `gateway/config.py` | `config/` |
| `src/entrypoints/cli.tsx` | `cli/main.py` | `cli/main.py` |
| `src/services/mcp/` | `mcp/` | `services/mcp/` |
| `src/skills/` | `skills/` | `skills/` |
| `src/plugins/` | `plugins/` | `plugins/` |
| `src/context/` | `identity/` | `context/` |
| `src/memdir/` | `memory/` (含 Dream) | `memory/` |
| — | `engine/turn_runner/` (8 阶段) | — (Phase 2) |
| — | `squilla_router/` (ONNX 路由) | — (Phase 2) |

## 模型路由

**默认随机选择**。不做任务分析、不做难度评估——承认"我们不知道哪个模型最好"。

```
每个 turn:
  │
  ▼
当前模型 = 用户指定的模型 (/model) 或随机选择
  │
  ▼
调用该模型 API
```

### 为什么默认随机？

1. **诚实** — 不存在万能默认模型，随机 = 承认不知道
2. **探索** — 用户跑 100 个 turn 后自然知道"这类问题 A 模型更好"
3. **简单** — 相比 opensquilla 的 SquillaRouter (ONNX + LightGBM + 5 阶段后处理)，随机选择零复杂度

### 用户覆盖：`/model` 命令

参考 claude-code 的 `/model` 命令，用户随时指定模型：

```
/model claude-opus-4-6    → 切换到 Claude Opus
/model gpt-4o             → 切换到 GPT-4o
/model                    → 查看当前模型 + 可用列表
/model random             → 恢复随机模式
```

实现上就是一个字符串覆盖：有值时用它，无值时随机。

```python
import random

def select_model(override: str | None, available: list[str]) -> str:
    """选择模型：用户指定 > 随机。"""
    if override and override != "random":
        return override
    return random.choice(available)
```

### 为什么不像 opensquilla 做 ML 路由

opensquilla 的 SquillaRouter 目标是**省成本**——把琐碎问题路由到便宜模型。这是单个 provider 内部的升降级逻辑。wings 的目标是**能力互补**——不同 provider 的不同模型各有长处。这两种需求不同：

| | opensquilla | wings |
|---|---|---|
| 路由目标 | 省成本 | 发现能力 |
| 模型关系 | 好 ↔ 差 (同 provider) | 不同擅长领域 (跨 provider) |
| 技术 | ONNX 本地推理 | 不需要 |
| 复杂度 | 高 (ML + 后处理链) | 零 |

## 扩展性

### 添加新模型

```python
# models/deepseek.py
class DeepSeekProvider:
    provider_name = "deepseek"

    async def chat(self, messages, tools, config):
        ...  # 调用 DeepSeek API

    async def stream(self, messages, tools, config):
        ...  # 流式调用

# models/registry.py
registry.register("deepseek", DeepSeekProvider())
```

### 添加新工具

```python
# tools/builtin/my_tool.py
from pydantic import BaseModel

class MyToolInput(BaseModel):
    query: str

class MyTool:
    name = "my_tool"
    description = "Does something useful"

    def input_schema(self):
        return MyToolInput.model_json_schema()

    async def call(self, input, context):
        result = ...  # 执行逻辑
        return ToolResult(output=result)

    def is_enabled(self) -> bool:
        return True

    def is_read_only(self, input) -> bool:
        return True

    def is_destructive(self, input) -> bool:
        return False

    def render_result(self, result: ToolResult) -> str:
        return result.output

# tools/registry.py
registry.register(MyTool())
```

## 未来 TS 迁移策略

模块边界通过 Protocol 定义，迁移时只需重写模块内部：

1. **不变**: Protocol 接口、消息类型 (JSON Schema)、TOML 配置
2. **逐模块翻译**: messages → models → tools → query → agent → permissions → cli
3. **TUI 重写**: Rich → Ink (React)，这是最大差异点
4. **后续增强**: 待 Python 阶段稳定后，opensquilla 的 TurnRunner 阶段分解、Memory/Dream、SquillaRouter 等可在两个语言中择一实现
