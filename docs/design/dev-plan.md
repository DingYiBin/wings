# 开发计划 — Token Budget + Compaction + 代码质量

> 创建: 2026-07-06
> 状态: 进行中

## 背景

用户实测发现 token_budget 集成是必须的。当前 `src/wings/query/token_budget.py` 有完整的 `TokenBudget` 类（4 字符/token 估算、`needs_compact()` 80% 阈值），但**完全没接入** AgentLoop 或 API 调用，也没有 compaction 服务。

## 阶段 1: Token Budget 集成

**目标**: AgentLoop 每次 API call 前检查 context 用量,超阈值触发 compaction。

### 1.1 ProviderConfig 加 context_window

`src/wings/config/settings.py` — `ProviderConfig` 加字段:
```python
context_window: int = 200_000  # 默认现代模型上下文窗口
```

### 1.2 ModelConfig 传递 context_window

`src/wings/models/protocol.py` — `ModelConfig` 加字段:
```python
context_window: int = 200_000
```

`src/wings/cli/bootstrap.py` — 注册 provider 时把 `context_window` 从 ProviderConfig 传到 ModelConfig。

### 1.3 AgentLoop 集成 TokenBudget

`src/wings/agent/loop.py` — `run()` 的 while 循环顶部:
```python
# 构建 TokenBudget (从当前 model 的 config)
budget = TokenBudget(
    context_window=cfg.context_window,
    system_prompt_tokens=len(context.system_prompt) // 4,
)
if budget.needs_compact(self._messages):
    await self._compact_messages(context)
```

### 1.4 大 tool result 截断

在 AgentLoop 收集 tool_results 时,单个 result 超过阈值(如 20K 字符)则截断:
```python
MAX_TOOL_RESULT_CHARS = 20_000
if len(tool_result.output) > MAX_TOOL_RESULT_CHARS:
    output = tool_result.output[:MAX_TOOL_RESULT_CHARS] + f"\n... [truncated, {len(tool_result.output)} total chars]"
```

## 阶段 2: Compaction 服务

**目标**: `needs_compact()` 返回 True 时,摘要历史消息,释放 context。

### 2.1 新建 `src/wings/services/compact.py`

```python
COMPACT_PROMPT = """\
Review the conversation history below and produce a concise summary
that preserves all information needed to continue the task:

- User's original request and goals
- Key decisions made
- Files read/modified (with paths)
- Tool results that informed decisions
- Current progress and pending steps
- Any errors or blockers encountered

Be specific about file paths, function names, and technical details.
Do not include full file contents — reference them by path.
"""

async def compact_messages(
    messages: list[Message],
    *,
    query_engine: QueryEngine,
    model: str,
    config: ModelConfig,
    keep_recent: int = 4,  # 保留最近 N 条消息不摘要
) -> list[Message]:
    """Compact message history by summarizing older messages.

    Returns new message list: [system_prompt, summary_message, *recent_messages]
    """
```

### 2.2 摘要流程

1. 分离 system_prompt（第一条 system 消息）+ 最近 N 条消息（保留原文）
2. 中间消息拼成文本,作为 compact prompt 的输入
3. 调用模型生成摘要
4. 重组: `[system_prompt, UserMessage("## Conversation summary\n\n{summary}"), *recent_messages]`

### 2.3 AgentLoop 调用 compaction

`src/wings/agent/loop.py` — 添加 `_compact_messages()` 方法:
```python
async def _compact_messages(self, context: AgentContext) -> None:
    self._messages = await compact_messages(
        self._messages,
        query_engine=self._query_engine,
        model=self._select_model(context),
        config=self._model_registry.build_config(self._select_model(context)),
    )
    if self._logger:
        self._logger.record_cycle(model="compact", context="compact", ...)
```

## 阶段 3: 代码质量

### 3.1 hooks 单元测试
`tests/test_hooks.py`:
- PreToolUse exit code 2 → block
- PreToolUse stdout JSON override → allow
- PostToolUse 执行确认
- timeout 行为

### 3.2 mcp 单元测试
`tests/test_mcp.py`:
- MCPServerConfig 解析
- tool schema 转换
- _McpToolAdapter 调用 (mock stdio)

### 3.3 bare except 改进
非 web 模块（agent/loop, query/engine, mcp/loader）的 `except Exception` 加 `logging.warning()`。

## 阶段 4: 功能增强 (低优先级)

- web_search `allowed_domains` / `blocked_domains`
- web_fetch 预批准域名列表
- 更多内置 skills
- Plugin 系统

## 验证标准

- [ ] `uv run pytest tests/ -q` 全过
- [ ] `uv run mypy src/` 无新错误
- [ ] `uv run ruff check src/ tests/` 无新错误
- [ ] 手动测试: 长对话触发 compaction, 摘要后能继续正常工作
