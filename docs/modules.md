# 模块详细设计 (Python)

## 1. messages — 消息类型系统

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
from collections.abc import Iterator

class ModelRegistry:
    def __init__(self):
        self._providers: dict[str, ModelProvider] = {}
        self._aliases: dict[str, str] = {}  # 别名 -> 标准名

    def register(self, name: str, provider: ModelProvider) -> None: ...
    def alias(self, alias: str, target: str) -> None:        # e.g. "opus" -> "claude-opus-4-6"
    def get(self, name: str) -> ModelProvider: ...
    def list(self) -> Iterator[str]: ...
    def route(self, task: "TaskRequirements") -> str: ...     # 智能路由
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
        model: str,
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
**依赖**: query, tools, messages, permissions

### loop.py

```python
# loop.py
from typing import AsyncIterator
from wings.messages.types import Message, StreamEvent, Role
from wings.tools.base import Tool, ToolContext, ToolResult
from wings.query.engine import QueryEngine
from wings.models.protocol import ModelConfig
from wings.permissions.pipeline import PermissionPipeline

class AgentLoop:
    def __init__(
        self,
        query_engine: QueryEngine,
        tool_registry: ToolRegistry,
        permission_pipeline: PermissionPipeline,
    ): ...

    async def run(
        self,
        user_input: str,
        context: AgentContext,
    ) -> AsyncIterator[StreamEvent]:
        messages = self._assemble_messages(user_input, context)
        model = self._select_model(context)
        config = self._build_config(model)
        tools = self._tool_registry.get_schemas()

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
                return  # end_turn

    def _assemble_messages(self, user_input: str, context: AgentContext) -> list[Message]: ...
    def _select_model(self, context: AgentContext) -> str: ...
    def _inject_error(self, tool_use_id: str, error: str) -> Message: ...
```

### subagent.py

子 agent 生成：
- 独立 AgentLoop 实例，受限工具集（只读为主）
- fork 语义：继承父 agent 的部分上下文
- `builtin/agent_tool.py` 调用此逻辑

### coordinator.py

多 agent 协调器：
- 复杂任务分解
- 分配给不同子 agent（可用不同模型）
- 结果汇总

### resume.py

从持久化 transcript 恢复会话：
- 重建 Message[] 历史
- 恢复 agent 状态

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

| 阶段 | 模块 | 关键文件 | 可验证 |
|------|------|----------|--------|
| 1 | messages | `types.py`, `normalize.py` | 单元测试: Anthropic/OpenAI 消息转换 |
| 2 | models | `protocol.py`, `registry.py`, `capabilities.py`, `anthropic.py`, `openai.py` | 单元测试: mock API |
| 3 | tools | `base.py`, `registry.py`, `decorator.py`, `builtin/read.py`, `builtin/write.py`, `builtin/bash.py` | 单元测试: 工具执行 |
| 4 | query | `engine.py`, `token_budget.py` | 集成测试: model + messages + tools |
| 5 | permissions | `pipeline.py`, `rules.py` | 单元测试: 权限判断 |
| 6 | agent | `loop.py`, `subagent.py` | E2E: 完整 agent 运行 |
| 7 | config | `settings.py` (GlobalSettings + ProjectSettings) | 单元测试: 配置读取/分层 |
| 8 | cli | `main.py` (Typer), `bootstrap.py`, `repl.py` (Rich) | 手动: `wings "hello"` |
| 9+ | hooks, memory, skills, plugins, MCP | 各模块 | 后续迭代 |
