# Hermes Agent 参考分析

> 分析日期: 2026-07-20
> 仓库: https://github.com/NousResearch/hermes-agent

## 项目概况

Hermes Agent 是 Nous Research 开发的自我进化 AI Agent，具有内置的学习循环——从经验中创建技能、在使用中自我改进、持久化知识、跨 session 构建用户模型。支持 Telegram/Discord/Slack/WhatsApp/Signal 等多平台和 6 种终端后端。

技术栈：Python 3.11+ / MIT 协议

## 值得参考的功能

### 1. 封闭学习循环（核心创新）

Hermes 最独特的设计：Agent-curated memory 带定期 nudges。自主技能创建（复杂任务后自动生成）。技能在使用中自我改进。FTS5 会话搜索 + LLM 摘要实现跨 session 回忆。Honcho dialectic 用户建模。

**对 wings 的价值**：目前 wings 有 memory 系统但缺少"技能从经验中自动创建"的闭环。这个自主进化机制是长期方向。

### 2. 多平台渠道 + 云端运行

Telegram、Discord、Slack、WhatsApp、Signal 和 CLI——全部通过单个 Gateway 进程。六种终端后端：Local、Docker、SSH、Singularity、Modal、Daytona。Daytona/Modal 提供 serverless 持久化——环境在空闲时休眠，按需唤醒。

**对 wings 的价值**：Gateway 模式管理多平台 + 云端 serverless 持久化的方案值得参考。

### 3. Cron 调度自动化

内置 cron 调度器，可投递到任意平台。每日报告、夜间备份、每周审计——全部自然语言配置，无人值守运行。

**对 wings 的价值**：wings 的 cron 功能可以借鉴这个自然语言配置的设计。

### 4. 子代理并行化

生成隔离的子代理用于并行工作流。Python 脚本可通过 RPC 调用工具，将多步骤管道折叠为单轮零上下文成本。

**对 wings 的价值**：子代理 RPC 调用工具的设计比 session 间通信更高效。

### 5. 研究就绪

批处理轨迹生成、轨迹压缩用于训练下一代工具调用模型。

**对 wings 的价值**：对 Agent 研究场景很有价值，当前优先级不高。

### 6. 批处理安装

单行安装脚本（`curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`），自动处理 uv、Python 3.11、Node.js、ripgrep、ffmpeg 等依赖。Windows 使用 MinGit 沙箱化的 Git Bash。

**对 wings 的价值**：安装体验设计思路可参考。

## 不建议参考的部分

| 功能 | 原因 |
|------|------|
| Telegram/Discord/Slack 渠道 | wings 是 CLI 工具 |
| 六种终端后端 | wings 只在本地运行 |
| Honcho dialectic 建模 | 过于学术化 |
| 批处理轨迹生成 | 训练场景，非产品功能 |

## 优先级建议

1. **中优先**: 自主技能创建/改进循环 — 长期进化方向
2. **中优先**: Cron 自然语言调度 — 增强 wings 的 cron 功能
3. **低优先**: 子代理 RPC 工具调用
4. **低优先**: FTS5 跨 session 搜索
