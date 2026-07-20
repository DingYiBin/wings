# CodeWhale（原 deepseek-tui）参考分析

> 分析日期: 2026-07-20
> 仓库: https://github.com/Hmbown/DeepSeek-TUI → CodeWhale

## 项目概况

CodeWhale 是 Rust 编写的终端 AI 编码助手，原为 deepseek-tui，现已支持 35+ LLM 提供商。18 个 Crate 的 Cargo workspace，核心是事件驱动的 Engine + TUI（ratatui）架构。具有 Plan/Act/Operate 三模式、沙箱执行、Fleet 持久化 worker、WorkGraph 工作流编排。

技术栈：Rust 2024 / Tokio / ratatui / reqwest / serde / SQLite (rusqlite) / clap / rquickjs

## 值得参考的功能

### 1. Plan / Act / Operate 三模式

```
Plan    → 只读：read/search/diagnostic 工具可用，shell/patch 不可用
Act     → 标准多步骤工具使用（默认模式）
Operate → 多任务指挥，可同时发起多个 worker
```

通过 Tab 键循环切换。Plan 模式用于"大声思考"制定可审阅的计划，Act 模式用于标准执行，Operate 模式用于并行任务。

**对 wings 的价值**：交互模式分层的 UX 设计理念。TypeScript 中可以用策略模式实现类似的三态设计。

### 2. 分层审批引擎

三层权限规则集：`BuiltinDefault → Agent → User`，Deny > Ask > Allow 优先级。审批姿势（`ApprovalMode`）通过 Shift+Tab 循环切换：
- `Suggest`：默认，对非安全工具拦截提示
- `Auto`：完全自主，永不弹出用户问题
- `Bypass`：绕过审批（YOLO 模式）
- `Never`：从不执行需要审批的工具

**对 wings 的价值**：`PermissionChain` 分层模式和审批姿势的 UX 设计非常成熟，TypeScript 可直接实现。

### 3. Fleet / Worker 持久化

只追加账本（`.codewhale/fleet.jsonl`）+ 基于 `codewhale exec` 的子进程 worker 模式。支持 `fleet resume` 从断点继续。每个 worker 是独立的子进程隔离。

**对 wings 的价值**：轻量级可恢复的后台任务方案，不需引入重量级消息队列。

### 4. 多平台沙箱

```
macOS   → Seatbelt (sandbox-exec)
Linux   → Landlock (内核 5.13+) + seccomp + bubblewrap
Windows → 进程树隔离 (Job Object)
```

沙箱策略：`DangerFullAccess` / `ReadOnly` / `WorkspaceWrite` / `ExternalSandbox`。Constitution 文件编译为不可跳过的写入拦截规则。

**对 wings 的价值**：Linux 下 Landlock + seccomp 的组合方案是终端 Agent 最轻量的沙箱方案。

### 5. 路由层设计

`ModelRegistry` 管理 100+ 内置模型条目和丰富别名系统（如 `deepseek-chat` -> `deepseek-v4-flash`）。支持多 provider 同名模型路由。路由解析器提供准确的价格/上下文预算信息——价格未知时显示"unknown"而不是假标 $0。

**对 wings 的价值**：模型别名和路由解析策略对 wings 的多 provider 支持非常关键。

### 6. WorkGraph 工作流编排

结构化多步骤工作流的数据模型，支持有序的阶段、门控、共享预算和确定性扇入。配合 QuickJS 脚本层（`rquickjs`）实现可编程工作流。

**对 wings 的价值**：比简单的"链式调用"更强大的结构化编排方案。

### 7. Op/Event 分离架构

引擎采用 Op（操作）→ Event（事件）分离：Op 从 UI 发送到引擎（SendMessage, ContinueGoal, Cancel），Event 从引擎向 UI 通知（ResponseStart, ResponseDelta, TurnComplete）。Op 携带完整的每次 turn 上下文。

**对 wings 的价值**：清晰的命令查询分离模式，适合复杂的 Agent UI 交互。

### 8. Hook 系统

支持四种 Sink 类型：Stdout / JSONL / Webhook / Unix Socket。事件类型包括 ResponseStart, ResponseDelta, ToolLifecycle, ApprovalLifecycle 等。

**对 wings 的价值**：可观测性 hook 的事件类型定义和 sink 抽象值得参考。

### 9. ToolRegistry + ToolHandler trait

统一工具注册/调度/并发控制。`ToolCallRuntime` 使用 `RwLock`：并行安全工具获取读锁（可重叠），串行工具获取写锁（互斥）。通过 `tokio::task_local!` 检测重入调用。

**对 wings 的价值**：工具并发控制的读写锁模式可以直接参考实现。

## 不建议参考的部分

| 功能 | 原因 |
|------|------|
| Rust 特定实现 | wings 是 TypeScript，无法直接复用 |
| QuickJS 工作流脚本 | 引入额外 VM 过于复杂 |
| ratatui TUI | wings 使用 Ink React TUI |
| 语音 (ASR/TTS) | 超出终端 Agent 范围 |

## 优先级建议

1. **高优先**: Plan/Act/Operate 三模式 — 极大的 UX 改进
2. **高优先**: 分层审批引擎 — 重构 wings 的权限模型
3. **中优先**: Op/Event 分离架构 — 改进 wings 的引擎设计
4. **中优先**: 工具并发控制读写锁模式
5. **中优先**: 路由层别名系统 — 增强 multi-provider 支持
6. **低优先**: Fleet/Worker 持久化
7. **低优先**: Landlock/seccomp 沙箱
