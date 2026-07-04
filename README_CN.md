# Wings

多模型聚合 Agent 系统 —— 接入各家模型 API，每种任务类型拥有独立的 API 候选池。用户通过打分和配置塑造各任务使用的模型组合。每个模型都是一只翅膀。

## 设计理念

**API 候选池** — wings 的核心差异点。每次模型调用都从当前任务的 API 候选池中加权随机选择一个 API。用户通过打分和设置调整各任务类型的候选池（调高/调低权重、从池中移除等），而不是由系统猜测"应该用哪个模型"。新 API 默认加入所有任务池，用户可设置只加入某些任务的池。

**一切皆工具**。文件读写、shell 执行、搜索、子 agent 调用——都实现统一的 `Tool` 协议，经过同一条权限管道。

**协议驱动边界**。模块间依赖 Protocol 而非具体类。`ModelSelector`、`ModelProvider`、`Tool`、`HookRunner`——换实现不动调用方。

## 当前状态

9 个阶段完成，184 个测试，约 3100 行代码。端到端数据通路已打通：用户输入 → 消息组装 → 池选模型 → Provider API 调用 → 工具执行 → 响应输出。可以用真实 API key 进行基础测试。

| 阶段 | 模块 | 状态 | 说明 |
|------|------|------|------|
| 1 | messages | ✅ | 内部消息类型 + Anthropic/OpenAI 双向转换 |
| 1b | routing | ✅ | API 候选池管理器（19 种任务类型，加权随机） |
| 2 | models | ✅ | Anthropic + OpenAI 适配器（chat/stream） |
| 3 | tools | ✅ | 6 个内置工具：read/write/edit/bash/glob/grep |
| 4 | query | ✅ | 查询引擎（指数退避重试、token 预算） |
| 5 | permissions | ✅ | 4 阶段权限管道 |
| 6a | agent/core | ✅ | 主循环 + 模型转交检测 |
| 7 | config | ✅ | TOML + 环境变量分层配置 |
| 8 | cli | ✅ | `wings run` / `wings chat` + bootstrap wiring |

## 安装

需要 Python 3.12+ 和 [uv](https://docs.astral.sh/uv/)：

```bash
git clone https://github.com/opensquilla/wings.git
cd wings
uv pip install -e .
```

安装开发依赖：

```bash
uv pip install -e ".[dev]"
```

## 配置

### API Key

创建 `~/.wings/config.toml`：

```toml
# Anthropic (Claude 系列)
[llm.anthropic]
provider = "anthropic"
model = "claude-sonnet-4-6"
api_key = "sk-ant-api03-..."

# OpenAI (GPT / o-series)
[llm.openai]
provider = "openai"
model = "gpt-4o"
api_key = "sk-..."
```

也可以用环境变量（优先级高于配置文件）：

```bash
export WINGS_LLM__ANTHROPIC__API_KEY="sk-ant-api03-..."
export WINGS_LLM__OPENAI__API_KEY="sk-..."
```

### API 候选池（可选）

为不同任务类型定制模型偏好：

```toml
[routing]
default_weight = 1.0

# 主对话：偏好 Claude Opus
[[routing.pools.main]]
api_id = "anthropic/claude-opus-4-6"
weight = 2.0

[[routing.pools.main]]
api_id = "openai/gpt-4o"
weight = 1.0

# 子 agent：偏好快速便宜的模型
[[routing.pools.subagent]]
api_id = "anthropic/claude-haiku-4-5"
weight = 3.0

[[routing.pools.subagent]]
api_id = "openai/o4-mini"
weight = 1.0
```

不配置池时，所有已注册 API 等权重参与选择。

### 项目配置

在项目根目录放置 `wings.toml`：

```toml
# 始终允许这些工具（不询问）
allowed_tools = ["read", "glob", "grep"]

# 禁止这些工具
denied_tools = ["rm"]

# 项目级模型覆盖
model = "anthropic/claude-opus-4-6"

# 追加到 system prompt
personality = "简洁、直接的回答风格。"
```

## 使用

### 单次运行

```bash
wings run "这个项目的 README 说了什么？"
wings run --model anthropic/claude-opus-4-6 "解释架构设计"
wings run --dir /path/to/project "列出所有 Python 文件"
```

### 交互模式

```bash
wings chat
```

输入 `/exit` 退出，Ctrl+C 中断。

### 运行测试

```bash
pytest tests/ -v
# 184 passed
```

## 架构

```
src/wings/
├── cli/            # Typer 入口 + bootstrap 组合根
├── agent/          # AgentLoop、HandoffDetector、TurnRecord
├── query/          # QueryEngine（重试）+ TokenBudget
├── tools/          # Tool 协议、注册表、6 个内置工具
├── permissions/    # 4 阶段权限管道
├── models/         # Anthropic + OpenAI 适配器、ModelRegistry、能力目录
├── routing/        # API 候选池管理器 + ModelSelector Protocol
├── messages/       # 内部消息类型 + provider 格式转换
└── config/         # 分层配置（env > wings.toml > ~/.wings/config.toml）
```

模块依赖顺序：messages/routing（无依赖）→ models（依赖 messages + routing）→ tools（无依赖）→ query（依赖 models + messages + tools）→ permissions（依赖 tools）→ agent（依赖全部）→ config（依赖 routing）→ cli（依赖全部）。

## 设计文档

- [`docs/design/architecture.md`](docs/design/architecture.md) — 架构总览与设计决策
- [`docs/design/modules.md`](docs/design/modules.md) — 详细模块设计 + 实施计划 + 开发反思
- [`docs/reference/`](docs/reference/) — claude-code 和 opensquilla 代码仓分析

## 参考项目

| 项目 | 语言 | 参考点 |
|------|------|--------|
| [claude-code](https://github.com/anthropics/claude-code) | TypeScript | Tool/Command 接口、权限管道、agent 类型 |
| [opensquilla](https://github.com/opensquilla/opensquilla) | Python | Protocol 驱动 DI、StageOutcome、@tool 装饰器、Dream 系统 |
