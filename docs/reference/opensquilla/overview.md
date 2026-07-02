# OpenSquilla — 项目概述

## 是什么

OpenSquilla (v0.4.1) 是一个 **token 高效、微内核架构的 AI agent 运行时**，用 Python (3.12+) 编写，Apache 2.0 协议。提供统一的 turn loop，支持多种入口：Web UI (Vue 3)、CLI (Typer/Rich)、9 个聊天频道适配器 (Slack, Discord, Telegram, 飞书, 钉钉, 企业微信, QQ, Matrix, Microsoft Teams)。

核心创新是 **SquillaRouter** — 一个设备端模型路由器，使用 ONNX + LightGBM 将每个 turn 发送到能处理它的最便宜模型。

## 核心能力

- 持久化长期记忆，混合搜索 (语义向量 + FTS5 词法)
- 丰富的技能系统：67 个内置技能 + 社区技能中心
- Meta-skills: 基于 DAG 的多步子 agent 编排
- 分层沙箱：bubblewrap (Linux) + seatbelt (macOS)
- 内置网络搜索 (DuckDuckGo, Brave, Tavily, Exa, Bocha)
- MCP 协议支持 (客户端和服务端)
- Job 调度/cron 引擎
- 使用量跟踪、成本汇总、诊断

## 顶层目录结构

| 目录 | 用途 |
|------|------|
| `src/opensquilla/agents/` | Agent 身份、作用域、限制、注册表 |
| `src/opensquilla/application/` | 审批队列、意图缓存、向导 |
| `src/opensquilla/channels/` | 9 个聊天频道适配器 |
| `src/opensquilla/chat/` | 聊天模型 (对话、历史、来源) |
| `src/opensquilla/cli/` | Typer CLI (主入口、子命令、REPL、聊天、TUI) |
| `src/opensquilla/engine/` | 核心 agent 状态机和 turn runner |
| `src/opensquilla/gateway/` | Starlette ASGI 网关服务器 |
| `src/opensquilla/memory/` | 持久化记忆子系统 |
| `src/opensquilla/mcp/` | MCP 客户端 |
| `src/opensquilla/mcp_server/` | MCP 服务端 |
| `src/opensquilla/observability/` | 决策日志、traces、prompt 报告 |
| `src/opensquilla/plugins/` | 插件系统 |
| `src/opensquilla/provider/` | LLM provider 抽象层 |
| `src/opensquilla/safety/` | 沙箱策略、工具分级、注入防护 |
| `src/opensquilla/sandbox/` | 代码执行沙箱 |
| `src/opensquilla/scheduler/` | Cron/调度引擎 |
| `src/opensquilla/search/` | 网络搜索 providers |
| `src/opensquilla/session/` | 会话管理、压缩、成本汇总 |
| `src/opensquilla/skills/` | 技能系统 |
| `src/opensquilla/squilla_router/` | 设备端模型路由器 |
| `src/opensquilla/tools/` | 工具注册表和内置工具 |
| `opensquilla-webui/` | Vue 3 + Vite 前端 |
| `desktop/electron/` | Electron 桌面壳 |
| `tests/` | 全面测试套件 (~100+ 测试文件) |
