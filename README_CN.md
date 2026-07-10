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

# 指定模型
node --import tsx src/index.ts chat -m anthropic/claude-opus-4-6

# 恢复上次会话
node --import tsx src/index.ts chat --continue
node --import tsx src/index.ts chat --resume abc123def4567890
```

### 对话命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示可用命令 |
| `/pool` | 查看 API 候选池分数 |
| `/pool up <api>` | 提高某个 API 的分数（+0.5） |
| `/pool down <api>` | 降低某个 API 的分数（-0.5） |
| Ctrl+C 两次 | 退出（显示 session hash 用于恢复） |

### 键盘快捷键

| 按键 | 功能 |
|------|------|
| `↑`/`↓` 或 Ctrl+P/N | 浏览输入历史 |
| `←`/`→` 或 Ctrl+B/F | 移动光标 |
| Ctrl+←/→ | 按词跳转 |
| Home/End 或 Ctrl+A/E | 跳到行首/行尾 |
| Ctrl+W | 删除前一个词 |
| Ctrl+K | 删至行尾 |
| Ctrl+U | 删至行首 |
| Esc 或 Ctrl+C | 中断正在运行的 agent |
| Ctrl+C 两次 | 退出 |

### 权限确认

```
bash(ls -la)

❯ Yes
  Yes, and don't ask again
  No, tell Wings differently

  Enter = allow · Esc = deny
```

`↑`/`↓` 移动光标，`Enter`/`y` 允许，`Esc`/`n` 拒绝。拒绝一个工具会跳过本轮剩余所有工具。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WINGS_DEBUG` | 不设置 | 设为 `1` 启用调试日志（写入 `/tmp/wings-debug.log`） |
| `WINGS_HISTORY_ROLLBACK` | `1000` | 输入历史最大条数；`0` 禁用历史 |
| `WINGS_PROVIDERS__<NAME>__API_KEY` | — | 覆盖指定 provider 的 API key |

## 架构

```
src/
├── index.ts              # CLI 入口
├── cli/                  # Ink v7 React TUI
│   ├── ink-app.tsx       # Ink render() 入口，stdin 处理
│   ├── app.tsx           # <App> 根组件
│   ├── repl.tsx          # <REPL> 布局：Messages, PromptInput, StatusBar
│   ├── components/       # Messages, PromptInput, PermissionDialog, StatusBar, WorkingIndicator
│   ├── hooks.ts          # useStore, useAgent（agent loop + streaming）
│   ├── app-state.ts      # AppState store（createStore + 不可变更新）
│   ├── store.ts          # createStore<T>() 工具
│   ├── bootstrap.ts      # 组合根（依赖注入）
│   └── main.ts           # runSingle + 非 TTY 的 readline 回退
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
