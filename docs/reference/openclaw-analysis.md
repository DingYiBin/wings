# OpenClaw 参考分析

> 分析日期: 2026-07-20
> 仓库: https://github.com/openclaw/openclaw

## 项目概况

OpenClaw 是一个 TypeScript 个人 AI 助手，支持 20+ 聊天平台（WhatsApp、Telegram、Slack、Discord、飞书、微信、QQ 等）。采用单 Gateway 控制面架构，所有客户端通过 WebSocket JSON 协议连接。特色功能包括 Canvas 画布、语音、插件系统、FIFO 消息队列。

技术栈：TypeScript (ESM) / Node.js 22+ / pnpm monorepo / Express 5 / WebSocket / kysely / SQLite / Zod 4 / Playwright

## 值得参考的功能

### 1. Gateway + WebSocket 控制面架构

单 Gateway 进程拥有所有消息面。所有客户端通过 WebSocket JSON 协议连接，首帧必须发 `connect`。支持 `req/res` 请求-响应模式和 `event` 服务器推送事件。要求副作用操作携带幂等键（idempotency key）支持安全重试。

**对 wings 的价值**：Gateway 控制面 + WebSocket 协议是 CLI/Web/App 统一接入的好方案。幂等键设计对安全重试很重要。

### 2. FIFO 消息队列 + 多模式

队列模式（通过 `/queue` 命令切换）：
- `steer` — 将消息注入活跃运行时（同回合）
- `followup` — 排队等待当前运行结束后执行
- `collect` — 合并排队消息为一个回合
- `interrupt` — 中止当前运行，立即处理新消息

参数：`debounceMs: 500`, `cap: 20`, `drop: summarize`

**对 wings 的价值**：处理并发入站消息的优雅方案。wings 的子任务场景可以借鉴多模式队列。

### 3. Canvas 画布

Agent 可在 Gateway HTTP 服务器上动态创建和托管 HTML/CSS/JS 文档。支持内联 HTML bundle、URL 嵌入、PDF 预览包装、Widget Dashboard（`show_widget` 工具）。CSP sandbox 保护。

**对 wings 的价值**：终端 Agent 中展示可视化结果的创新方案。Ink 也可以渲染简单图表。

### 4. 插件系统（158 个扩展）

两种插件模式：Code 插件（深度运行时扩展：供应商、渠道、工具）和 Bundle 插件（打包稳定外部接口：技能、MCP 服务器、配置）。插件 SDK 提供 75+ 导出入口。

**对 wings 的价值**：插件 SDK 的契约设计参考价值大，尤其是工具/渠道/供应商的扩展点定义。

### 5. DM 配对安全模式

每条渠道的 DM 配对策略（`dmPolicy: "pairing"`）：未知发送者收到配对码。SecretRef 系统（密钥引用而非存储明文）。命令/提及门控。SSRF 防护。

**对 wings 的价值**：面向消息平台的 AI Agent 的安全基础设计参考。

### 6. Agent 工作空间 + 引导文件

每个 Agent 独立工作空间，包含：
- `AGENTS.md` — 操作指令 + 记忆
- `SOUL.md` — 人格/边界/语调
- `TOOLS.md` — 用户维护的工具笔记
- `BOOTSTRAP.md` — 一次性初始化仪式
- `MEMORY.md` — 长期记忆

**对 wings 的价值**：与 wings 的 `CLAUDE.md` 思路一致。`SOUL.md` 人格定义和 `BOOTSTRAP.md` 初始化仪式是有趣的补充。

### 7. 技能系统

6 层技能发现（优先级从高到低）：工作空间 > 项目 Agent > 个人 Agent > 托管/本地 > 内置 > 额外目录。技能包含 `install`（依赖安装规格）、`requires`（环境依赖检查）、`invocation`（调用策略）等元数据。

**对 wings 的价值**：技能的 `install` 和 `requires` 元数据定义值得参考，增强 wings 的 skill 自治能力。

### 8. 上下文引擎

`ContextEngine` 管理 Agent 的上下文窗口：委托上下文构建、上下文来源注册、运行时设置、安全隔离。

**对 wings 的价值**：上下文委托和隔离管理方案值得参考。

### 9. 架构设计原则

来自 CLAUDE.md 的设计约束：
- 核心保持插件无关，无硬编码渠道 ID
- 存储默认 SQLite，禁止新建 JSON/JSONL/TXT 文件存运行时状态
- 配置变更需要 doctor 迁移
- 热路径禁止文件系统轮询
- 代码重构应删除约同等数量的复杂度

**对 wings 的价值**：这些设计原则本身就有参考价值，尤其是"配置变更需要迁移"和"重构应删除同等复杂度"。

## 不建议参考的部分

| 功能 | 原因 |
|------|------|
| 20+ 聊天平台 | wings 是 CLI 工具 |
| Canvas 画布 HTML 渲染 | 超出终端 Agent 范围 |
| 语音/Voice | 超出终端 Agent 范围 |
| 158 个扩展 | 规模过大 |
| macOS/iOS/Android 应用 | wings 不需要移动端 |

## 优先级建议

1. **中优先**: Agent 工作空间 boot 文件（SOUL.md/TOOLS.md/BOOTSTRAP.md）
2. **中优先**: 技能 install/requires 元数据增强
3. **低优先**: FIFO 消息队列多模式
4. **低优先**: Gateway WebSocket 控制面
5. **低优先**: 插件 SDK 契约设计
