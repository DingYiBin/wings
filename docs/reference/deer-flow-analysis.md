# DeerFlow 参考分析

> 分析日期: 2026-07-11
> 仓库: https://github.com/bytedance/deer-flow (v2.0)

## 项目概况

DeerFlow 是字节跳动开源的 **super agent harness**，基于 LangGraph 构建。后端 Python，前端 Next.js。通过编排子代理、记忆和沙箱来执行复杂任务，以可扩展 skills 为核心。

技术栈：Python 3.12+ / Node.js 22+ / LangGraph / FastAPI / Next.js / Docker

## 值得参考的功能

### 1. Session Goals（会话目标）

每个 session 都有一个明确的目标声明，agent 带着目标执行任务。启动时可以传入 `--goal "分析这个项目的架构"`，agent 会在执行中牢记目标并主动对齐。

**对 wings 的价值**：目前我们的 session 只有用户输入的原始 prompt，没有结构化的目标。可以增加 `--goal` 参数，将目标注入 system prompt，加上目标达成检测。

### 2. Manual Context Compaction（手动压缩上下文）

用户可以通过命令主动触发上下文压缩（类似 claude-code 的 `/compact`），不需要等自动压缩触发。压缩策略可以手动选择（摘要 vs 截断）。

**对 wings 的价值**：我们目前只有自动压缩（token budget > 80% 触发）。增加 `/compact` 命令让用户手动控制。

### 3. Sandbox / File System（沙箱执行）

DeerFlow 支持 Docker-based 沙箱模式，所有 bash 命令在隔离容器中执行。有本地进程模式和 K8s provisioner 模式。

**对 wings 的价值**：我们目前 bash 工具直接在当前环境执行，无隔离。可以考虑可选的 Docker 沙箱模式。

### 4. MCP Server 模式

DeerFlow 可以作为一个 MCP server 暴露给其他 agent（如 Claude Code）。

**对 wings 的价值**：wings 也可以作为 MCP server，让其他 agent 通过 MCP 协议调用 wings 的工具。这是我们 MCP 模块的升级方向。

### 5. Context Engineering（上下文工程）

DeerFlow 根据用户角色、场景、任务类型动态组装 system prompt。包括：
- 角色特定的指令
- 工具使用约束
- 输出格式规则
- 记忆内容的优先级排序

**对 wings 的价值**：我们目前是固定的 system prompt + skills + memory。可以参考上下文工程模式做动态 prompt 组装。

### 6. Skills 元数据系统

DeerFlow 的 skills 有丰富的元数据：
```yaml
name: podcast-generation
version: 1.0.0
description: Generate podcast scripts
dependencies: [ffmpeg]
tools: [bash, write]
timeout: 300
```

**对 wings 的价值**：我们的 SKILL.md 目前只有基础字段（name, description, user-invocable）。可以增加 version, dependencies, tools, timeout 等字段。

### 7. TUI（Terminal Workbench）

DeerFlow 使用 Python Textual 库实现 TUI。这是他们 2.0 的新功能。

**对 wings 的价值**：我们已有 Ink v7 React TUI。Textual 是 Python 的，不能直接用，但 TUI 的交互模式可以参考。

### 8. Scheduled Tasks（定时任务）

用户可以设置定时触发的 agent 任务（类似 cron）。

**对 wings 的价值**：可以加 `/schedule` 命令 + 后台定时器，实现定时执行任务。

## 不建议参考的部分

| 功能 | 原因 |
|------|------|
| Docker 部署 | wings 是 CLI 工具，不需要 docker |
| IM 频道集成 | wings 定位是 CLI，不是 chatbot 服务 |
| Web 前端 | wings 没有 web UI 需求 |
| LangGraph 架构 | wings 的 agent loop 更简单直接 |

## 优先级建议

1. **高优先**: Manual compaction (`/compact`) — 改动小，价值大
2. **高优先**: Session goals (`--goal`) — 提升 agent 效果
3. **中优先**: Skills 元数据增强 — 为复杂 skills 做准备
4. **低优先**: MCP server 模式 — 需要重新设计 MCP 模块
5. **低优先**: Sandbox — 增加部署复杂度
6. **低优先**: Scheduled tasks — 需要后台进程管理
