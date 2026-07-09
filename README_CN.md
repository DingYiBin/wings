# Wings

多模型 AI Agent CLI。每次模型调用从任务类型专属的 API 候选池中，通过 softmax 加权随机选择一个 API。用户通过打分塑造各任务使用的模型组合——每个模型都是一只翅膀。

TypeScript 实现，Node.js 运行，Bun 测试。

## 安装

需要 Node.js 22+, npm。

```bash
git clone https://github.com/DingYiBin/wings.git
cd wings
npm install
```

测试用 Bun（更快的测试运行器）：

```bash
bun test                    # 228 个测试
bun x tsc --noEmit          # 类型检查
```

## 配置

与 Python 版共用同一 schema。两个 JSON 文件，deep-merge。

### 全局配置 (`~/.wings/config.json`)

```json
{
  "providers": {
    "anthropic": {
      "model": "claude-sonnet-4-6",
      "protocol": "anthropic",
      "api_key": "sk-ant-...",
      "base_url": "https://api.anthropic.com"
    }
  }
}
```

Provider 字段：`model`, `protocol`（"anthropic" 或 "openai"）, `api_key`, `base_url`（必填）, `max_tokens`（8000）, `escalated_max_tokens`（64000）, `thinking`（true）, `thinking_budget`（null）。

环境变量（优先级高于配置文件）：

```bash
export WINGS_PROVIDERS__ANTHROPIC__API_KEY="sk-ant-..."
```

### 项目配置 (`.wings/config.json`)

覆盖全局设置：

```json
{
  "personality": "你是一个简洁、直接的助手。",
  "allowed_tools": ["read", "glob", "grep"],
  "denied_tools": []
}
```

### API 候选池（可选）

为不同任务类型定制模型偏好：

```json
{
  "routing": {
    "version": 2,
    "apis": [
      {"api_id": "anthropic/claude-sonnet-4-6", "score": 0},
      {"api_id": "anthropic/claude-haiku-4-5", "score": -2}
    ],
    "masks": {
      "main": {"anthropic/claude-opus-4-6": 2.0},
      "subagent": {"anthropic/claude-haiku-4-5": 1.0}
    }
  }
}
```

### Skills

SKILL.md 文件（YAML frontmatter + markdown 正文）：
- `.wings/skills/<name>/SKILL.md`（项目级）
- `~/.wings/skills/<name>/SKILL.md`（用户级）

### 自定义 Agent

`.wings/agents/*.md` 文件（格式同 SKILL.md）定义自定义子代理类型。

## 使用

```bash
# 交互式对话
node --import tsx src/index.ts chat

# 单轮执行
node --import tsx src/index.ts run "这个项目是做什么的？"

# 带日志
node --import tsx src/index.ts chat --log

# 指定模型
node --import tsx src/index.ts chat -m anthropic/claude-opus-4-6
```

### 对话命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示可用命令 |
| `/pool` | 查看 API 候选池分数 |
| `/pool up <api>` | 提高某个 API 的分数（+0.5） |
| `/pool down <api>` | 降低某个 API 的分数（-0.5） |
| Ctrl+C | 退出 |

### 权限确认

当工具需要用户批准时，弹出方向键导航的对话框：
- `↑`/`↓` 或 `j`/`k` — 移动光标
- `Enter` — 选中高亮项
- `y` — 允许, `n`/`Esc` — 拒绝

### 日志格式

`--log` 将 JSON Lines 写入 `.wings/logs/`。每行记录一次 API 调用周期，包含模型、时间、token 数、工具调用和响应内容。

## 架构

```
src/
├── index.ts              # CLI 入口
├── cli/                  # REPL（raw mode + readline），bootstrap 依赖注入，日志
│   ├── main.ts           # chat + run 命令，权限对话框
│   ├── bootstrap.ts      # 组合根（依赖注入）
│   ├── logging.ts        # --log: JSONL 请求/响应日志
│   └── ink-app.tsx        # Ink/React REPL（预留）
├── agent/                # AgentLoop（每次调用独立选模型），HandoffDetector
│   ├── loop.ts           # 主对话循环（async generator）
│   ├── subagent.ts       # 3 内置 + 自定义 agent 类型，runSubagent
│   ├── handoff.ts        # 模型切换检测
│   └── agent_loader.ts   # 从 .wings/agents/ 发现自定义 agent
├── query/                # QueryEngine（指数退避重试），TokenBudget
├── tools/                # buildTool() + Zod，10 个内置工具
│   └── builtin/          # read/write/edit/bash/glob/grep/skill_view/agent/web_fetch/web_search
├── permissions/          # 4 阶段管道：静态规则 → 作用域 → 自动分类只读 → hooks → 交互
├── models/               # Anthropic + OpenAI 适配器（流式，max_tokens 升级）
├── routing/              # APIPoolManager（softmax 选择），ModelSelector 接口
├── messages/             # 内部类型 + Anthropic/OpenAI 格式转换
├── config/               # 双文件 JSON deep merge（全局 + 项目）
├── skills/               # SkillLoader（3 层），SkillInjector
├── memory/               # MEMORY.md 索引 + 主题文件，自动提取
├── hooks/                # Shell 命令生命周期钩子
├── mcp/                  # MCP 客户端（@modelcontextprotocol/sdk stdio 传输）
└── services/             # Compaction，Session Memory
```

模块依赖顺序：messages/routing → models → tools → query → permissions → agent → config/skills/memory/hooks/mcp → cli。

## 开发

```bash
# 测试（Bun）
bun test                          # 全部 228 个测试
bun test tests/ts/agent.test.ts   # 单个文件

# 类型检查
bun x tsc --noEmit

# 运行
node --import tsx src/index.ts chat
```

## 设计文档

- [`docs/design/architecture.md`](docs/design/architecture.md) — 架构总览与 agent loop 设计
- [`docs/design/modules.md`](docs/design/modules.md) — 详细模块设计 + 实现历史
- [`docs/design/ts-rewrite-plan.md`](docs/design/ts-rewrite-plan.md) — Python → TypeScript 重写计划
- [`docs/design/tool-comparison.md`](docs/design/tool-comparison.md) — 工具实现对比
- [`docs/reference/`](docs/reference/) — claude-code 和 opensquilla 分析
