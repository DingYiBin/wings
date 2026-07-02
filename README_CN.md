# Wings

多模型聚合 Agent 系统 —— 接入各家模型 API，让不同模型的能力相互补全。每个模型都是一只翅膀。

## 设计理念

**默认随机**。不猜测任务应该用哪个模型——诚实承认"我们不知道哪个模型最好"。每次随机选择一个可用模型，用户通过实际使用发现各模型的擅长领域。需要精准控制时，用 `/model` 命令指定。

**一切皆工具**。文件读写、shell 执行、搜索、子 agent 调用——都实现统一的 `Tool` 协议，经过同一条权限管道。

**Skill 即 Command**。用户在 REPL 键入 `/xxx` 和模型通过 SkillTool 调用，是同一套东西，只是触发方式不同。

## 技术栈

- **运行时**: Python 3.12+
- **类型校验**: Pydantic v2
- **CLI**: Typer + Rich
- **包管理**: uv

## 参考项目

| 项目 | 语言 | 参考点 |
|------|------|--------|
| [claude-code](https://github.com/anthropics/claude-code) | TypeScript | Tool/Command 接口、权限管道、双层状态、Skill-Command 统一系统 |
| [opensquilla](https://github.com/opensquilla/opensquilla) | Python | Protocol 驱动 DI、StageOutcome、TurnRunner 阶段分解、记忆/Dream 系统 |

详细架构分析见 [`docs/`](docs/)。

## 项目结构

```
src/wings/
├── agent/          # Agent 核心循环
├── cli/            # CLI 入口 + REPL
├── config/         # 配置系统
├── context/        # system prompt + 环境信息
├── hooks/          # 生命周期钩子
├── memory/         # 持久化记忆
├── messages/       # 消息类型 + 跨模型转换
├── models/         # 模型适配层 (每只翅膀)
├── permissions/    # 权限管道
├── plugins/        # 插件系统
├── query/          # 查询引擎
├── services/       # 外部服务 (API, MCP)
├── skills/         # 可复用技能 (也是 Command)
└── tools/          # 工具系统
```

## 实施顺序

| 阶段 | 模块 | 说明 |
|------|------|------|
| 1 | messages | 消息类型 + Anthropic/OpenAI 格式转换 |
| 2 | models | ModelProvider 协议 + 各 API 适配器 |
| 3 | tools | Tool 协议 + 注册表 + 内置工具 |
| 4 | query | LLM API 调用 (retry, fallback) |
| 5 | permissions | 多阶段权限管道 |
| 6 | agent | 核心循环 + 子 agent |
| 7 | config | 全局/项目配置 |
| 8 | cli | Typer 入口 + REPL |
| 9+ | hooks, memory, skills, plugins, MCP | 后续迭代 |
