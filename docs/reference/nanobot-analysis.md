# nanobot 参考分析

> 分析日期: 2026-07-20
> 仓库: https://github.com/HKUDS/nanobot

## 项目概况

nanobot 是一个 Python 开源超轻量个人 AI Agent，设计哲学是"核心轻量但实用"。支持 WebUI、16+ 聊天频道、MCP、记忆、模型路由、定时任务和 Render 一键部署。

技术栈：Python 3.11+ / Typer / Rich / asyncio / WebSocket / React 18 / Vite / hatchling / MIT

## 值得参考的功能

### 1. 极简 MessageBus（50 行）

仅 50 行的异步双队列（inbound/outbound asyncio.Queue）完美解耦通信层和 Agent 核心。新增 Channel 无需改动核心代码。

**对 wings 的价值**：wings 的模块间通信可以参考这种极简队列设计，避免过度架构。

### 2. 状态机驱动的 AgentLoop

显式状态转换表（TurnState 枚举，8 个状态）：`RESTORE → COMPACT → COMMAND → BUILD → RUN → SAVE → RESPOND → DONE`。每个状态一个 handler 方法，比深嵌套 if-else 更容易理解和测试。

支持并发请求限制（`NANOBOT_MAX_CONCURRENT_REQUESTS`，默认 3）。每会话异步锁（`_session_locks`）保证同会话串行但跨会话并发。

**对 wings 的价值**：显式状态机模式比 wings 当前的 AgentLoop 协程更结构化。每会话异步锁 + 全局并发信号量的设计也很实用。

### 3. 二阶段 Dream 记忆系统

两层记忆：
- **MemoryStore**：纯文件 I/O，`MEMORY.md` 长期记忆 + `history.jsonl` 交互历史 + `SOUL.md`/`USER.md` 身份定义
- **Dream 记忆巩固**：定期（每 2 小时）由 Cron 触发，LLM 直接编辑 `MEMORY.md`/`SOUL.md`/`USER.md`，差异检查（git diff）防止幻觉编辑，自动 commit
- **Consolidator**：Token-budget 驱动的渐进式上下文压缩，在用户 turn 边界安全切分

**对 wings 的价值**：wings 也有 memory 和 dream 系统，但 nanobot 的二阶段设计（巩固 + 压缩）和 git diff 幻觉防护值得参考。

### 4. pkgutil 自动发现

工具和 Channel 插件通过 `pkgutil.walk_packages` 自动发现，注册表零配置。新增工具只需在 `tools/` 目录下放文件即可。

**对 wings 的价值**：零配置的工具发现机制对降低新增工具的门槛很有帮助。

### 5. Provider 退路链（FallbackProvider）

主 Provider 失败时自动切换到备用模型。签名检测触发配置更新时无缝迁移。50+ 内置 Provider 预定义。

**对 wings 的价值**：退路链机制值得参考，增强 wings 的多 provider 可靠性。

### 6. 工具并发安全标记

`concurrency_safe` 属性声明哪些工具可以并行执行，哪些必须串行（如文件写入）。

**对 wings 的价值**：与 deepseek-tui 的 RwLock 模式类似但更简单。TypeScript 中可以直接用标记位 + 执行器调度实现。

### 7. Docker 多阶段构建 + 非 root + bubblewrap

完整的生产级安全部署方案：Docker 多阶段构建，非 root 用户运行，可选 bubblewrap 沙箱。Render 一键部署。

**对 wings 的价值**：容器化部署的安全最佳实践参考。

### 8. OpenAI 兼容 API

通过 `/v1/chat/completions` 和 `/v1/models` 端点暴露 Agent 能力，使其他工具可以通过标准 API 调用 nanobot。

**对 wings 的价值**：将 Agent 暴露为 API 的模式对集成和扩展很有价值。

### 9. Checkpoint 恢复

`/stop` 中断后下次可恢复部分上下文。工具执行完成后持久化中间结果到 session metadata。

**对 wings 的价值**：中断恢复的体验设计参考。

## 不建议参考的部分

| 功能 | 原因 |
|------|------|
| 16 个聊天频道 | wings 是 CLI 工具 |
| WebUI React SPA | wings 没有 web UI 需求 |
| CLI Apps 集成 | 超出 wings 范围 |
| 语音转录 | 超出终端 Agent 范围 |

## 优先级建议

1. **高优先**: 显式状态机 AgentLoop — 重构 wings 的 Agent 循环
2. **高优先**: 每会话异步锁 + 全局并发控制
3. **中优先**: 工具并发安全标记机制
4. **中优先**: Dream 记忆的幻觉防护（git diff 检查）
5. **低优先**: Provider 退路链增强
6. **低优先**: OpenAI 兼容 API 暴露
