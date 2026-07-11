# OpenSquilla Subagent 系统

## 架构概述

Subagent 是**独立的 session**（`agent:<id>:subagent:<run_id>`），通过 `sessions_spawn` tool 创建，在 `TaskRuntime` 中以 `run_kind="subagent"` 运行。**始终异步**，parent 通过 `sessions_yield` 等待完成。

## 两层架构

### Durable Agents（持久化 Agent）

配置文件定义的命名运行时 profile：

```python
class AgentEntryConfig(BaseModel):
    id: str            # e.g. "research", "main"
    name: str | None
    description: str | None
    model: str | None
    workspace: str | None
    agent_dir: str | None
    tools: dict | list[str] | str | None
    enabled: bool = True
    system_prompt: str | None
    subagents: AgentSubagentDefaults | None
```

`main` agent 始终存在且不可删除。

### Subagents（运行时子会话）

通过 `sessions_spawn` tool 创建的隔离 child session。可以沿用当前 agent 身份，也可以指定不同的 `agent_id` 使用其他 agent 配置。

### AgentSubagentDefaults

```python
class AgentSubagentDefaults(BaseModel):
    model: str | None                    # 默认模型
    max_children_per_session: int | None # 并发上限
    allow_agents: list[str] | None       # 允许 spawn 的目标 agent 列表
    cascade_on_parent_kill: bool = True  # 父进程 kill 时级联取消
```

## Agent 生命周期

### 两种执行路径

| | Gateway TaskRuntime（主路径） | In-Process Engine（次路径） |
|---|---|---|
| 触发方式 | LLM 调用 `sessions_spawn` tool | `Agent.spawn_subagent()` 程序化调用 |
| 隔离级别 | 独立 session + transcript | 共享 provider，新 Agent 实例 |
| 并发控制 | TaskRuntime 槽位 + 公平队列 | SubagentManager max_concurrent=5 |

### Gateway TaskRuntime 路径

1. **Spawn**: `sessions_spawn` 解析 target agent_id，检查 spawn depth（`MAX_SPAWN_DEPTH = 3`），检查 per-agent 策略（`allow_agents`, `max_children_per_session`），创建新 session，注入 grounding system message: "You are a subagent. Execute the delegated task faithfully and return a structured result to your parent session."

2. **执行**: `TaskRuntime._execute()` 获取 session 锁，检查 cancel，等待 subagent slot（`_wait_for_subagent_slot`），获取公平队列 slot，运行 turn handler。

3. **完成**: `_mark_terminal` → `_notify_subagent_terminal` → `SubagentCompletionEvent` → `announce_subagent_completion()`:
   - 写 completion 为 system message 到 parent session transcript
   - 发送 WebSocket 事件 `session.event.subagent_completion`
   - 如果 spawn group 全部完成，发送 parent wake message

### sessions_spawn 工具

```python
@tool(name="sessions_spawn", description="Spawn an isolated subagent session...")
async def sessions_spawn(
    agent_id: str | None,  # 目标 agent 配置 ID
    task: str,             # 初始任务
    model: str | None,     # 模型覆盖
) -> dict:                 # { session_key, agent_id, task_id, status="queued", spawn_depth }
```

### sessions_yield 工具

Parent 完成 spawn 后调用，表示 spawn group 关闭。不传 `session_key` 表示等待当前 group 的所有 children。

## 上下文隔离（高度隔离）

- **独立 session/transcript** — 不共享 parent 消息历史
- **仅 task 字符串向下传递** — `spec.extra_context` 字段存在但 gateway 路径不使用
- **Subagent grounding 注入**:
  - Spawn 时: 预置到 task 文本
  - 每 turn 重注入: `inject_subagent_grounding` pipeline step 在 system prompt 中重新注入（跨 compaction 持久）
- **结果回传**:
  - 写为 JSON system message 到 parent transcript（含 session_key, status, task_id, result text）
  - 包裹在 `<untrusted_subagent_result>` 标签中，附安全警告
  - 结果上限 16,000 字符（所有 children 平分），超出截断
- **Workspace 隔离**: subagent 在目标 agent 的 workspace 中运行（可能与 parent 不同）

## 工具访问

### SUBAGENT_TOOL_DENY

```python
SUBAGENT_TOOL_DENY = frozenset({
    "cron",              # 不能调度 cron
    "gateway",           # 不能调用 gateway 管理
    "agents_list",       # 不能列出 agent
    "subagents",         # 不能管理其他 subagent
    "memory_get",        # 不能读取记忆
    "memory_search",     # 不能搜索记忆
    "session_search",    # 不能搜索 session
    "message",           # 不能发送消息
    "publish_artifact",  # 不能发布 artifact
})
```

CRON_AGENT_ALLOW 更严格 — 仅允许只读/可观测性工具。

## 模型选择

优先级:
1. 显式 `model` 参数（LLM 可指定）
2. 目标 agent 的 `AgentSubagentDefaults.model`
3. Caller agent 的 model（继承 parent）

In-process 路径中，child 共享 parent 的 provider，但可指定不同的 model_id。

## 并发

- `max_concurrency` 默认 4, `subagent_reserved_slots` 默认 2（防止 parent 饥饿）
- `_wait_for_subagent_slot`: 直到有 `reserved_slots + 1` 空闲容量
- `_acquire_fair_slot`: per-agent 轮询公平队列
- `SubagentManager`: max_concurrent=5, max_depth=3
- `AgentSubagentDefaults.max_children_per_session`: per-parent 并发上限
- Subagent 始终作为后台 `asyncio.Task` 运行
- Parent 调用 `sessions_yield` 等待，completion 异步推送

## 权限模型

- 继承 parent 的 tool handler，但使用独立的 `ToolContext`:
  - `caller_kind = CallerKind.SUBAGENT`
  - `interaction_mode = InteractionMode.UNATTENDED`（无操作员审批）
  - `is_owner = True`
  - `denied_tools = set(SUBAGENT_TOOL_DENY)`
- UNATTENDED 模式下，任何需要交互审批的工具都会失败
- `cascade_on_parent_kill = True`: 杀死 parent 级联取消子 subagent

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/opensquilla/engine/subagent.py` | SubagentManager, SubagentSpec, SubagentHandle |
| `src/opensquilla/engine/agent.py` | Agent._make_child_agent, spawn_subagent |
| `src/opensquilla/tools/builtin/sessions.py` | sessions_spawn, sessions_yield 工具 |
| `src/opensquilla/tools/builtin/agents.py` | subagents 管理工具 |
| `src/opensquilla/gateway/task_runtime.py` | TaskRuntime subagent 执行、槽位预留、公平队列 |
| `src/opensquilla/gateway/subagent_announce.py` | 完成通知、spawn group 追踪、parent wake 格式化 |
| `src/opensquilla/gateway/background_completion.py` | BackgroundCompletionManager |
| `src/opensquilla/agents/registry.py` | AgentRegistry CRUD |
| `src/opensquilla/agents/limits.py` | MAX_SPAWN_DEPTH = 3 |
| `src/opensquilla/tools/types.py` | SUBAGENT_TOOL_DENY, CRON_AGENT_ALLOW, CallerKind |
| `src/opensquilla/gateway/config.py` | AgentEntryConfig, AgentSubagentDefaults |
| `src/opensquilla/session/keys.py` | build_subagent_session_key, is_subagent_key |
| `src/opensquilla/engine/steps/inject_subagent_grounding.py` | 每 turn 重注入 subagent grounding |
