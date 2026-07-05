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
│  Models  │ Messages │  Routing         │  ← 抽象层 (API候选池)
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
组装消息列表 (system prompt + environment info + skills + history + user message)
  │
  ▼
[while True: 工具调用循环]
  │
  ▼
选择模型 (每次 API 调用都从候选池加权随机选择)
  │
  ▼
转交检测 (首轮，同一模型再次出现 → 注入转交提示)
  │
  ▼
stream() ─── 调用 LLM API，流式返回 (AsyncIterator)
  │            └── stop_reason=max_tokens → 升级到 escalated_max_tokens 重试
  ▼
解析响应
  │
  ├── thinking ──→ 记录到日志
  ├── text ──→ 输出给用户
  │
  ├── tool_use ──→ 显示工具调用 ──→ 权限检查
  │                    │                │
  │                    ▼                ▼
  │              [y] 允许            [n] 拒绝 → 停止当前 turn
  │              [a] 记住作用域        │
  │                    │                │
  │                    ▼                ▼
  │              执行工具 ──→ 归组所有 tool_result
  │                    │          到一个 user 消息
  │                    ▼
  │              显示结果 (claude-code 风格)
  │                    │
  └────────────────────┘
                    │
                    ▼
         将 tool_result 追加到消息列表
                    │
                    ▼
            重新选模型，继续下一轮 stream()
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
    pool_manager: APIPoolManager,
    task_type: str,
) -> AsyncIterator[StreamEvent]:
    config = build_config()

    # 从候选池选择模型
    model_id = pool_manager.select(task_type, context.model_override)

    # 转交检测：主对话中同一模型再次出现但中间有其他模型
    if task_type == "main":
        handoff = handoff_detector.detect(model_id, turn_history)
        if handoff:
            messages.append(handoff_message(handoff))

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

| 模块 | 职责 | 状态 |
|------|------|------|
| `messages` | 消息类型 + 跨模型格式转换 + PermissionRequest | ✅ |
| `routing` | API 候选池管理 + softmax 加权随机选择 | ✅ |
| `models` | ModelProvider 协议 + Anthropic/OpenAI 适配器 (adaptive thinking, escalation) | ✅ |
| `tools` | Tool 协议 + 注册表 + 7 内置工具 (read/write/edit/bash/glob/grep/skill_view) | ✅ |
| `query` | LLM API 调用封装（retry, fallback） | ✅ |
| `agent` | 核心循环 + subagent (3 types: general/explore/plan) | ✅ |
| `permissions` | 5 阶段管道 (rules → scoped → classify → hooks → interactive) | ✅ |
| `config` | 全局/项目配置 (JSON, ProviderConfig w/ thinking/max_tokens) | ✅ |
| `cli` | Typer 入口 + chat/run (slash commands, 权限 UI, tool展示, ctrl+o展开) | ✅ |
| `skills` | 可复用技能/工作流 (SKILL.md, 3 内置 skill, per-skill API 池) | ✅ |
| `hooks` | 生命周期钩子 | — |
| `context` | system prompt + 环境信息 | — |
| `memory` | 持久化记忆 | — |
| `plugins` | 插件加载 | — |
| `services` | 外部服务封装（API, MCP） | — |

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

## API 候选池

**wings 与其他 agent 的核心差异点**：每次模型调用，都从当前任务的 API 候选池中加权随机选择一个 API 进行调用。

其他 agent 通常固定使用一个模型（如 claude-code 默认用 Claude），而 wings 让用户为每类任务培育自己的 API 组合——用户通过打分、设置调整各任务的候选池权重，系统不做"该用什么模型"的猜测。

```
每次 model call:
  │
  ▼
确定当前任务类型 (main / subagent / subagent/explore / subagent/plan / continuous / ...)
  │
  ▼
用户指定覆盖？──→ 是 ──→ 使用指定 API
  │
  ▼ 否
从当前任务类型的 API 候选池中加权随机选择
  │
  ▼
调用选中的 API
```

### 设计理念

1. **用户主导** — 不由系统猜测"什么任务适合什么模型"，用户通过实际使用不断调整各任务的候选池
2. **探索与收敛** — 初期所有 API 等权重参与；跑 100 个 turn 后用户自然知道"这类问题 A 模型更好"，并调整权重
3. **每个任务都有自己的池** — 主对话、子 agent、代码探索、方案规划等，各自独立管理候选 API 和权重
4. **诚实** — 承认"不知道哪个模型最好"，但提供了让用户自己发现和调整的机制

### 任务类型

wings 将所有模型调用分为三大类任务，参考 claude-code 和 opensquilla 的子 agent 体系。每种任务类型对应独立的 API 候选池。

| 任务类型 | 触发场景 | 默认池 | 参考来源 |
|----------|----------|--------|----------|
| `main` | 主 session 与用户的对话 | 所有已注册 API | 两个项目的主 REPL 循环 |
| `subagent/explore` | 代码库探索、搜索、理解结构 | 继承 subagent | claude-code `exploreAgent` |
| `subagent/plan` | 方案规划、架构设计 | 继承 subagent | claude-code `planAgent` |
| `subagent/general` | 通用子任务委托 | 继承 subagent | claude-code `generalPurposeAgent` |
| `subagent/compact` | 对话压缩/摘要 | 继承 subagent | 两个项目的 compact 服务 |
| `subagent/memory` | 记忆保存、Dream 巩固 | 继承 subagent | opensquilla memory flush/dream |
| `subagent/skill` | 技能执行（fork 模式，未细分时回退到此） | 继承 subagent | 两个项目的 skill 系统 |
| `skill/<name>` | 特定技能（如 `skill/commit`, `skill/review-pr`） | 继承 subagent/skill | 继承父池，可 fork 独立池 |
| `subagent/meta` | DAG 多步编排 | 继承 subagent | opensquilla MetaOrchestrator |
| `subagent/classify` | 确定性分类/路由 | 继承 subagent | opensquilla `llm_classify` |
| `subagent/code` | 编码模式子任务 | 继承 subagent | opensquilla coding_mode |
| `continuous/cron` | 定时任务执行 | 继承 continuous | claude-code CronTool |
| `continuous/monitor` | 轮询/监控 | 继承 continuous | claude-code MonitorTool |
| `background/dream` | 离线记忆巩固 | 继承 continuous | 两个项目的 Dream |
| `background/title` | 会话命名 | 继承 continuous | opensquilla session naming |
| `background/flush` | 会话关闭记忆刷新 | 继承 continuous | opensquilla SessionFlushService |

用户可自定义新的任务类型。子任务类型如果没有独立配置，自动继承父任务类型（`subagent`、`continuous`、`background`）的池设置。详见 `docs/design/modules.md` 的 agent 模块。

### 候选池操作

用户通过以下方式调整候选池：

| 操作 | 命令 | 效果 |
|------|------|------|
| 查看当前池 | `/pool` | 显示当前任务下各 API 的权重和状态 |
| 调高概率 | `/pool up <api>` | 增加该 API 在当前任务中的权重（默认 +0.5） |
| 调低概率 | `/pool down <api>` | 降低权重（默认 -0.5） |
| 设置权重 | `/pool set <api> <weight>` | 直接设置权重值 |
| 从池中移除 | `/pool remove <api>` | 从当前任务候选池中移除（不再被随机到） |
| 恢复到池中 | `/pool add <api>` | 恢复该 API 到候选池 |
| 全局配置 | `~/.wings/config.toml` | 直接编辑各任务池的权重配置 |

`/model` 命令仍保留，用于临时指定模型（该次调用绕过候选池）。

### 新 API 加入规则

1. **默认全加入** — 添加新 API 时，自动加入所有已知任务类型的候选池，默认权重 `1.0`
2. **指定任务** — `wings api add <name> --add-to main,subagent` 只加入特定任务的池
3. **排除任务** — `wings api add <name> --exclude-from continuous` 加入除指定外的所有池

### 加权随机选择

```python
import random

def weighted_select(entries: list[PoolEntry]) -> str:
    """从候选池中按权重随机选择一个 API。

    权重为 0 或 disabled 的条目不参与选择。
    """
    active = [e for e in entries if e.enabled and e.weight > 0]
    total = sum(e.weight for e in active)
    r = random.uniform(0, total)
    cumulative = 0.0
    for e in active:
        cumulative += e.weight
        if r <= cumulative:
            return e.api_id
    return active[-1].api_id  # fallback, 不应到达

def select_api(
    task_type: str,
    pools: dict[str, TaskPool],
    override: str | None = None,
) -> str:
    """从任务候选池中选择 API：用户指定 > 加权随机。"""
    if override:
        return override

    pool = resolve_pool(task_type, pools)
    return weighted_select(pool.entries)
```

### 为什么不自动路由

opensquilla 的 SquillaRouter 目标是**省成本**——把琐碎问题路由到便宜模型。这是单个 provider 内部的升降级逻辑。wings 让用户自己选择，而不是用 ML 替用户做决定：

| | opensquilla | wings |
|---|---|---|
| 路由目标 | 省成本 | 用户发现和培育 |
| 决策者 | ONNX 模型 | 用户 |
| 模型关系 | 好 ↔ 差 (同 provider) | 不同擅长领域 (跨 provider) |
| 复杂度 | 高 (ML + 后处理链) | 低 (加权随机 + 用户配置) |
| 核心差异 | 自动化 | 用户主导

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
