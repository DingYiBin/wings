# claude-code 内置 Skills 参考

> 来源: `reference/claude-code/src/skills/bundled/`
> 约 18 个 skill，大部分是硬编码 TypeScript 文件

## 核心开发类

### skillify
- **类型**: prompt, user-invocable only
- **说明**: 将对话内容提炼为可复用的 skill 定义
- **特点**: 注入 session memory 和用户消息，生成带上下文的 skill

### simplify
- **类型**: prompt, user-invocable
- **说明**: 审查代码的复用性、质量和效率，并修复发现的问题
- **特点**: 检查 dead code、重复、复杂度、命名

### verify
- **类型**: prompt, user-invocable
- **说明**: 运行测试验证代码变更
- **特点**: 有子目录结构，包含 examples/

### commit
- **类型**: 通过 SkillTool 回调实现
- **说明**: 生成 git commit message

### debug
- **类型**: prompt
- **说明**: 调试代码问题

### batch
- **类型**: prompt
- **说明**: 批量处理多个独立任务，减少 round-trip

### stuck
- **类型**: prompt
- **说明**: 检测 agent 是否陷入循环/卡住，自动诊断和恢复

### loop
- **类型**: prompt, 需要 feature flag
- **说明**: 定时/cron 循环执行任务
- **参数**: `[interval] <prompt>`

## 记忆与持久化类

### remember
- **类型**: prompt, user-invocable
- **说明**: 保存记忆到持久化存储（MEMORY.md）

### dream
- **类型**: prompt
- **说明**: 离线记忆巩固，扫描对话历史提取关键信息

## 配置与工具类

### update-config
- **类型**: prompt
- **说明**: 更新 claude-code 配置文件

### keybindings
- **类型**: prompt
- **说明**: 显示当前快捷键绑定

### schedule-remote-agents
- **类型**: prompt
- **说明**: 调度远程 agent 执行任务

### claude-api
- **类型**: prompt
- **说明**: 调用 Claude API 的代码示例
- **子目录**: csharp/, curl/, go/, java/, php/, python/, ruby/, typescript/

### claude-in-chrome
- **类型**: prompt
- **说明**: 在 Chrome 浏览器中运行 Claude 的示例

### lorem-ipsum
- **类型**: prompt
- **说明**: 生成占位文本（测试/演示用）

## 设计模式

claude-code skills 的关键设计:

1. **统一 Command 类型**: skill 和 slash command 是同一种类型 `PromptCommand`
2. **双路径调用**: 用户 `/name` → slash command 解析；模型调用 `SkillTool({skill, args})`
3. **inline vs fork**: `context: 'inline'` 注入当前对话；`context: 'fork'` 生成独立 sub-agent
4. **programmatic registration**: TypeScript 函数 `registerBundledSkill()` 在模块 init 时注册
5. **getPromptForCommand(args, context)**: 每个 skill 的核心方法，返回 `ContentBlockParam[]`
6. **allowedTools 限制**: skill 可以限制可用的工具集
7. **model override**: skill 可以指定使用特定模型
8. **conditional activation**: `paths` 字段按 gitignore 模式匹配，只在相关文件被触碰时激活
