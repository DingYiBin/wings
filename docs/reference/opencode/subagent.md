# OpenCode Subagent 系统

## 架构概述

Subagent 是**通过 `agent` 工具生成的子会话**。与 Claude Code 的进程内 `query()` 循环方式不同，OpenCode 的 subagent 通过 `AgentTool`（位于 `packages/opencode/src/agent/`）管理，支持同步和异步两种执行模式，可以 fork 或独立启动。

---

## Agent 类型

OpenCode 将子代理分为不同用途的专用代理：

| 类型 | 用途 | 工具集 | 备注 |
|------|------|--------|------|
| **通用子代理** | 通用研究、搜索、多步骤任务 | 继承父工具集 | 默认 |
| **Explore 代理** | 只读文件探索 | 仅搜索/读取工具 | 无写权限 |
| **Compact 代理** | 会话压缩 | 仅读取/摘要 | 专用压缩 prompt |
| **Title 代理** | 会话命名 | 无工具 | 给会话生成标题 |

---

## Agent 生命周期

### Spawn 流程

```
1. 模型调用 Agent tool → 解析参数 (task, model, agent_type)
2. 权限检查 (isEnabled, isAllowed)
3. 创建子代理上下文:
   a. 构建 system prompt (继承或独立)
   b. 配置工具集 (继承或过滤)
   c. 设置模型 (继承或覆盖)
4. 启动执行 (同步/异步)
5. 结果收集:
   a. 子代理完成
   b. 结果格式化为工具输出
   c. 附加回父会话
```

### 同步执行

- Parent 阻塞等待 child 完成
- 结果直接返回到 tool_use 结果中
- 适用于快速任务（文件搜索、代码阅读）

### 异步执行

- Parent 立即继续
- 子代理在后台运行
- 完成后结果注入父会话
- 适用于长时间运行的任务（深度研究、批处理）

---

## 上下文隔离

### Fork 模式（继承上下文）

- 子代理继承父会话的完整上下文（消息历史、system prompt）
- 适用于需要对当前上下文进行操作的子任务（修改代码、审查更改）
- 共享父会话的工具池

### 独立模式（新上下文）

- 子代理从零开始（仅有 task prompt 作为初始消息）
- 独立的 system prompt
- 独立的工具集
- 适用于独立的研究/探索任务

---

## 工具访问

### 默认继承

子代理默认继承父会话的工具集，但可以进行限制：

| 代理类型 | 允许的工具 |
|----------|-----------|
| 通用子代理 | 全部（继承父） |
| Explore 代理 | 仅限 read/glob/grep/web_search/web_fetch |
| Compact 代理 | 仅限 read/摘要相关 |
| Title 代理 | 无工具（纯文本输出） |

### 安全检查

- 子代理不能 spawn 其他子代理（防止无限递归）
- 受限制的子代理不能提升权限
- 所有操作受到父会话权限策略的约束

---

## 并发控制

- 单次 assistant message 可包含多个 Agent tool_use → 并行启动多个子代理
- 同步模式：parent 阻塞，结果立即可用
- 异步模式：parent 立即继续，后台运行
- 并发上限由系统配置控制

---

## 权限模型

- 子代理继承父会话的权限策略
- 只读代理（Explore）不能执行写操作
- 所有工具调用受父会话权限管道的约束
- 异步代理有独立的权限上下文

---

## 关键文件

| 文件 | 职责 |
|------|------|
| `packages/opencode/src/agent/index.ts` | Agent 系统入口、子代理管理 |
| `packages/opencode/src/agent/permissions.ts` | 子代理权限系统 |
| `packages/opencode/src/tool/agent/` | Agent tool 定义、输入/输出 schema、执行逻辑 |
| `packages/opencode/src/session/llm/` | LLM 集成层（子代理使用的 AI 运行时） |
| `packages/core/src/session/` | 核心会话管理 |
