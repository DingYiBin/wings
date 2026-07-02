# Wings

多模型聚合 Agent 系统 —— 接入各家模型 API，让不同模型的能力相互补全。每个模型都是一只翅膀。

## 技术栈

- **运行时**: [Python 3.12+](https://www.python.org/)
- **语言**: Python (Pydantic v2 类型校验)
- **架构**: 参考 [claude-code](https://github.com/anthropics/claude-code) 和 [opensquilla](https://github.com/opensquilla/opensquilla)
- **包管理**: [uv](https://docs.astral.sh/uv/)

## 快速开始

```bash
uv sync
uv run wings --help
```

## 项目结构

```
src/wings/
├── agent/          # Agent 核心循环
├── cli/            # CLI 入口 + REPL
├── config/         # 配置系统
├── context/        # 上下文收集
├── hooks/          # 生命周期钩子
├── memory/         # 持久化记忆
├── messages/       # 消息类型 + 跨模型转换
├── models/         # 模型适配层 (每只翅膀)
├── permissions/    # 权限管道
├── plugins/        # 插件系统
├── query/          # 查询引擎
├── services/       # 外部服务 (API, MCP)
├── skills/         # 可复用技能
└── tools/          # 工具系统
```

## 理念

不同 AI 模型各有所长：有的推理强，有的速度快，有的擅长代码，有的精于创意。Wings 将这些模型统一接入，根据任务特点智能调度，让它们协同工作。
