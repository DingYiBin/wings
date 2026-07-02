# Claude Code — Skill 与 Command 统一系统

## 核心发现

在 claude-code 中，用户在 REPL 键入 `/` 看到的列表、模型通过 SkillTool 调用的能力，**是同一套 `Command` 类型**，只是触发方式不同。

## Command 类型定义

**位置**: `src/types/command.ts`

```typescript
type CommandBase = {
  name: string
  description: string
  aliases?: string[]
  argumentHint?: string         // 参数提示（灰色显示在命令后）
  whenToUse?: string             // 详细使用场景，注入 SkillTool 提示

  // 关键开关
  userInvocable?: boolean        // 用户能否键入 /skill-name 触发
  disableModelInvocation?: boolean // 模型能否通过 SkillTool 触发
  isEnabled?: () => boolean      // 动态启用/禁用
  isHidden?: boolean             // 从补全/帮助中隐藏

  // 来源追踪
  loadedFrom?: 'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'
}
```

### 三种 Command 子类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `PromptCommand` (`type: 'prompt'`) | **Skill** — 一段 prompt 文本，模型通过 SkillTool 调用时展开 | commit, pdf, review, simplify |
| `LocalCommand` (`type: 'local'`) | 本地函数，在 REPL 进程中执行业务逻辑 | login（旧版） |
| `LocalJSXCommand` (`type: 'local-jsx'`) | 带 React/Ink UI 组件的本地命令 | plugin（管理界面） |

## Command 的六个来源

在启动时，`src/commands.ts` 的 `getCommands()` 从六个来源聚合所有 Command：

```
getCommands()
  │
  ├── commands_DEPRECATED  → 旧版内置命令 (正在被 bundled skills 替代)
  │     /help, /clear, /login, /logout, /doctor, /theme, /vim...
  │     userInvocable: true, disableModelInvocation: true (模型不应调用)
  │
  ├── bundled             → 内置 skill，registerBundledSkill() 注册
  │     /commit, /review-pr, /pdf, /simplify, /remember, /loop, /verify...
  │     type: 'prompt', userInvocable: true, source: 'bundled'
  │
  ├── skills              → 磁盘上的 .md skill 文件
  │     用户自定义 + 插件提供的 skill，从多个目录加载
  │     type: 'prompt', source: 'skills'
  │
  ├── plugin              → 已安装插件的 commands
  │     从市场下载的插件，通过 pluginLoader 加载
  │     type: 'prompt' | 'local', source: 'plugin'
  │
  ├── managed             → 企业管理配置推送的 skills
  │     IT 部门通过 MDM/远程设置推送
  │     source: 'managed'
  │
  └── mcp                 → MCP 服务器暴露的工具 (作为 commands 暴露)
        source: 'mcp'
```

## 两条调用路径

### 用户路径 (REPL 中键入 `/`)

```
用户键入 /commit -m "fix bug"
  → processSlashCommand.tsx 解析
  → findCommand("commit")
  → 如果是 PromptCommand → 展开为 prompt，注入消息列表
  → 如果是 LocalCommand → 执行本地函数
```

命令列表通过 `getCommands()` 获取，过滤条件：
- `isEnabled()` 返回 true
- `isHidden` 不为 true
- 满足 `availability` 限制（claude-ai subscriber 专属等）

### 模型路径 (SkillTool)

```
模型: SkillTool({ skill: "commit", args: "-m 'fix bug'" })
  → SkillTool.call()
  → findCommand("commit")
  → 检查 !disableModelInvocation
  → 展开 getPromptForCommand(args, context) → ContentBlockParam[]
  → 注入消息列表（inline 模式）或 启动子 agent（fork 模式）
```

SkillTool 的 prompt 明确告诉模型：

> "When users reference a 'slash command' or '/\<something\>' (e.g., '/commit', '/review-pr'), they are referring to a skill. Use this tool to invoke it."

## 内置 Skill (bundled) 注册方式

**文件**: `src/skills/bundledSkills.ts`

```typescript
type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  allowedTools?: string[]
  model?: string                    // 可选模型覆盖
  disableModelInvocation?: boolean
  userInvocable?: boolean           // 默认 true
  isEnabled?: () => boolean
  context?: 'inline' | 'fork'       // inline = 展开到当前会话, fork = 子 agent
  agent?: string                    // fork 时的 agent 类型
  files?: Record<string, string>    // 参考文件（延迟提取到磁盘）
  getPromptForCommand: (args: string, context) => Promise<ContentBlockParam[]>
}

function registerBundledSkill(definition: BundledSkillDefinition): void
```

每个内置 skill 在 `src/skills/bundled/index.ts` 中调用 `registerBundledSkill()`。

## Skill 列表的 Token 预算控制

**文件**: `src/tools/SkillTool/prompt.ts`

Skill 列表注入 system prompt 时有严格预算：
- 默认占 **1% 上下文窗口**
- 每个 skill 描述最大 **250 字符** (`MAX_LISTING_DESC_CHARS`)
- 空间不够时非 bundled skills 的描述被截断
- 极限情况下只显示名称

```typescript
// 预算计算
SKILL_BUDGET_CONTEXT_PERCENT = 0.01  // 1% of context window
CHARS_PER_TOKEN = 4
DEFAULT_CHAR_BUDGET = 8000           // 1% of 200k × 4
```

这保证了 skill 列表不会吃掉过多 context 资源。

## 对 wings 的设计启示

### 1. 统一 Command/Skill 类型

不做两套系统——一个 `Command` 类型承载所有 `/` 命令和模型可调用的技能：

```python
@dataclass
class Command:
    name: str
    description: str
    user_invocable: bool = True           # 用户能否键入 /name
    disable_model_invocation: bool = False  # 模型能否通过 SkillTool 调用
    source: str = "bundled"               # bundled | skills | plugin | managed | mcp
    # PromptCommand 专属
    get_prompt: Callable | None = None    # 展开为 system prompt 内容
    # LocalCommand 专属
    execute: Callable | None = None       # 本地执行函数
```

### 2. 多来源聚合

```python
def get_commands() -> list[Command]:
    return [
        *load_bundled_commands(),   # 内置 skills
        *load_disk_skills(),        # 磁盘上的 .md 文件
        *load_plugin_commands(),    # 已安装插件
        *load_mcp_commands(),       # MCP 服务器
    ]
```

### 3. inline vs fork 执行上下文

claude-code 的 `context: 'inline' | 'fork'` 值得直接复制：
- **inline**: skill prompt 展开到当前会话，模型直接接着执行
- **fork**: 启动子 agent，隔离上下文和 token 预算（适合长时间运行的 skill）

### 4. token 预算控制

skill 列表不是随意塞进 system prompt 的——有预算上限、有截断逻辑。这对 wings 同样重要，因为模型列表多时描述文本可能很大。

### 5. userInvocable ≠ model-invocable

有些命令是给用户用的（`/help`, `/clear`），模型不应该调用。通过 `disableModelInvocation` 区分：
- 用户专用命令：`userInvocable: True, disableModelInvocation: True`
- 通用 skill：`userInvocable: True, disableModelInvocation: False`（默认）
- 纯后台 skill：`userInvocable: False, disableModelInvocation: False`
