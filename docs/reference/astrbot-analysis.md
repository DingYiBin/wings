# AstrBot 参考分析

> 分析日期: 2026-07-20
> 仓库: https://github.com/AstrBotDevs/AstrBot (v4.26.7)

## 项目概况

AstrBot 是一个 Python 开源一站式 Agent 聊天平台，支持 QQ、企业微信、飞书、钉钉、Telegram、Slack 等 18 个 IM 平台。核心是基于 9 阶段 Pipeline 的消息处理架构。

技术栈：Python 3.12+ / FastAPI / Vue 3 / SQLite / FAISS / AGPL-3.0

## 值得参考的功能

### 1. Pipeline 九阶段责任链

消息处理全生命周期分为 9 个顺序 Stage：WakingCheck → WhitelistCheck → SessionStatusCheck → RateLimit → ContentSafetyCheck → PreProcess → ProcessStage → ResultDecorate → Respond。

每个 Stage 独立继承 `Stage` 基类，通过 `@register_stage` 注册。`PipelineContext` 在所有 Stage 之间传递共享上下文。

**对 wings 的价值**：终端命令处理流程可以设计为类似的 Stage 管道（Auth → Permission → Sanitize → Execute → Format → Output），比当前的硬编码流程更灵活。

### 2. FunctionTool / ToolSet 统一抽象

工具使用统一的 `FunctionTool` 数据类表示（name, description, parameters/JSON Schema, handler）。`ToolSet` 支持 add/remove/get、工具去重（active 优先级）、轻量化 schema 转换。最关键的是 `ToolSet` 可以一键转换为 OpenAI / Anthropic / Google GenAI 三套不同的 function calling schema。

**对 wings 的价值**：目前 wings 的工具 schema 是直接针对 Anthropic 格式的。可以借鉴 ToolSet 的抽象层，解耦工具定义与 Provider 格式。

### 3. Skills 兼容业界标准

直接兼容 OpenAI Codex CLI 和 Anthropic Claude 的 SKILL.md 格式。从本地插件目录加载 Skills，支持激活/停用。Skills 注入到 LLM system prompt 中。

**对 wings 的价值**：wings 已有 SKILL.md 支持，但 AstrBot 的兼容性处理（legacy skill.md → SKILL.md）和沙箱同步机制可参考。

### 4. MCP 安全白名单

MCP 客户端支持 stdio/SSE 传输，stdio 命令有严格的白名单（只允许 python/node/npx/pnpm/uv/uvx 等），禁止 shell/powershell/curl 等危险命令。使用 tenacity 实现指数退避重连。

**对 wings 的价值**：MCP 客户端的安全性控制策略可以直接借鉴。

### 5. 子 Agent Handoff 委托模式

`HandoffTool` 继承自 `FunctionTool`，在主 Agent 的工具列表中注册为 `transfer_to_<agent_name>`。子 Agent 有独立的 instructions、可选的独立 provider、独立的 tools 列表。通过 `SubAgentOrchestrator` 从配置加载子 Agent 定义。

**对 wings 的价值**：子 Agent 作为工具的委托模式比自定义 Agent 图更简单。每个子 Agent 独立 persona + provider 的架构值得参考。

### 6. Provider 热切换

`ProviderManager` 管理多个 Provider 实例，支持热切换和回调通知。40+ 个 Provider Source 实现。支持 chat completion、STT、TTS、Embedding、Rerank 等多种能力类型。

**对 wings 的价值**：多 LLM Provider 的 fallback 机制和热切换设计值得参考。

### 7. 上下文压缩

当上下文超过限制时，使用 LLM 自动压缩历史对话为摘要；也支持按轮次截断旧消息。有 Token 估算器预估当前上下文的 token 数。

**对 wings 的价值**：两种上下文管理策略（自动压缩 vs 截断）的组合使用方式可参考。

## 不建议参考的部分

| 功能 | 原因 |
|------|------|
| 18 个 IM 平台适配器 | wings 是 CLI 工具，不需要 IM 集成 |
| Vue 3 Dashboard | wings 没有 web UI 需求 |
| 9 阶段 Pipeline | 过于重量级，wings 需要更精简的版本 |
| 插件热重载 (watchfiles) | 增加复杂度，wings 目前无插件系统 |

## 优先级建议

1. **高优先**: FunctionTool/ToolSet 统一抽象 — 解耦工具定义与 Provider 格式
2. **高优先**: MCP 安全白名单 — 增强 wings 的 MCP 客户端安全性
3. **中优先**: Skills 兼容性增强 — SKILL.md 兼容处理
4. **中优先**: 上下文压缩策略 — LLM 摘要 vs 截断的组合
5. **低优先**: 子 Agent Handoff — 可等子 Agent 系统成熟后再参考
