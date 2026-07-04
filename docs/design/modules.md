# 模块详细设计 (Python)

## 1. messages — 消息类型系统 ✅

**位置**: `src/wings/messages/`
**依赖**: 无

### 设计目标

定义一套统一的内部消息格式。每个 model adapter 将各 API 消息格式转换为此内部格式，agent 层只处理一种消息类型。

### 消息类型

```python
# types.py
from pydantic import BaseModel
from typing import Literal, Any
from enum import Enum

class Role(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"

class TextBlock(BaseModel):
    type: Literal["text"] = "text"
    text: str

class ToolUseBlock(BaseModel):
    type: Literal["tool_use"] = "tool_use"
    id: str
    name: str
    input: dict[str, Any]

class ToolResultBlock(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    tool_use_id: str
    content: str
    is_error: bool = False

MessageContent = TextBlock | ToolUseBlock | ToolResultBlock

class Message(BaseModel):
    role: Role
    content: list[MessageContent]

# 流式事件
class TextDelta(BaseModel):
    type: Literal["text_delta"] = "text_delta"
    text: str

class ToolUseDelta(BaseModel):
    type: Literal["tool_use_delta"] = "tool_use_delta"
    id: str
    name: str | None = None       # 只在首个 delta 中提供
    input_delta: dict[str, Any]   # 增量 JSON

class ThinkingDelta(BaseModel):
    type: Literal["thinking_delta"] = "thinking_delta"
    text: str

StreamEvent = TextDelta | ToolUseDelta | ThinkingDelta

class StopReason(str, Enum):
    END_TURN = "end_turn"
    MAX_TOKENS = "max_tokens"
    TOOL_USE = "tool_use"
    STOP_SEQUENCE = "stop_sequence"
```

### 跨模型转换 (MessageNormalizer)

各模型的 tool calling 格式：

| 操作 | Anthropic | OpenAI | Gemini |
|------|-----------|--------|--------|
| tool_use | `content[type="tool_use"]` | `tool_calls[]` | `parts[functionCall]` |
| tool_result | `content[type="tool_result"]` + `tool_use_id` | `role="tool"` + `tool_call_id` | `parts[functionResponse]` |
| text | `content[type="text"]` | `content` (string) | `parts[text]` |
| image | `content[type="image"]` | `content[type="image_url"]` | `parts[inlineData]` |

```python
# normalize.py
from typing import Protocol, Any

class MessageNormalizer(Protocol):
    """将 SDK 原始消息转为内部 Message[]"""
    def to_internal(self, provider: str, raw_messages: list[dict]) -> list[Message]: ...

    """将内部 Message[] 转为目标模型的 API 格式"""
    def to_provider(self, provider: str, messages: list[Message]) -> list[dict]: ...

    """将内部 ToolSchema[] 转为目标模型的 tools 格式"""
    def tools_to_provider(self, provider: str, tools: list[dict]) -> list[dict]: ...
```

### 关键文件

- `types.py` — 消息类型定义（Pydantic models）
- `normalize.py` — `MessageNormalizer` 实现，每种 provider 一个转换函数

---

## 2. models — 模型适配层

**位置**: `src/wings/models/`
**依赖**: messages

### ModelProvider 协议

```python
# models/protocol.py
from typing import Protocol, AsyncIterator, Any
from wings.messages.types import Message, StreamEvent, StopReason
from pydantic import BaseModel, Field

class ModelConfig(BaseModel):
    model: str
    temperature: float = 0.7
    max_tokens: int = 4096
    top_p: float | None = None
    thinking: bool = False
    api_key: str
    base_url: str | None = None

class TokenUsage(BaseModel):
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None

class ModelResponse(BaseModel):
    content: list[MessageContent]
    stop_reason: StopReason
    usage: TokenUsage

class ModelProvider(Protocol):
    provider_name: str

    async def chat(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None,
        config: ModelConfig,
    ) -> ModelResponse: ...

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None,
        config: ModelConfig,
    ) -> AsyncIterator[StreamEvent]: ...
```

### Registry

```python
# registry.py
from wings.routing.protocol import ModelSelector

class ModelRegistry:
    def __init__(self, selector: ModelSelector):
        self._providers: dict[str, ModelProvider] = {}
        self._aliases: dict[str, str] = {}  # 别名 -> 标准名
        self._selector = selector

    def register(self, name: str, provider: ModelProvider) -> None: ...
    def alias(self, alias: str, target: str) -> None:        # e.g. "opus" -> "claude-opus-4-6"
    def get(self, name: str) -> ModelProvider: ...
    def list(self) -> list[str]: ...

    def select(self, task_type: str, override: str | None = None) -> str:
        """从 ModelSelector 获取 API：用户指定 > 池选择。"""
        return self._selector.select(task_type, override)
```

### 首批适配器

| 文件 | 模型 | SDK |
|------|------|-----|
| `anthropic.py` | Claude (Opus, Sonnet, Haiku) | `anthropic` |
| `openai.py` | GPT-4o, o4-mini, o-series | `openai` |
| `google.py` | Gemini 2.5 Pro/Flash | `google-generative-ai` |
| `openrouter.py` | 统一网关 | OpenAI-compatible SDK |

### capabilities.py

```python
# capabilities.py
from pydantic import BaseModel
from typing import Literal

class ModelCapabilities(BaseModel):
    context_window: int           # 最大上下文 (tokens)
    max_output_tokens: int        # 最大输出
    supports_vision: bool         # 图片理解
    supports_thinking: bool       # extended thinking
    supports_tools: bool          # function calling
    supports_streaming: bool      # 流式输出
    supports_parallel_tools: bool # 并行 tool calls
    speed_tier: Literal["fast", "normal", "slow"]
    cost_per_m_input: float       # $/百万 token (输入)
    cost_per_m_output: float      # $/百万 token (输出)
```

---

## 2b. routing — API 候选池

**位置**: `src/wings/routing/`
**依赖**: 无（纯数据结构 + 随机算法）

### 设计目标

wings 的核心差异点：每次模型调用都从当前任务的 API 候选池中加权随机选择一个 API。用户通过打分和设置调整各任务类型的候选池。

### 为什么 routing 先于 models 实现

routing 模块零依赖（不依赖 messages、models、tools），可以独立开发和测试。其他模块通过 Protocol 依赖 routing，不依赖具体实现。即便后续彻底重写池的实现（换存储、换算法、换继承逻辑），也不影响调用方。

### 分层架构

```
┌─────────────────────────────┐
│  ModelSelector (Protocol)    │  ← 其他模块只依赖这个
├─────────────────────────────┤
│  APIPoolManager              │  ← 管理池、选择、调整、持久化
├─────────────────────────────┤
│  weighted_select()           │  ← 纯函数：列表 → 选中项
│  resolve_parent()            │  ← 纯函数：task_type → parent
│  resolve_pool()              │  ← 纯函数：task_type → 最终池
├─────────────────────────────┤
│  PoolEntry, TaskPool         │  ← Pydantic 数据结构
│  PoolConfig                  │  ← 持久化格式
│  TASK_HIERARCHY              │  ← 静态继承链（单一真相源）
└─────────────────────────────┘
```

纯函数层（selector + tasks）无状态、无副作用，可独立测试和替换。有状态的管理器层（APIPoolManager）只做编排和锁管理。Protocol 层让调用方与实现解耦。

### ModelSelector Protocol

其他模块只依赖这个 Protocol，不依赖 `APIPoolManager` 具体类。

```python
# protocol.py
from typing import Protocol

class ModelSelector(Protocol):
    """选择模型的接口。AgentLoop、QueryEngine 只依赖此协议。"""

    def select(self, task_type: str, override: str | None = None) -> str:
        """返回选中的 api_id。

        Args:
            task_type: 任务类型 ("main", "subagent/explore", "skill/commit", ...)
            override: session 级模型锁定（用户 /model 命令设置），绕过池选择。

        Returns:
            api_id，如 "anthropic/claude-opus-4-6"

        Raises:
            NoAPIAvailable: 池中无可用 API
        """
        ...
```

### override 语义

| 来源 | 持久性 | 说明 |
|------|--------|------|
| `/model <api>` | session 级锁定 | 后续所有 turn 使用此模型，直到 `/model random` |
| `/model random` | — | 清除锁定，恢复池选择 |
| Skill `model` 字段 | per-call | 该 skill 的一次调用使用指定模型，不影响其他 turn |

实现上，`override` 是 session 级持久锁定值，由 AgentContext 携带。Skill 的 per-call 覆盖在子 agent 创建时处理（不经过池的 select）。

### 数据结构

```python
# types.py
from pydantic import BaseModel

class PoolEntry(BaseModel):
    """候选池中的单个 API 条目。

    weight 为浮点数。浮点比较使用误差容限 1e-9。
    """
    api_id: str              # API 唯一标识，如 "anthropic/claude-opus-4-6"
    weight: float = 1.0      # 相对概率权重，>= 0
    enabled: bool = True     # False = 不参与选择

class TaskPool(BaseModel):
    """某个任务类型的 API 候选池（运行时结构）。

    继承关系只在 TASK_HIERARCHY 中定义，
    TaskPool 本身不携带 inherit_from，避免双源头不一致。
    """
    task_type: str
    entries: list[PoolEntry]

class PoolConfig(BaseModel):
    """候选池持久化配置。

    只存储有独立配置的池（entries 非空）。
    未出现的 task_type 走继承链解析。
    """
    version: int = 1               # 配置格式版本，便于未来迁移
    default_weight: float = 1.0    # 新 API 加入时的默认权重
    pools: dict[str, list[PoolEntry]]  # task_type -> entries
```

### APIPoolManager

```python
# manager.py
import threading
from copy import deepcopy

class APIPoolManager:
    """管理所有任务类型的 API 候选池。

    实现 ModelSelector Protocol。
    线程安全：所有写操作持锁，select() 持锁。
    全局单例，由 ModelRegistry 持有引用。
    """

    def __init__(
        self,
        config: PoolConfig | None = None,
        *,
        default_pool: TaskPool | None = None,
    ):
        self._lock = threading.RLock()
        self._pools: dict[str, TaskPool] = {}
        self._default_pool = default_pool
        if config:
            self.replace_config(config)
        else:
            self._init_defaults()

    # --- 选择（对外核心接口）---

    def select(self, task_type: str, override: str | None = None) -> str:
        """从任务候选池中按权重随机选择。override 优先。"""
        if override:
            return override
        with self._lock:
            pool = resolve_pool(task_type, self._pools, default_pool=self._default_pool)
            return weighted_select(pool.entries)

    # --- 注册 ---

    def register_api(
        self,
        api_id: str,
        *,
        add_to: list[str] | None = None,
        exclude_from: list[str] | None = None,
    ) -> None:
        """注册新 API。默认加入所有已知任务类型的池。"""
        if add_to is not None and exclude_from is not None:
            raise ValueError("add_to and exclude_from are mutually exclusive")

        entry = PoolEntry(api_id=api_id, weight=self._default_weight)

        with self._lock:
            if add_to is not None:
                targets = set(add_to)
            else:
                targets = set(self._list_all_task_types())
                if exclude_from is not None:
                    targets -= set(exclude_from)
            for task_type in targets:
                self._ensure_pool(task_type).entries.append(deepcopy(entry))

    def unregister_api(self, api_id: str) -> None:
        """从所有池中移除该 API。"""
        with self._lock:
            for pool in self._pools.values():
                pool.entries = [e for e in pool.entries if e.api_id != api_id]

    # --- 用户调整 ---

    def adjust_weight(self, task_type: str, api_id: str, weight: float) -> None: ...
    def upvote(self, task_type: str, api_id: str, delta: float = 0.5) -> None: ...
    def downvote(self, task_type: str, api_id: str, delta: float = 0.5) -> None:
        """调低权重。最低为 0（不参与选择但仍在池中，可用 upvote 恢复）。"""
    def disable(self, task_type: str, api_id: str) -> None:
        """禁用（enabled=False，保留条目，可 enable 恢复）。"""
    def enable(self, task_type: str, api_id: str) -> None: ...
    def remove(self, task_type: str, api_id: str) -> None:
        """永久删除条目（不可恢复）。"""

    # --- 池 fork ---

    def fork_pool(self, task_type: str) -> TaskPool:
        """为子类型创建独立池（从父池深拷贝）。

        例如 /pool fork skill/commit → 拷贝 subagent/skill 池到 skill/commit。
        之后对 skill/commit 的调整不影响 subagent/skill。
        """
        with self._lock:
            parent = resolve_pool(task_type, self._pools, default_pool=self._default_pool)
            new_pool = TaskPool(
                task_type=task_type,
                entries=deepcopy(parent.entries),
            )
            self._pools[task_type] = new_pool
            return new_pool

    # --- 查询 ---

    def get_pool(self, task_type: str) -> TaskPool: ...
    def list_task_types(self) -> list[str]: ...
    def list_apis(self, task_type: str) -> list[PoolEntry]: ...

    # --- 持久化 ---

    def to_config(self) -> PoolConfig:
        """导出当前池状态为可持久化配置。

        只导出有独立池的 task_type（entries 非空）。
        调用时机：/pool save、会话结束时 config 模块调用。
        """
    def replace_config(self, config: PoolConfig) -> None:
        """用配置文件内容替换当前池状态（加载配置时调用）。"""

    # --- 内部 ---

    @property
    def _default_weight(self) -> float: ...
    def _list_all_task_types(self) -> set[str]:
        """所有已知任务类型（TASK_HIERARCHY + 已有独立池）。"""
    def _ensure_pool(self, task_type: str) -> TaskPool: ...
    def _init_defaults(self) -> None:
        """初始化根任务类型空池。"""
```

### 选择算法

```python
# selector.py
import random
import math

WEIGHT_EPSILON = 1e-9  # 权重比较容限

class NoAPIAvailable(Exception):
    """池中无可用 API。"""

def weighted_select(entries: Sequence[PoolEntry]) -> str:
    """按权重随机选择一个 API（纯函数）。

    权重 <= EPSILON 或 disabled 的条目不参与选择。
    """
    active = [e for e in entries if e.enabled and e.weight > WEIGHT_EPSILON]
    if not active:
        raise NoAPIAvailable("no active API in pool")

    total = sum(e.weight for e in active)
    r = random.uniform(0, total)
    cumulative = 0.0
    for e in active:
        cumulative += e.weight
        if r <= cumulative:
            return e.api_id
    # 浮点舍入导致未命中，返回最后一个
    return active[-1].api_id
```

### 任务类型继承（单一真相源）

```python
# tasks.py

# 静态继承关系。继承关系只在这里定义，TaskPool 上不重复。
# 不在此处的 task_type：
#   - "skill/<name>" → resolve_parent 返回 "subagent/skill"
#   - 其他未知 → resolve_parent 返回 None（视为根类型）
TASK_HIERARCHY: dict[str, str | None] = {
    "main": None,
    "subagent": None,
    "continuous": None,
    "background": None,
    "subagent/explore": "subagent",
    "subagent/plan": "subagent",
    "subagent/general": "subagent",
    "subagent/compact": "subagent",
    "subagent/memory": "subagent",
    "subagent/skill": "subagent",
    "subagent/meta": "subagent",
    "subagent/classify": "subagent",
    "subagent/code": "subagent",
    "continuous/cron": "continuous",
    "continuous/monitor": "continuous",
    "continuous/heartbeat": "continuous",
    "background/dream": "continuous",
    "background/title": "continuous",
    "background/compact": "continuous",
    "background/flush": "continuous",
}

def resolve_parent(task_type: str) -> str | None:
    """解析任务类型的父类型（纯函数）。

    查找顺序：静态 TASK_HIERARCHY → skill/* 前缀 → 未知返回 None
    """
    if task_type in TASK_HIERARCHY:
        return TASK_HIERARCHY[task_type]
    if task_type.startswith("skill/"):
        return "subagent/skill"
    return None

def resolve_pool(
    task_type: str,
    pools: dict[str, TaskPool],
    *,
    default_pool: TaskPool | None = None,
) -> TaskPool:
    """解析任务对应的最终池（纯函数）。

    沿继承链向上查找，返回第一个有独立配置的池。
    整条链都没有独立池时，使用 default_pool。
    default_pool 也为 None 时抛出 NoAPIAvailable。
    """
    current = task_type
    while current is not None:
        pool = pools.get(current)
        if pool is not None and pool.entries:
            return pool
        current = resolve_parent(current)
    if default_pool is not None:
        return default_pool
    raise NoAPIAvailable(
        f"no pool for task_type '{task_type}' and no default pool configured"
    )
```

**fallback 链示例**：`skill/commit` → `subagent/skill`（无独立池）→ `subagent`（有独立池）→ 使用 subagent 池。如果 `subagent` 也没池，回退到 `default_pool`。连 `default_pool` 都没有才抛异常。

**未知 task_type**：用户/插件可能创建未注册的自定义 task_type。此时 `resolve_parent()` 返回 `None`，`resolve_pool()` 直接走到 `default_pool`。不会崩。

### 持久化时机

运行时调整（upvote/downvote/disable/fork）**只修改内存**，不自动落盘：

- **会话结束时**：config 模块调用 `pool_manager.to_config()` 写入 `~/.wings/config.toml`
- **用户主动保存**：`/pool save` 命令
- **加载时**：config 模块读 TOML → PoolConfig → `pool_manager.replace_config()`

这样避免每次 upvote 都写盘，也允许用户在一个会话中随意试，不满意不保存。

### 关键文件

- `protocol.py` — `ModelSelector` Protocol（对外接口，最小表面积）
- `types.py` — `PoolEntry`, `TaskPool`, `PoolConfig`（纯数据）
- `selector.py` — `weighted_select()`, `NoAPIAvailable`（纯函数）
- `tasks.py` — `TASK_HIERARCHY`, `resolve_parent()`, `resolve_pool()`（纯函数）
- `manager.py` — `APIPoolManager`（有状态，线程安全，实现 ModelSelector）

**每个文件可独立测试，可独立替换。**

---

## 3. tools — 工具系统

**位置**: `src/wings/tools/`
**依赖**: 无（独立模块）

### Tool 协议

```python
# base.py
from typing import Protocol, Any
from pydantic import BaseModel
from collections.abc import Callable

class ToolResult(BaseModel):
    output: str
    error: str | None = None
    metadata: dict[str, Any] = {}
    max_result_size_chars: int | None = None  # 超此值写文件

class ToolContext(BaseModel):
    working_dir: str
    env: dict[str, str]
    session_id: str

class Tool(Protocol):
    """所有工具需实现的协议"""
    name: str
    description: str
    search_hint: str

    def input_schema(self) -> dict[str, Any]: ...  # JSON Schema

    async def call(self, input: Any, context: ToolContext) -> ToolResult: ...

    def is_enabled(self) -> bool: ...
    def is_read_only(self, input: Any) -> bool: ...
    def is_destructive(self, input: Any) -> bool: ...

    def render_result(self, result: ToolResult) -> str: ...
    def activity_description(self, input: Any) -> str: ...  # spinner 文案
```

### @tool 装饰器

参考 opensquilla 的装饰器模式：

```python
# decorator.py
import functools
from typing import Type, get_type_hints
from pydantic import BaseModel

def tool(
    *,
    name: str,
    description: str,
    search_hint: str,
    read_only: bool = False,
    destructive: bool = False,
):
    """将 async 函数注册为 Tool"""
    def decorator(fn):
        hints = get_type_hints(fn)
        # 第一个参数（input 之外）是 Pydantic model → input_schema
        input_type = next(
            (t for n, t in hints.items() if n != "return" and issubclass(t, BaseModel)),
            None,
        )

        @functools.wraps(fn)
        class _ToolAdapter:
            name = name
            description = description
            search_hint = search_hint

            def input_schema(self) -> dict:
                return input_type.model_json_schema() if input_type else {}

            async def call(self, input, context):
                result = await fn(input, context)
                return ToolResult(output=str(result))

            def is_enabled(self) -> bool:
                return True

            def is_read_only(self, input=None) -> bool:
                return read_only

            def is_destructive(self, input=None) -> bool:
                return destructive

            def render_result(self, result: ToolResult) -> str:
                return result.output

            def activity_description(self, input=None) -> str:
                return f"{name}..."

        return _ToolAdapter()
    return decorator
```

### Registry

```python
# registry.py
class ToolRegistry:
    def __init__(self):
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None: ...
    def get(self, name: str) -> Tool | None: ...
    def list_all(self) -> list[Tool]: ...
    def list_enabled(self) -> list[Tool]: ...
    def get_schemas(self) -> list[dict[str, Any]]: ...  # 生成给 LLM 的 tool schemas
    def filter_denied(self, deny_list: list[str]) -> None: ...
```

### 首批内置工具

| 工具 | 文件 | 优先级 | 说明 |
|------|------|--------|------|
| `read` | `builtin/read.py` | P0 | 读取文件 |
| `write` | `builtin/write.py` | P0 | 创建/覆盖文件 |
| `edit` | `builtin/edit.py` | P0 | 精确字符串替换 |
| `bash` | `builtin/bash.py` | P0 | shell 命令 |
| `glob` | `builtin/glob.py` | P1 | 文件名模式匹配 |
| `grep` | `builtin/grep.py` | P1 | 内容正则搜索 |
| `web_fetch` | `builtin/web_fetch.py` | P1 | 网页内容抓取 |
| `web_search` | `builtin/web_search.py` | P1 | 网络搜索 |
| `agent_tool` | `builtin/agent_tool.py` | P1 | 生成子 agent |

### MCP 工具加载

`tools/mcp/loader.py` — 从 MCP 服务器加载工具，命名格式 `mcp__server__tool_name`，支持可选 prefix 剥离。

---

## 4. query — 查询引擎

**位置**: `src/wings/query/`
**依赖**: models, messages, tools

### engine.py

```python
# engine.py
from typing import AsyncIterator
from wings.messages.types import Message, StreamEvent
from wings.messages.normalize import MessageNormalizer
from wings.models.protocol import ModelProvider, ModelConfig, ModelResponse
from wings.models.registry import ModelRegistry

class QueryEngine:
    def __init__(
        self,
        normalizer: MessageNormalizer,
        registry: ModelRegistry,
    ): ...

    async def stream(
        self,
        messages: list[Message],
        model: str,              # 已选定的 API id（由 APIPoolManager.select 产生）
        tools: list[dict],
        config: ModelConfig,
    ) -> AsyncIterator[StreamEvent]:
        """流式查询 — 返回 AsyncIterator"""
        provider = self._registry.get(model)
        provider_messages = self._normalizer.to_provider(provider.provider_name, messages)
        provider_tools = self._normalizer.tools_to_provider(provider.provider_name, tools)

        async for event in provider.stream(provider_messages, provider_tools, config):
            yield event  # 各 provider 已在 adapter 中转为内部格式

    async def chat(
        self,
        messages: list[Message],
        model: str,
        tools: list[dict] | None,
        config: ModelConfig,
    ) -> ModelResponse: ...
```

职责：
- 通过 normalizer 转换消息格式
- 调用 model provider 的 `stream()` / `chat()`
- 处理 API 错误，重试 + 降级 fallback 模型
- Token 计数

### token_budget.py

```python
# token_budget.py
class TokenBudget:
    def __init__(
        self,
        context_window: int,
        reserved_for_output: int,    # 留给输出的配额
        system_prompt_tokens: int,
    ): ...

    def remaining(self, messages: list[Message]) -> int: ...
    def needs_compact(self, messages: list[Message]) -> bool: ...
    def estimate_tokens(self, text: str) -> int: ...
```

---

## 5. agent — Agent 核心循环

**位置**: `src/wings/agent/`
**依赖**: query, tools, messages, permissions, routing

### 关键文件

- `loop.py` — AgentLoop 主循环
- `handoff.py` — HandoffDetector, TurnRecord（模型转交检测）
- `subagent.py` — 子 agent 生成
- `coordinator.py` — 多 agent 协调器
- `resume.py` — 从 transcript 恢复会话

### 模型转交 (Model Handoff)

主对话中，候选池可能在同一会话的不同 turn 选出不同的模型。当同一模型的两次调用之间有其他模型被调用时，需要注入转交提示，让当前模型了解中间发生了什么，并审查是否需要修正。

**触发条件**：模型 A 被调用 → 中间有其他模型被调用 → 模型 A 再次被调用。

**注入的提示包含**：
1. 说明中间任务已转交给其他模型处理
2. 要求模型在进行当前任务之外，分析最近行为中是否有需要修正但尚未修正的问题

```python
# handoff.py
from datetime import datetime
from pydantic import BaseModel

class TurnRecord(BaseModel):
    """记录每个 turn 的模型调用情况"""
    turn_id: int
    model_id: str                                  # 使用的 API id
    timestamp: datetime
    user_input_summary: str                        # 用户输入摘要（一句话）
    tool_calls: list[str]                          # 该 turn 中调用的工具名
    summary: str = ""                              # 该 turn 做了什么（一句话）

class HandoffDetector:
    """检测模型转交，生成转交提示。

    在主对话的 AgentLoop 中维护一个 TurnRecord 列表。
    """

    def detect(
        self,
        current_model: str,
        turn_history: list[TurnRecord],
    ) -> str | None:
        """检测是否需要注入转交提示。

        返回转交提示文本，或 None（不需要）。
        """
        if len(turn_history) < 2:
            return None

        # 找到当前模型上一次出现的 turn
        previous_same_model = None
        has_other_between = False
        for turn in reversed(turn_history):
            if turn.model_id == current_model:
                previous_same_model = turn
                break

        if previous_same_model is None:
            return None  # 该模型首次出现，无需转交

        # 检查中间是否有其他模型
        saw_self = False
        intermediate_turns: list[TurnRecord] = []
        for turn in reversed(turn_history):
            if turn is previous_same_model:
                saw_self = True
            elif saw_self and turn.model_id != current_model:
                intermediate_turns.append(turn)

        if not intermediate_turns:
            return None  # 中间没有其他模型

        return self._build_handoff_prompt(
            current_model=current_model,
            previous_turn=previous_same_model,
            intermediate_turns=intermediate_turns,
        )

    def _build_handoff_prompt(
        self,
        current_model: str,
        previous_turn: TurnRecord,
        intermediate_turns: list[TurnRecord],
    ) -> str:
        """构建转交提示。"""
        other_models = sorted({t.model_id for t in intermediate_turns})
        turns_desc = "\n".join(
            f"  - [{t.model_id}] {t.summary or t.user_input_summary}"
            for t in reversed(intermediate_turns)
        )

        return f"""\
[系统提示] 自你上次参与此对话（turn #{previous_turn.turn_id}）以来，共有 \
{len(intermediate_turns)} 个 turn 转交给了其他模型处理：{', '.join(other_models)}。

中间发生的工作:
{turns_desc}

在进行当前任务之前，请：
1. 审查这些中间 turn 的行为是否有需要修正但尚未修正的问题（如不一致的代码风格、
   冲突的决策、遗漏的边界条件等）
2. 如果发现问题，优先修正后再进行当前任务
3. 如果没有需要修正的问题，直接进行当前任务"""
```

### loop.py（含转交检测）

```python
# loop.py
from typing import AsyncIterator
from wings.messages.types import Message, StreamEvent, Role
from wings.tools.base import Tool, ToolContext, ToolResult
from wings.query.engine import QueryEngine
from wings.models.protocol import ModelConfig
from wings.permissions.pipeline import PermissionPipeline
from wings.routing.protocol import ModelSelector

class AgentLoop:
    def __init__(
        self,
        query_engine: QueryEngine,
        tool_registry: ToolRegistry,
        permission_pipeline: PermissionPipeline,
        model_selector: ModelSelector,
    ):
        self._turn_history: list[TurnRecord] = []
        self._handoff_detector = HandoffDetector()

    async def run(
        self,
        user_input: str,
        context: AgentContext,
    ) -> AsyncIterator[StreamEvent]:
        messages = self._assemble_messages(user_input, context)
        model = self._select_model(context)  # from pool by task_type
        config = self._build_config(model)
        tools = self._tool_registry.get_schemas()

        # --- 模型转交检测 ---
        if context.task_type == "main":
            handoff_prompt = self._handoff_detector.detect(
                model, self._turn_history,
            )
            if handoff_prompt:
                # 作为 system 消息注入到消息列表
                messages.append(Message(role=Role.USER, content=[TextBlock(text=handoff_prompt)]))

        # 记录当前 turn
        self._turn_history.append(TurnRecord(
            turn_id=len(self._turn_history),
            model_id=model,
            timestamp=datetime.now(),
            user_input_summary=user_input[:200],
            tool_calls=[],
        ))

        while True:
            had_tool_use = False

            async for event in self._query_engine.stream(
                messages, model, tools, config,
            ):
                if event.type == "tool_use":
                    tool = self._tool_registry.get(event.name)
                    if tool:
                        decision = await self._permission_pipeline.check(
                            tool, event.input, self._tool_context,
                        )
                        if decision == "deny":
                            messages.append(self._inject_error(event.id, "Permission denied"))
                            had_tool_use = True
                            break

                        # 记录工具调用
                        self._turn_history[-1].tool_calls.append(event.name)

                        result = await tool.call(event.input, self._tool_context)
                        messages.append(ToolResultMessage(
                            role=Role.USER,
                            content=[ToolResultBlock(
                                tool_use_id=event.id,
                                content=result.output,
                                is_error=result.error is not None,
                            )],
                        ))
                        had_tool_use = True
                        break

                yield event  # 文本、thinking 直接输出

            if not had_tool_use:
                # 更新 turn 摘要
                self._turn_history[-1].summary = self._extract_summary(messages)
                return  # end_turn

    def _assemble_messages(self, user_input: str, context: AgentContext) -> list[Message]: ...
    def _select_model(self, context: AgentContext) -> str:
        """从 ModelSelector 获取 API。"""
        return self._selector.select(
            task_type=context.task_type,
            override=context.model_override,
        )
    def _inject_error(self, tool_use_id: str, error: str) -> Message: ...
    def _extract_summary(self, messages: list[Message]) -> str: ...
```
```

### 子 Agent 类型与任务分类

参考 claude-code 和 opensquilla 的子 agent 体系，wings 将所有任务分为以下类型，每种类型对应独立的 API 候选池，可选用不同的默认工具集。

#### 任务类型全景

| 任务类型 | 触发场景 | 来源参考 | 默认 API 池 | 默认工具集 |
|----------|----------|----------|-------------|-----------|
| `main` | 主 session 与用户对话 | 两个项目的主 REPL 循环 | 全部 API | 全部工具 |
| `subagent/explore` | 代码库探索、搜索、理解结构 | claude-code `exploreAgent` | 继承 subagent | read, glob, grep, web_search |
| `subagent/plan` | 方案规划、架构设计 | claude-code `planAgent` | 继承 subagent | read, glob, grep, web_search |
| `subagent/general` | 通用子任务委托 | claude-code `generalPurposeAgent` | subagent 池 | 受限工具集 |
| `subagent/compact` | 对话压缩/摘要 | 两个项目都有 compact 服务 | subagent 池 | 无工具（纯 LLM 摘要） |
| `subagent/memory` | 记忆保存、刷新、巩固 (Dream) | opensquilla memory flush/dream | subagent 池 | memory 读写工具 |
| `subagent/skill` | 技能执行（fork 模式，未细分时回退到此） | 两个项目的 skill 系统 | subagent 池 | 技能指定的工具 |
| `skill/<name>` | 特定技能（如 `skill/commit`, `skill/review-pr`）| 继承 subagent/skill | 继承 subagent/skill | 该技能指定的工具 |
| `subagent/meta` | DAG 多步编排子任务 | opensquilla meta-skill orchestrator | subagent 池 | 编排器指定工具 |
| `subagent/classify` | 确定性分类/路由决策 | opensquilla `llm_classify` | subagent 池 | 无工具 |
| `subagent/chat` | 隔离对话（如敏感内容处理） | opensquilla `llm_chat` | subagent 池 | 受限工具 |
| `subagent/code` | 编码模式子任务 | opensquilla coding_mode | subagent 池 | read, write, edit, bash |
| `continuous/cron` | 定时任务执行 | claude-code CronTool, opensquilla scheduler | continuous 池 | 任务指定工具 |
| `continuous/monitor` | 轮询/监控 | claude-code MonitorTool | continuous 池 | 状态检查工具 |
| `continuous/heartbeat` | 心跳检查 | opensquilla HEARTBEAT.md | continuous 池 | 无工具（轻量检查） |
| `background/dream` | 离线记忆巩固 | 两个项目的 Dream 系统 | continuous 池 | memory 读写 |
| `background/title` | 会话命名 | opensquilla session naming | continuous 池 | 无工具 |
| `background/compact` | 后台上下文压缩 | claude-code auto-compact | continuous 池 | 无工具 |
| `background/flush` | 会话关闭记忆刷新 | opensquilla SessionFlushService | continuous 池 | memory 写入 |

#### 详细说明

**Explore Agent** (claude-code `exploreAgent`)
- 触发：模型需要理解不熟悉的代码库结构时
- 特点：只读工具为主，fork 语义隔离上下文
- System prompt 强调"快速搜索、不修改文件"
- API 池偏好：便宜快速的模型（探索不需要深度推理）

**Plan Agent** (claude-code `planAgent`)
- 触发：需要设计方案、规划实施步骤时
- 特点：可读但不应修改文件
- System prompt 强调"考虑架构权衡、设计可验证的步骤"
- API 池偏好：推理能力强的模型

**General Purpose Agent** (claude-code `generalPurposeAgent`)
- 触发：通用子任务委托，未匹配到专门类型时回退
- 特点：受限但完整的工具集
- 用于隔离上下文、并行执行独立子任务

**Compact Agent**
- 触发：上下文窗口接近上限，需压缩历史消息
- claude-code 有 4 种 compact prompt（完整/部分/前缀/无工具）
- opensquilla 额外提取"义务"（目标、约束、决策、工件、错误）
- 纯 LLM 摘要任务，不需要工具

**Memory Agent**
- 触发：会话结束、定期保存记忆、Dream 巩固
- opensquilla 的 Dream 是离线 LLM 过程：扫描新文件 → 证据评分 → 排序 → LLM 决策 upsert/merge/skip → 应用到 MEMORY.md
- claude-code 在会话结束时自动保存学习内容

**Meta Agent** (opensquilla meta-skill orchestrator)
- 触发：复杂多步技能需要分解为 DAG 执行时
- SOP 编译器将自然语言工作流编译为 DAG
- 每个节点作为独立子 agent 执行，支持并行和依赖

**Cron / Monitor / Heartbeat** (continuous 类)
- 定时任务：用户设定的周期性任务（如"每 5 分钟检查部署状态"）
- 监控：后台轮询检查状态变化
- 心跳：opensquilla 的心跳机制，定期注入 HEARTBEAT.md 内容

**Skill Agent** (per-skill 独立池)
- 每个 skill 如果触发 API 调用，都可以有自己的候选池 `skill/<name>`
- 例如 `/pool` 可以为 `skill/commit` 单独设置池（偏好快速模型），为 `skill/review-pr` 设置另一个池（偏好推理强模型）
- 默认继承 `subagent/skill` 池，用户可用 `/pool fork skill/<name>` 创建独立池
- Skill 注册时自动创建对应的任务类型条目，但默认不分配独立池（走继承）
- 适用于 claude-code 和 opensquilla 中所有 fork 模式的 skill

#### 任务继承关系

```
main                          # 根任务（主对话）
subagent                      # 子 agent 基类型
├── subagent/explore          # 继承 subagent（可 fork 独立池）
├── subagent/plan
├── subagent/general
├── subagent/compact
├── subagent/memory
├── subagent/skill            # 技能执行基类型
│   ├── skill/commit          # 继承 subagent/skill（每个 skill 可有独立池）
│   ├── skill/review-pr
│   ├── skill/pdf
│   ├── skill/simplify
│   └── skill/<name>          # 动态注册，默认继承 subagent/skill
├── subagent/meta
├── subagent/classify
├── subagent/chat
└── subagent/code
continuous                    # 根任务（持续运行）
├── continuous/cron
├── continuous/monitor
└── continuous/heartbeat
background                    # 根任务（后台触发）
├── background/dream
├── background/title
├── background/compact
└── background/flush
```

各子类型默认继承父任务类型的 API 候选池。用户可用 `/pool fork <subtype>` 为子类型创建独立池。

### 模型选择优先级

同一会话中，模型选择遵循以下优先级：

1. **Skill 指定模型** — skill 定义的 `model` 覆盖（如某 skill 要求特定模型）
2. **用户 `/model` 覆盖** — `/model claude-opus-4-6` 临时指定
3. **子任务独立池** — `subagent/explore` 等有独立池时用独立池
4. **父任务池回退** — 无独立池时回退到父类型池（如 subagent）
5. **全局默认池** — 极端回退

```python
def resolve_model(
    task_type: str,
    skill_model: str | None = None,
    user_override: str | None = None,
    pools: dict[str, TaskPool] | None = None,
) -> str:
    if skill_model:
        return skill_model
    if user_override:
        return user_override
    return pool_manager.select(task_type)
```

### subagent.py

子 agent 生成：
- 独立 AgentLoop 实例，受限工具集（只读为主）
- fork 语义：继承父 agent 的部分上下文
- `builtin/agent_tool.py` 调用此逻辑
- 可指定任务类型以选择不同 API 池

### coordinator.py

多 agent 协调器（参考 opensquilla MetaOrchestrator）：
- 复杂任务分解为 DAG
- 各节点作为独立子 agent 执行，各自从对应任务池选择 API
- 支持并行节点 + 依赖节点
- 事件流合并：多子 agent 的输出合并为统一流
- 结果汇总

### resume.py

从持久化 transcript 恢复会话：
- 重建 Message[] 历史
- 恢复 agent 状态
- 恢复 TurnRecord 历史（保证模型转交检测连续性）

---

## 6. permissions — 权限系统

**位置**: `src/wings/permissions/`
**依赖**: tools

### pipeline.py

```python
# pipeline.py
from typing import Literal
from wings.tools.base import Tool, ToolContext

PermissionResult = Literal["allow", "deny", "ask"]

class PermissionPipeline:
    def __init__(
        self,
        rules: "PermissionRules",
        hook_runner: "HookRunner | None" = None,
    ): ...

    async def check(
        self,
        tool: Tool,
        tool_input: object,
        context: ToolContext,
    ) -> PermissionResult:
        # Stage 1: 静态规则
        static_result = self._rules.match(tool.name)
        if static_result != "ask":
            return static_result

        # Stage 2: 自动分类（只读操作自动放行）
        if tool.is_read_only(tool_input):
            return "allow"

        # Stage 3: hooks
        if self._hook_runner:
            hook_result = await self._hook_runner.run_pre_tool_use(
                tool.name, tool_input,
            )
            if hook_result is not None:
                return hook_result

        # Stage 4: 交互式审批（交给 UI）
        return "ask"
```

### rules.py

```python
# rules.py
class PermissionRules:
    allowlist: set[str]     # 始终允许
    denylist: set[str]      # 始终拒绝
    asklist: set[str]       # 每次询问

    @classmethod
    def from_config(cls, config: dict) -> "PermissionRules": ...

    def match(self, tool_name: str) -> PermissionResult:
        if tool_name in self.denylist:
            return "deny"
        if tool_name in self.allowlist:
            return "allow"
        return "ask"

    def add_allow(self, tool_name: str) -> None: ...
    def add_deny(self, tool_name: str) -> None: ...
```

---

## 7. hooks — 生命周期钩子

**位置**: `src/wings/hooks/`
**依赖**: 无

### types.py

```python
# types.py
from enum import Enum

class HookEvent(str, Enum):
    PRE_TOOL_USE = "pre_tool_use"
    POST_TOOL_USE = "post_tool_use"
    USER_PROMPT_SUBMIT = "user_prompt_submit"
    SESSION_START = "session_start"
    STOP = "stop"
    PRE_COMPACT = "pre_compact"
    NOTIFICATION = "notification"

class HookConfig(BaseModel):
    event: HookEvent
    command: str              # shell 命令或脚本路径
    matcher: str | None = None  # 可选：仅匹配特定工具名的正则
```

### runner.py

钩子可以：
- `updated_input` — 修改工具输入
- `decision: "block"` — 阻止操作
- `additional_context` — 向模型注入额外上下文
- `system_message` — 向用户显示系统消息
- `suppress_output` — 隐藏工具输出

---

## 8. config — 配置系统

**位置**: `src/wings/config/`
**依赖**: 无

### 分层配置（优先级从高到低）

```
CLI 参数 > 环境变量 > 项目配置 (wings.toml) > 全局配置 (~/.wings/config.toml) > 内置默认
```

### 候选池配置示例 (`~/.wings/config.toml`)

```toml
[routing]
default_weight = 1.0

# 主对话池：偏好 Claude Opus
[[routing.pools.main]]
api_id = "anthropic/claude-opus-4-6"
weight = 2.0

[[routing.pools.main]]
api_id = "openai/gpt-4o"
weight = 1.0

[[routing.pools.main]]
api_id = "google/gemini-2.5-pro"
weight = 0.5  # 不太偏好

# 子 agent 池：偏好快速便宜的模型
[[routing.pools.subagent]]
api_id = "anthropic/claude-haiku-4-5"
weight = 3.0

[[routing.pools.subagent]]
api_id = "openai/o4-mini"
weight = 1.0

# subagent/explore 继承 subagent 池，无需单独配置
# subagent/plan 同样继承

# 后台任务池：只需要便宜的
[[routing.pools.continuous]]
api_id = "anthropic/claude-haiku-4-5"
weight = 1.0
```

参考 opensquilla 的 Pydantic Settings 模式：

### settings.py

```python
# settings.py
from pydantic_settings import BaseSettings, SettingsConfigDict
from pathlib import Path

class LLMConfig(BaseModel):
    provider: str = "anthropic"
    model: str = "claude-sonnet-4-6"
    api_key: str = ""
    base_url: str | None = None

class GlobalSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="WINGS_",
        env_nested_delimiter="__",
        toml_file=Path.home() / ".wings" / "config.toml",
    )

    default_model: str = "claude-sonnet-4-6"
    llm: dict[str, LLMConfig] = {}

    # API 候选池配置
    routing: PoolConfig = PoolConfig()

    theme: Literal["dark", "light"] = "dark"
    auto_compact: bool = True

class ProjectSettings(BaseModel):
    allowed_tools: list[str] = []
    denied_tools: list[str] = []
    model: str | None = None        # 项目级模型覆盖
    mcp_servers: list[str] = []
    hooks: dict[str, list[str]] = {}  # 项目级 hooks
    personality: str | None = None    # 追加到 system prompt

    @classmethod
    def from_directory(cls, dir_path: Path) -> "ProjectSettings":
        toml_file = dir_path / "wings.toml"
        if toml_file.exists():
            import tomllib
            return cls(**tomllib.loads(toml_file.read_text()))
        return cls()
```

---

## 9. context — 上下文收集

**位置**: `src/wings/context/`

### system_prompt.py

组装系统提示词，包含：
- 工具列表描述（从 ToolRegistry.get_schemas() 生成）
- 环境信息（OS, shell, date, git status）
- 行为指引（"一切皆工具"、"先读再改"、"简洁回复"等）

参考 opensquilla 的 `identity/templates/bootstrap/` 多文件注入模式（AGENTS.md, TOOLS.md, SOUL.md 分开管理）。

### environment.py

```python
# environment.py
from pydantic import BaseModel
from datetime import datetime

class Environment(BaseModel):
    os: str
    shell: str
    working_dir: str
    date: str = datetime.now().strftime("%Y-%m-%d")
    git_branch: str | None = None
    git_status: str | None = None

    @classmethod
    def detect(cls) -> "Environment": ...
```

---

## 10. 其他模块

### memory — 持久化记忆
- `memory/store.py` — 文件系统存储，按类型分文件（user, project, feedback, reference）
- 格式：markdown + YAML frontmatter（参考 opensquilla 的 MEMORY.md 模式）
- Phase 2 参考 opensquilla `memory/dream/` 做离线记忆巩固

### skills — 可复用技能
- `skills/loader.py` — 从 `~/.wings/skills/` 等目录加载 `.md` 技能定义
- 技能 = 预定义 prompt + 可选工具组合
- 参考 opensquilla 的 6 层加载（Extra < Bundled < Managed < Personal < Project < Workspace）

### plugins — 插件系统
- `plugins/loader.py` — 从 PyPI 包或本地路径加载插件
- 插件可提供：tools、模型适配器、hooks
- 参考 opensquilla 的 `channels/registry.py` 的 pkgutil 自动发现模式

### services — 外部服务
- `services/api/` — HTTP 客户端（httpx：重试、超时、代理）
- `services/mcp/` — MCP client/server 实现

---

## 11. 实施顺序

| 阶段 | 模块 | 状态 | 实际文件 | 测试数 |
|------|------|------|----------|--------|
| 1 | messages | ✅ | `types.py`, `normalize.py` (含 MessageNormalizer) | 26 |
| 1b | routing | ✅ | `protocol.py`, `types.py`, `selector.py`, `tasks.py`, `manager.py` | 47 |
| 2 | models | ✅ | `protocol.py`, `capabilities.py`, `registry.py`, `anthropic.py`, `openai.py` | 21 |
| 3 | tools | ✅ | `base.py`, `registry.py`, `decorator.py`, `builtin/read.py`, `builtin/write.py`, `builtin/edit.py`, `builtin/bash.py`, `builtin/glob.py`, `builtin/grep.py` | 35 |
| 4 | query | ✅ | `engine.py` (retry), `token_budget.py` (heuristic) | 15 |
| 5 | permissions | ✅ | `pipeline.py` (4-stage), `rules.py` (allowlist/denylist) | 17 |
| 6a | agent/core | — | `loop.py`, `handoff.py` | — |
| 6b | agent/subagent | — | `subagent.py`, `coordinator.py`, `resume.py` | — |
| 7 | config | — | `settings.py` | — |
| 8 | cli | — | `main.py`, `repl.py` | — |
| 9 | skills | — | `loader.py`, `injector.py` | — |
| 10+ | hooks, memory, plugins, MCP | — | — | — |

**总计**: 6 个阶段完成，161 个测试，~2250 行实现代码。

### 已完成模块的实际结构

```
src/wings/
├── __init__.py
├── messages/           # Phase 1
│   ├── __init__.py
│   ├── types.py        # Message, Role, TextBlock, ToolUseBlock, ToolResultBlock,
│   │                     StreamEvent (TextDelta, ToolUseDelta, ThinkingDelta), StopReason
│   └── normalize.py    # MessageNormalizer + from_/to_ anthropic + openai
├── routing/            # Phase 1b
│   ├── __init__.py
│   ├── protocol.py     # ModelSelector Protocol
│   ├── types.py        # PoolEntry, TaskPool, PoolConfig
│   ├── selector.py     # weighted_select(), NoAPIAvailable
│   ├── tasks.py        # TASK_HIERARCHY, resolve_parent(), resolve_pool()
│   └── manager.py      # APIPoolManager (thread-safe, implements ModelSelector)
├── models/             # Phase 2
│   ├── __init__.py
│   ├── protocol.py     # ModelConfig, TokenUsage, ModelResponse, ModelProvider Protocol
│   ├── capabilities.py # ModelCapabilities, CAPABILITY_CATALOG (7 models)
│   ├── registry.py     # ModelRegistry (delegates to ModelSelector Protocol)
│   ├── anthropic.py    # AnthropicProvider (chat + stream, system split, thinking)
│   └── openai.py       # OpenAIProvider (AsyncOpenAI, o-series, streaming tool calls)
├── tools/              # Phase 3
│   ├── __init__.py
│   ├── base.py         # ToolResult, ToolContext, Tool Protocol
│   ├── registry.py     # ToolRegistry (register, get, schemas, deny filter)
│   ├── decorator.py    # @tool decorator (auto-extracts Pydantic input_schema)
│   └── builtin/
│       ├── __init__.py
│       ├── read.py     # Read file with line numbers, offset/limit
│       ├── write.py    # Create/overwrite file, auto-create parent dirs
│       ├── edit.py     # Exact string replacement, duplicate detection
│       ├── bash.py     # Shell command execution, timeout, exit code
│       ├── glob.py     # File pattern matching
│       └── grep.py     # Regex search: content/files_with_matches/count
├── query/              # Phase 4
│   ├── __init__.py
│   ├── engine.py       # QueryEngine (retry with exponential backoff)
│   └── token_budget.py # TokenBudget (heuristic, 80% compact threshold)
└── ...
```

### 开发过程中的设计决策与反思

#### 1. MessageNormalizer 的补位

设计文档定义了带 `to_internal(provider, messages)` / `to_provider(provider, messages)` 的 Protocol，但 Phase 1 实现只有裸函数（`from_anthropic`, `to_openai` 等）。Phase 2 开发时发现：QueryEngine 需要一个统一入口来路由到不同 provider 的转换器，否则每个调用方都要写 if-else 分支。

**决策**: 在 Phase 1 中追加 `MessageNormalizer` 类，内部维护 `_from_provider` / `_to_provider` 注册表，模块加载时自动注册 anthropic 和 openai。对外暴露模块级 `normalizer` 单例。代价很小（~50 行），消除了未来的 if-else 扩散。

#### 2. Protocol 作为模块边界

routing 和 models 两个模块都遵循同一个模式：定义 Protocol → 实现类 → 调用方只依赖 Protocol。

- `ModelSelector` Protocol → `APIPoolManager` 实现 → `ModelRegistry` / `AgentLoop` 依赖
- `ModelProvider` Protocol → `AnthropicProvider` / `OpenAIProvider` 实现 → `QueryEngine` 依赖

**效果**: 换池实现（比如从加权随机换成 epsilon-greedy）不需要改 ModelRegistry。换 provider（比如新增 Google）不需要改 QueryEngine。Protocol 是零成本的类型安全抽象——Python 不做运行时检查，但 mypy 能做。

#### 3. 纯函数层的价值

routing 模块将 `weighted_select()`、`resolve_parent()`、`resolve_pool()` 作为纯函数独立出来。它们在测试中不需要构造 Manager、不需要 mock 锁、不需要关心线程安全。47 个 routing 测试中，~30 个只测纯函数。

**决策**: 保持这个模式。Phase 3 的 tools、Phase 5 的 permissions 也应该先写纯函数层。

#### 4. 设计文档 vs 实现的差异

部分设计细节在实现时调整了：

| 设计 | 实现 | 原因 |
|------|------|------|
| `TaskPool.inherit_from` 字段 | 删除，只用 `TASK_HIERARCHY` | 双源头会不一致 |
| `PoolConfig.version` 字段 | 新增 | 配置格式升级需要版本号 |
| `get_pool()` 行为 | 返回池（允许空），`select()` 才抛异常 | 查询和选择是不同的操作 |
| `from_config()` 类方法 | 改为 `replace_config()` | 构造函数用 `config=` 参数更直观 |
| `math` import 多余 | 删除 | lint 发现 |

#### 5. Adapter 的灵活性设计

Anthropic 和 OpenAI 的消息格式差异很大（system 消息位置、tool call 序列化方式、streaming 事件结构）。Adapter 内部做转换是对调用方完全透明的。

**Anthropic 特有处理**: system 消息从消息列表提取为顶层 `system` 参数；thinking mode 通过 `thinking: {type: enabled, budget_tokens}` 配置。

**OpenAI 特有处理**: o-series 模型用 `max_completion_tokens` 而非 `max_tokens`；tool call arguments 是 JSON 字符串需要 parse；streaming 中 tool call 通过 index 增量拼接。

#### 6. 模块间依赖

```
messages  ← 无依赖
    ↓
routing   ← 无依赖（纯数据结构 + 算法）
    ↓
models    ← messages (normalizer) + routing (ModelSelector Protocol)
    ↓
tools     ← 无依赖（独立模块）
    ↓
query     ← models + messages + tools
    ↓
agent     ← query + tools + messages + permissions + routing
```

关键原则：**每个新模块只依赖已完成的模块**。Phase 3 (tools) 可以独立开发，因为它不依赖前三个模块。

#### 7. @tool 装饰器的 Python 闭包陷阱

设计文档中示意了简化的装饰器实现：

```python
class _ToolAdapter:
    name = name  # 错误：类体无法访问外层函数变量
```

Python class body 有自己的隔离作用域，不能直接引用外层 `def tool()` 的参数。实现时改为：先将参数赋给局部变量（`_name = name`），方法通过闭包引用这些局部变量，类属性在类体定义后单独赋值。

**教训**：设计文档中的 Python 代码是伪代码，部分写法无法直接执行。后续设计评审应该关注语言特性边界。

#### 8. 每个工具独立 Pydantic Input 的价值

read.py 有 `ReadInput`，grep.py 有 `GrepInput`，各自带 `Field(description=...)`。这些 description 会成为 JSON Schema 的 description，直接注入 LLM system prompt。

**意外的收益**：测试可以直接 `from wings.tools.builtin.read import ReadInput` 并用 `ReadInput(file_path=str(f))` 构造合法输入，不需要 mock 任何东西。6 个内置工具都在 `tmp_path` 上真实执行。

#### 9. 有意推迟的决策

| 推迟项 | 原因 |
|--------|------|
| `ToolResult.max_result_size_chars` 未使用 | Phase 4 的 `TokenBudget` 需要它，届时统一处理 |
| 无-input 工具的 `call()` 支持 | 当前无实际用例，不影响进度 |
| `web_fetch` / `web_search` / `agent_tool` | 依赖 httpx 外部请求 / Phase 6 子 agent |
| `activity_description` 定制 | 统一 `f"{name}..."` 够用，过早抽象没必要 |
| 测试中大量 `asyncio.run()` | pytest-asyncio 已配置，可以后续统一加 `@pytest.mark.asyncio` |

#### 10. 当前模块状态一览

```
src/wings/
├── __init__.py
├── messages/           # Phase 1  ✅  26 tests
│   ├── types.py        # 6 种 MessageContent + 3 种 StreamEvent + StopReason
│   └── normalize.py    # MessageNormalizer + Anthropic + OpenAI 双向转换
├── routing/            # Phase 1b ✅  47 tests
│   ├── protocol.py     # ModelSelector Protocol
│   ├── types.py        # PoolEntry, TaskPool, PoolConfig(v1)
│   ├── selector.py     # weighted_select(), NoAPIAvailable
│   ├── tasks.py        # 19 条目 TASK_HIERARCHY + resolve_* 纯函数
│   └── manager.py      # APIPoolManager (RLock, fork, upvote/downvote)
├── models/             # Phase 2  ✅  21 tests
│   ├── protocol.py     # ModelConfig, TokenUsage, ModelResponse, ModelProvider
│   ├── capabilities.py # 7 模型能力数据
│   ├── registry.py     # ModelRegistry (依赖 ModelSelector Protocol)
│   ├── anthropic.py    # chat/stream, system split, thinking mode
│   └── openai.py       # AsyncOpenAI, o-series, streaming tool calls
└── tools/              # Phase 3  ✅  35 tests
    ├── base.py         # ToolResult, ToolContext, Tool Protocol
    ├── registry.py     # ToolRegistry
    ├── decorator.py    # @tool 装饰器
    └── builtin/        # read, write, edit, bash, glob, grep
├── permissions/        # Phase 5  ✅  17 tests
│   ├── __init__.py
│   ├── rules.py        # PermissionRules (allowlist/denylist/asklist)
│   └── pipeline.py     # 4-stage pipeline + HookRunner Protocol
```

#### 11. 消息双重转换 bug（Phase 4 发现并修复）

最初 `QueryEngine` 持有 `MessageNormalizer`，在调用 provider 之前将 `list[Message]` 转为 `list[dict]`。但 `AnthropicProvider` / `OpenAIProvider` 内部也会调用 `to_anthropic()` / `to_openai_messages()` 做同样的转换。dict 被当成 Message 传入 adapter 会直接 crash。

**根因**: 测试使用 mock provider（不检查消息格式），144 个测试全绿，但真实调用会炸。

**修复**: 去掉 engine 中的消息转换和 normalizer 依赖。Provider 自己负责格式转换——engine 只做错误处理和重试。

**教训**: mock 测试覆盖了"控制流"但漏掉了"数据流"。关键数据路径（消息格式的端到端传递）需要至少一个集成测试用真实 adapter 跑一遍。

#### 12. QueryEngine 的职责收窄

修复后 `QueryEngine` 只做两件事：(1) 从 registry 找 provider，(2) 带指数退避重试调用。消息转换、模型选择、工具执行都不归它管。

好处：Phase 6 AgentLoop 的职责划分更清晰——AgentLoop 负责循环和工具调度，QueryEngine 只负责"调用一次 LLM"。
