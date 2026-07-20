# Crush 参考分析

> 分析日期: 2026-07-20
> 仓库: https://github.com/charmbracelet/crush

## 项目概况

Crush 是 Charmbracelet 出品的终端 AI 编码助手，Go 语言编写。使用 Bubble Tea v2 TUI 框架 + `charm.land/fantasy` LLM 抽象层。支持 16+ LLM 提供商、LSP 集成、MCP、多会话管理、Hook 系统。

技术栈：Go 1.26.5 / Bubble Tea v2 / Lipgloss / Glamour / SQLite (sqlc) / Cobra CLI

## 值得参考的功能

### 1. LSP 集成作为上下文源

Crush 最独特的特性：通过 LSP 获取代码智能上下文。内置 7 个 LSP 工具（lsp_definition, lsp_symbols, lsp_call_hierarchy, lsp_rename 等）。`Manager` 采用懒加载策略，按需启动 LSP 客户端，30 秒不可用冷却。

**对 wings 的价值**：对 TypeScript 生态可用 `vscode-languageserver` 相关库实现。LSP 诊断/符号/定义信息能显著提升代码理解质量。

### 2. 多 Agent 协调 (Coordinator)

`Coordinator` 管理两个命名 Agent："coder"（主力编码 Agent）和"task"（轻量摘要/子任务 Agent）。分别使用 large 和 small 两种模型。

**对 wings 的价值**：设计 `AgentCoordinator` 类支持主 Agent + 子 Agent 模式，大型模型做核心编码，小型模型做摘要/标题生成，可以显著降低成本。

### 3. 会话中切换模型

可在对话过程中切换模型而不丢失上下文。Session 对象持有 provider 引用，替换时保持 messages 数组。

**对 wings 的价值**：wings 目前不支持中途换模型，这个功能对用户很有价值。

### 4. Hook 引擎

`PreToolUse` hook 在工具执行前运行用户自定义 Shell 命令：
- Decision 机制：Allow / Deny / None
- Halt 能力：exit code 49 可中止整个 turn
- Input 重写：hook 可修改工具输入参数
- 去重：按命令字符串去重
- 并行执行：所有匹配 hook 并发运行

**对 wings 的价值**：exit code 语义（2=阻止工具，49=中止整个 turn）是一个简洁而强大的约定。

### 5. 权限分层系统

权限检查链路：Hook 预批准 > YOLO 模式 > 允许列表 > 会话持久授权 > 单次授权。`GrantPersistent` 支持 per-session 持久授权。

**对 wings 的价值**：设计 `PermissionChain`，每层可短路。参考 Crush 的权限分层模式。

### 6. 工具自文档化

每个 `.go` 文件对应一个 `.md` 或 `.md.tpl` 描述文件，通过 Go template 渲染，注入运行时信息（可用命令、模型 ID 等）。

**对 wings 的价值**：TypeScript 实现：`.ts` + `.md` 配对，用模板引擎渲染。

### 7. Client/Server 架构

支持 TUI 单机模式和 Client/Server 模式（Unix socket / Windows named pipe / TCP）。多个客户端可共享同一 workspace。

**对 wings 的价值**：与 wings 当前的纯 CLI 模式不同，但 client/server 模式对 headless 场景有价值。

### 8. Bash 工具的安全设计

内置命令黑名单：阻止 alias, aria2c, curl, wget, nc, telnet, ssh, kill, reboot, shutdown, rm 等高风险命令。使用 `mvdan.cc/sh` 提供 POSIX 兼容执行环境。

**对 wings 的价值**：bash 工具的安全设计和黑名单机制可参考。

### 9. Pub/Sub 解耦

泛型发布/订阅系统用于组件间解耦通信：会话变更→UI 更新、消息变更→SSE 推送、权限请求→UI 权限弹窗等。

**对 wings 的价值**：使用 EventEmitter 或 RxJS Subject 模式实现类似解耦。

## 不建议参考的部分

| 功能 | 原因 |
|------|------|
| Go 语言特定实现 | wings 是 TypeScript，无法直接复用 |
| Bubble Tea TUI | wings 使用 Ink React TUI |
| sourcegraph 搜索 | 超出 wings 范围 |
| 跨平台 Shell (mvdan.cc/sh) | TypeScript 用 node:child_process |

## 优先级建议

1. **高优先**: 权限分层系统 — 重构 wings 的权限模型
2. **高优先**: LSP 集成 — 极大提升代码理解能力
3. **中优先**: Hook 引擎增强 — exit code 语义约定
4. **中优先**: 会话中切换模型 — 用户痛点功能
5. **中优先**: Bash 工具安全黑名单 — 安全加固
6. **低优先**: Pub/Sub 解耦 — 可等架构演进时引入
