# Claude Code — Prompt 体系分析

## 总览

Claude Code 的 prompt 体系分五层：**主 System Prompt** → **工具描述** → **上下文注入 (CLAUDE.md)** → **Attachments** → **专用 Prompt 模板**。

---

## 1. 主 System Prompt

### 核心文件

| 文件 | 说明 |
|------|------|
| `src/constants/prompts.ts` | **主系统提示词文件**。`getSystemPrompt()` 组装完整 system prompt 数组 |
| `src/utils/systemPrompt.ts` | `buildEffectiveSystemPrompt()` — 优先级分层：Override → Coordinator → Agent → Custom → Default |
| `src/constants/systemPromptSections.ts` | 动态 section 注册表，支持 memoized/recompute-every-turn 两种模式 |
| `src/utils/systemPromptType.ts` | `SystemPrompt` 品牌类型 (readonly string[] wrapper) |
| `src/constants/system.ts` | 三个前缀常量 (DEFAULT_PREFIX, SDK_PREFIX, AGENT_SDK_PREFIX) |

### System Prompt 组成 (按 `getSystemPrompt()` 顺序)

| 函数 | 内容 |
|------|------|
| `getSimpleIntroSection()` | 身份介绍 + `CYBER_RISK_INSTRUCTION` |
| `getSimpleSystemSection()` | 系统规则 (hook 处理、prompt injection 警告) |
| `getSimpleDoingTasksSection()` | 任务执行指引 (代码风格、注释规则、安全考虑) |
| `getActionsSection()` | 谨慎执行动作 (风险操作确认、blast radius) |
| `getUsingYourToolsSection()` | 工具使用指南 (用专用工具而非 Bash) |
| `getSimpleToneAndStyleSection()` | 风格约束 (emoji、排版、简洁) |
| `getOutputEfficiencySection()` | 输出效率指引 |
| 动态 section | memory prompt, MCP instructions, scratchpad 等 |
| `computeEnvInfo()` | 环境信息块 |
| `getProactiveSection()` | 自主模式行为 |
| `getBriefSection()` | 简要模式 section |
| `DEFAULT_AGENT_PROMPT` | 默认 agent 身份行 |

### 模块路径 (wings 对应)

对应 wings 要实现的 `context/system_prompt.py`：需要组装一个类似的多段 system prompt，包含身份、工具列表、环境信息、行为约束。

---

## 2. 工具描述 Prompts

### 结构

每个工具在 `src/tools/<ToolName>/prompt.ts` 中定义其 prompt 或 description。关键文件：

| 文件 | 内容 | wings 参考 |
|------|------|-----------|
| `BashTool/prompt.ts` | `getSimplePrompt()` — 大量 bash 使用说明 (sandbox, git, sleep, 并行, commit/PR 流程) | `tools/builtin/bash.py` |
| `FileEditTool/prompt.ts` | 精确字符串替换指令、行号格式、唯一性规则 | `tools/builtin/edit.py` |
| `GlobTool/prompt.ts` | 文件模式匹配规则 | `tools/builtin/glob.py` |
| `GrepTool/prompt.ts` | 内容搜索规则 | `tools/builtin/grep.py` |
| `TodoWriteTool/prompt.ts` | 任务列表管理指令 + 示例 | `tools/builtin/task.py` |
| `WebFetchTool/prompt.ts` | `makeSecondaryModelPrompt()` — 给 secondary model 处理内容的 prompt | `tools/builtin/web_fetch.py` |
| `AgentTool/prompt.ts` | 子 agent 工具描述、fork subagent 消息格式 | `agent/subagent.py` |
| `AgentTool/built-in/generalPurposeAgent.ts` | 通用子 agent system prompt | `agent/subagent.py` |
| `AgentTool/built-in/exploreAgent.ts` | 探索子 agent system prompt | `agent/subagent.py` |
| `AgentTool/built-in/planAgent.ts` | 计划模式子 agent system prompt | `agent/subagent.py` |
| `SkillTool/prompt.ts` | 技能列表描述 (含字符预算) | `skills/` |
| `MCPTool/prompt.ts` | MCP 工具 prompt | `services/mcp/` |
| `EnterPlanModeTool/prompt.ts` | 计划模式入口描述 | `tools/builtin/plan_mode.py` |
| `AskUserQuestionTool/prompt.ts` | 用户提问工具描述 | `tools/builtin/ask_user.py` |

### 工具描述注入方式

`src/Tool.ts` 的 `Tool` 接口定义 `description` 和 `prompt()` 方法；`src/tools.ts` 注册所有工具；`src/utils/api.ts` 的 `toolToAPISchema()` 将工具序列化为 Anthropic API schema（含 description、input schema、cache control）。

---

## 3. 命令描述

`src/commands.ts` 集中注册所有斜杠命令。每个命令有 `name`, `description` (给用户看), `whenToUse` (注入 Skill tool 给 Claude 做提示)。

**关键命令**: `/clear`, `/compact`, `/config`, `/cost`, `/doctor`, `/help`, `/login`, `/mcp`, `/memory`, `/model`, `/permissions`, `/plugin`, `/resume`, `/review`, `/status`, `/tasks`, `/theme`, `/vim`

部分命令包含内联 prompt (如 `commands/security-review.ts`, `commands/compact/compact.ts`)。

---

## 4. CLAUDE.md / 上下文注入

### 文件发现和加载

`src/utils/claudemd.ts` 是 CLAUDE.md 系统的核心：

- `MEMORY_INSTRUCTION_PROMPT`: "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior..."
- **加载顺序**: Managed → User → Project → Local (从根目录走向 CWD)
- `getMemoryFiles()`: 发现所有 CLAUDE.md, .claude/CLAUDE.md, .claude/rules/*.md
- `@include` 指令支持嵌套文件引用
- 条件规则: frontmatter `paths:` 支持 glob 匹配
- 最大文件大小: 40,000 字符

### 注入位置

- `src/context.ts` 的 `getUserContext()` 调用 `getClaudeMds()`，包装 CLAUDE.md 内容
- `src/context.ts` 的 `getSystemContext()` 注入 git status
- `src/query.ts` 的 `query()` 使用 `prependUserContext()` / `appendSystemContext()` 注入到消息列表
- `src/utils/api.ts` 的 `splitSysPromptPrefix()` 将 system prompt 按 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 分割用于缓存优化

### wings 对应

`context/system_prompt.py` + `memory/store.py` (MEMORY.md 模式)

---

## 5. 专用 Prompt 模板

### 5.1 Compact (上下文压缩)

`src/services/compact/prompt.ts` — 4 种 compact prompt:

| Prompt | 用途 |
|--------|------|
| `BASE_COMPACT_PROMPT` | 完整对话摘要 (9 个结构化 section) |
| `PARTIAL_COMPACT_PROMPT` | 仅摘要最近消息 |
| `PARTIAL_COMPACT_UP_TO_PROMPT` | 有新消息时的前缀摘要 |
| `NO_TOOLS_PREAMBLE` / `NO_TOOLS_TRAILER` | 强制不调用工具 |

`src/services/compact/compact.ts` 的 `buildPostCompactMessages()` 在 compact 后重新组装消息。

### 5.2 Memory (自动记忆)

`src/memdir/memoryTypes.ts` — 四类记忆分类体系:
- `TYPES_SECTION_COMBINED` — 合并模式
- `TYPES_SECTION_INDIVIDUAL` — 独立模式
- `WHAT_NOT_TO_SAVE_SECTION` — 不保存什么
- `WHEN_TO_ACCESS_SECTION` / `TRUSTING_RECALL_SECTION` — 何时/如何信任记忆
- `MEMORY_FRONTMATTER_EXAMPLE` — frontmatter 示例

`src/memdir/memdir.ts` — `buildMemoryPrompt()`, `loadMemoryPrompt()`, `buildAssistantDailyLogPrompt()`

### 5.3 Session Memory

`src/services/SessionMemory/prompts.ts`:
- `DEFAULT_SESSION_MEMORY_TEMPLATE` — 9 个 section: Session Title, Current State, Task Specification, Files and Functions...
- 默认更新 prompt: "Based on the user conversation above... update the session notes file"

### 5.4 Dream (记忆巩固)

`src/services/autoDream/consolidationPrompt.ts`:
- `buildConsolidationPrompt()` — "You are performing a dream — a reflective pass over your memory files" 四个阶段: orient, gather, consolidate, prune and index

### 5.5 Magic Docs

`src/services/MagicDocs/prompts.ts`:
- `getUpdatePromptTemplate()` — 更新文档，规则: 简洁、聚焦概述/架构、不重复源码

### 5.6 其他

| 文件 | Prompt 类型 |
|------|------------|
| `src/services/awaySummary.ts` | 离开摘要: "The user stepped away..." 1-3 句 |
| `src/utils/claudeInChrome/prompt.ts` | Chrome 自动化指引 (GIF 录制、console 调试、tab 管理) |
| `src/buddy/prompt.ts` | 伴侣精灵介绍 |
| `src/constants/outputStyles.ts` | 三种输出风格 (default/Explanatory/Learning) |
| `src/utils/permissions/permissionExplainer.ts` | 权限解释 sidebar prompt |
| `src/utils/permissions/yoloClassifier.ts` | 自动模式分类器 prompt |

---

## 6. Prompt 组装流程

```
1. QueryEngine.ask()
     → fetchSystemPromptParts()
     → buildEffectiveSystemPrompt()

2. queryContext.fetchSystemPromptParts():
     → getSystemPrompt()          # constants/prompts.ts — 完整 system prompt 数组
     → getUserContext()           # context.ts — CLAUDE.md + date
     → getSystemContext()         # context.ts — git status

3. systemPrompt.buildEffectiveSystemPrompt():
     → Override → Coordinator → Agent → Custom → Default 逐层覆盖

4. query():
     → 组装 messages + attachments (attachments.ts)
     → prependUserContext + appendSystemContext

5. services/api/claude.ts:
     → buildSystemPromptBlocks() — 转为 Anthropic API content blocks + cache 注解
```

---

## 7. 对 wings 的参考价值

| wings 模块 | 参考源 | 关键内容 |
|-----------|--------|---------|
| `context/system_prompt.py` | `constants/prompts.ts` | system prompt 分段组装 |
| `tools/builtin/*.py` | `tools/*/prompt.ts` | 每个工具的描述文本和 LLM 使用说明 |
| `memory/store.py` | `memdir/memoryTypes.ts` + `memdir/memdir.ts` | 四类记忆分类、frontmatter 格式 |
| `services/compact.py` | `services/compact/prompt.ts` | compact 摘要 prompt |
| `context/claudemd.py` | `utils/claudemd.ts` | CLAUDE.md 加载、@include、条件规则 |
| `agent/loop.py` | `query.ts` | 消息组装 + context 注入 |
