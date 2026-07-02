# OpenSquilla — Prompt 体系分析

## 总览

OpenSquilla 的 prompt 体系比 claude-code 更复杂，核心差异在于：
- **Jinja2 模板驱动**的 system prompt（而非代码拼接字符串）
- **6 层身份文件**（BOOTSTRAP / AGENTS / SOUL / IDENTITY / USER / TOOLS）
- **67 个技能的 SKILL.md**，每个都是一套子 agent system prompt
- **Meta-skill SOP 编译器** — 将自然语言工作流编译为 DAG + prompt
- **离线记忆巩固 (Dream)** — 背景 LLM 驱动的 MEMORY.md 维护

---

## 1. 主 System Prompt

### 核心文件

| 文件 | 说明 |
|------|------|
| `identity/templates/system_prompt.j2` | **319 行 Jinja2 模板**，条件渲染所有 system prompt section |
| `identity/prompt.py` | `assemble_system_prompt()` — 模板渲染入口 |

### System Prompt Sections (全部条件渲染)

```jinja2
## Product Identity    — 产品名、品牌
## Persona             — SOUL.md 内容注入
## Available Tools     — 工具名列表
## Tool Call Style     — 叙述风格、工具调用规则
## Web Research Tools  — web_search, web_discover, web_fetch 指引
## Generated File Delivery — publish_artifact + 文件创作规则
## Tool Boundary       — sessions_send vs message 区别
## Data Accuracy       — 电子表格和计算规则
## Image Generation    — 图片生成指引
## Memory Recall       — memory_search, memory_get 使用
## Memory Write Guidance — 文件型记忆写入规则
## Safety              — 自保、人类监督
## CLI Quick Reference  — 命令行参考
## Memory              — 记忆块内容注入
## Documentation       — docs_path 引用
## Model Aliases       — 模型别名
## Current Date & Time — 时区
## Workspace           — 工作目录
## Authorized Senders  — 授权发送者
## Reply Tags          — 回复标签
## Messaging           — 消息格式
## Reactions           — 反应
## Reasoning Format    — 推理格式
## Silent Replies      — NO_REPLY, HEARTBEAT_OK 哨兵
## Heartbeats          — heartbeat_prompt 内容
## Runtime             — OS, Shell
## Reply Guidelines    — 回复指南
```

### 三种 prompt_mode

| Mode | 用途 |
|------|------|
| `full` | 首次启动 + 长 session |
| `minimal` | 会话恢复（已知道大部分上下文） |
| `none` | 不发送 system prompt（调试/测试） |

### wings 对应

`context/system_prompt.py` — 参考 Jinja2 模板的分段渲染和 prompt_mode 概念

---

## 2. 身份/引导文件系统 (Bootstrap)

**位置**: `src/opensquilla/identity/templates/bootstrap/`

| 文件 | 类型 | 内容 |
|------|------|------|
| `BOOTSTRAP.md` | 一次性引导 prompt | 首次设置对话指令：询问名称/语气/偏好/边界 → 存入对应文件 → 自删除 |
| `AGENTS.md` | 操作规则 | 工作区规则：启动读 SOUL.md/USER.md/TOOLS.md、拆小改动、事实存正确文件 |
| `SOUL.md` | 声音/人格模板 | 持久化语气、语调、交互风格占位符，注入 system prompt 的 `## Persona` |
| `IDENTITY.md` | 身份模板 | 公开名称、emoji、生物、氛围、主题、头像 |
| `TOOLS.md` | 工具约定 | 工作区特定工具模式、路径、命名快捷方式 |
| `USER.md` | 用户档案 | 稳定用户信息：姓名、地址、代词、时区，私有 agent 会话注入上下文 |
| `MEMORY.md` | 长期记忆 | 策划的持久化事实、偏好、决策、约束 |
| `HEARTBEAT.md` | 心跳节奏 | 定期任务配置（YAML frontmatter），心跳轮询时注入为实时上下文 |

### 加载方式

`identity/bootstrap.py` 在 agent 创建时将模板写入工作区目录。
`engine/context.py` 的 `load_context_files()` 在运行时读取。

### wings 对应

`context/` 模块可以借鉴多文件分离的设计——不把所有上下文塞进一个 system prompt，而是 AGENTS/TOOLS/SOUL 分开管理。

---

## 3. Skill SKILL.md 文件

### 位置结构

```
skills/bundled/<skill-name>/SKILL.md   # 67 个内置技能
skills/exp/<skill-name>/SKILL.md       # 22 个实验技能
```

### SKILL.md 格式

```markdown
---
name: my-skill
description: What this skill does
kind: skill          # "skill" 或 "meta"
triggers:            # (meta 技能) 自然语言触发短语
  - "do X for me"
metadata:
  opensquilla:
    platforms: [cli, chat]
    requirements: "user needs X installed"
    emoji: 🔧
---

(skill body — markdown 指令，作为子 agent system prompt)
```

### 完整内置技能列表 (67 个)

**文件格式**: `advanced-dubbing-studio`, `ai-video-script`, `audio-cog`, `awesome-webpage-image-download`, `awesome-webpage-research`, `AwesomeWebpageMetaSkill`, `code-task`, `cron`, `deep-research`, `docx`, `filesystem`, `git-diff`, `github`, `history-explorer`, `html-coder`, `html-to-pdf`, `http-fetch`, `latex-compile`, `memory`, `meta-kid-project-planner`, `meta-paper-write`, `meta-skill-creator`, `meta-short-drama`, `multi-search-engine`, `music-and-singing-studio`, `nano-banana-pro`, `nano-banana-pro-openrouter`, `nano-pdf`, `openrouter-video-generator`, `paper-abstract-author`, `paper-citation-planner`, `paper-experiment-stub`, `paper-outline-author`, `paper-plot-stub`, `paper-preference-planner`, `paper-refbib-stub`, `paper-revision-author`, `paper-section-author`, `paper-source-curator`, `pdf-toolkit`, `pptx`, `seedance-2-prompt`, `skill-creator`, `skill-creator-linter`, `skill-creator-proposals`, `skill-creator-smoke-test`, `srt-from-script`, `stack-trace-generic-probe`, `stack-trace-go-probe`, `stack-trace-js-probe`, `stack-trace-python-probe`, `stack-trace-rust-probe`, `sub-agent`, `subtitle-burner`, `summarize`, `swe-bench`, `text-file-read`, `title-card-image`, `tmux`, `video-merger`, `video-still-animator`, `voice-clone-lab`, `voice-conversion-studio`, `voiceover-studio`, `web-search`, `weather`, `xlsx`

### 技能注入方式

`skills/injector.py` 的 `SkillInjector` 提供三种方法：
- `inject_full(system_prompt, skills)` — XML 块: `<skill kind="..."><name>...</name><description>...</description><location>...</location></skill>` + `## Skills` 头解释 `skill_view` 和 `meta_invoke`
- `inject_compact(system_prompt, skills)` — 仅名称 XML 块（省 token）
- `inject_skills(system_prompt, skills, max_chars=30000)` — 按预算自动选择 full/compact

注入时机：`pipeline steps/skills_filter.py` 门控+过滤技能 → 调用 SkillInjector → 追加到 system prompt 的 uncached suffix。

### wings 对应

`skills/loader.py` 加载 SKILL.md → `skills/injector.py` 注入 system prompt

---

## 4. Meta-Skill SOP 系统

### SOP 编译器

**文件**: `skills/meta/sop_compiler.py`

将 `kind: meta_sop` 的 SKILL.md 编译为 `kind: meta` + `composition_raw`。

**SOP 语法**:
```markdown
## Phase 1: Research [parallel]
Run `http-fetch` as agent
- url: {{inputs.url}}
Save as `research`

## Phase 2: Analysis [depends_on: Research]
Invoke `deep-research` as skill_exec
- topic: {{outputs.research.summary}}
```

**编译阶段**: `_lex` (分词) → `_parse` (AST) → `_resolve` (类型推断) → `_emit` (DAG YAML)

### 模板引擎

**文件**: `skills/meta/templating.py`

受限 `jinja2.sandbox.ImmutableSandboxedEnvironment`，allowlist 过滤器: `xml_escape`, `truncate`, `slugify`, `tojson`, `default`, `length`, `join`, `lower`, `extract_path`, `contains_cjk`, `int`。

所有 meta-skill DAG 步骤的 `with_args` 值都通过 Jinja2 渲染，输入来自 `inputs` + `outputs`。

### 子 agent 执行器

| Executor | System Prompt |
|----------|--------------|
| `agent.py` | SKILL.md body (含 `{baseDir}` 展开) + `language_instruction` |
| `llm_classify.py` | "You are a deterministic classifier... Reply with EXACTLY ONE of: ..." |
| `llm_chat.py` | "You are a precise workflow step. Reply only with the requested deliverable." |
| `tool_call.py` | "Invoke the '<tool>' tool exactly once... After the tool returns, reply with its result as plain text." |

### 表单提取

- `clarify_nl_extract.py` — LLM 提取用户回复中的字段值 (JSON)，白名单防注入
- `clarify_autofill.py` — LLM 自动填充必填但不完整的表单字段
- `clarify_text.py` — 确定性文本解析 (多语言字段名匹配)

---

## 5. 预 Turn 管道中的 Prompt 注入步骤

**管道主文件**: `engine/pipeline.py` — `run_pipeline(ctx, steps)` 按序执行，fail-open 语义

TurnContext 携带 `system_prompt: str | tuple[str, str]` (tuple = (cacheable_base, uncached_suffix))

| 步骤文件 | 函数 | 注入内容 |
|---------|------|---------|
| `steps/inject_subagent_grounding.py` | 子 agent 前缀 | "You are a subagent..." |
| `steps/inject_platform_hint.py` | 频道渲染提示 | `## Channel Rendering` 块 (平台特定 Markdown 说明) |
| `steps/coding_mode.py` | 编码模式指令 | ~200 行 coding mode 指引 (repo 修复、scratch 代码、task-file staging) |
| `steps/meta_resolution.py` | Meta-skill 激活提示 | `## Meta-skill activation guidance` — 触发匹配 + 语义相似度候选 |
| `steps/skills_filter.py` | 技能列表注入 | `<available_skills>` XML 块 + `skill_view` 协议说明 |
| `steps/inject_time_prefix.py` | 时间戳 | `[YYYY-MM-DDTHH:MM±HH:MM Day TZ_NAME]` 前缀 |
| `steps/prompt_cache.py` | 缓存控制 | 配置 Anthropic prompt caching 断点 |
| `steps/vision_followup_gate.py` | 视觉控制 | 门控视觉能力 |

### wings 对应

`agent/loop.py` 的 `_assemble_messages()` 可以设计为类似的管道模式：每一步注入一部分 context。

---

## 6. 记忆相关 Prompt

### 6.1 记忆刷新 (Session Flush)

**文件**: `memory/flush.py`

| 模板 | 内容 |
|------|------|
| `FLUSH_SYSTEM_PROMPT_TEMPLATE` | "Pre-compaction memory flush. Store durable memories only in {relative_path}..." |
| `FLUSH_USER_PROMPT_TEMPLATE` | "Below is a transcript excerpt... Review it and save any important context... Fidelity rules: Preserve atomic facts, Resolve relative dates..." |
| `SILENT_REPLY_TOKEN` | `[SILENT_REPLY_TOKEN]` — 无需存储时的信号 |

### 6.2 Dream (离线记忆巩固)

**文件**: `memory/dream/runner.py` + `memory/dream/prompts.py`

`promotion_patch_prompt(current_memory_md, candidates)` 构建：
```
You are updating OpenSquilla MEMORY.md as curated long-term memory.
Return JSON only with an operations array.
Allowed operations: upsert / merge / skip
Current MEMORY.md: <<<...>>>
Ranked candidates: <candidate_id, score, reasons, snippet>
JSON:
```

**Dream 管道**:
1. 扫描自 cursor 以来的新文件 → 2. 证据评分 → 3. 排序 → 4. 回水化 → 5. 运行 promotion patch (LLM) → 6. 解析 JSON → 7. 策划应用到 MEMORY.md

---

## 7. 其他 Prompt

### 压缩 Prompt

**文件**: `session/compaction.py`

- System: "You are a conversation compactor. Summarize the conversation concisely, preserving key facts, decisions, open questions, and action items..."
- User: "Summarize this conversation:\n\n<chunk_text>"

`session/compaction_state.py`:
- `extract_compaction_obligations()` — 压缩前从转录中确定性提取目标、约束、决策、工件、错误、标识符
- `build_structured_summary_from_text()` — 包装 LLM 摘要 + 提取的义务
- `render_structured_summary()` — 渲染为模型可读文本

### 会话命名 Prompt

**文件**: `session/naming.py`

```
You are a session title generator. Output ONLY a concise 3-6 word title...
No quotes, no trailing punctuation, no markdown, no prefixes, no explanation.
```

### SWE-Bench Prompt

**文件**: `contrib/swebench/prompt.py`

`build_prompt(instance)` — 从 SWE-bench 实例渲染 prompt，使用外部 Jinja2 模板。

### 频道渲染提示

**文件**: `channels/registry.py`

`markdown_render_hint_for(type_name)` — 返回频道特定 prompt 文本，告诉 LLM 如何格式化回复（针对不支持 Markdown 的频道）。

---

## 8. 完整 Prompt 组装流程

```
1. bootstrap.py 将 identity 文件 (SOUL.md, AGENTS.md 等) 写入工作区

2. TurnRunner._assemble_prompt() (runtime.py):
   a. 从 snapshot cache 加载工作区上下文文件
   b. 加载 daily notes + recall snippets
   c. 调用 identity.prompt.assemble_system_prompt() + AgentProfile
   d. 渲染 system_prompt.j2 Jinja2 模板
   e. 返回 (cacheable_base, uncached_suffix) 或单一 str

3. PromptAssemblerStage.run():
   a. 调用 _assemble_prompt
   b. 获取 router context
   c. 运行预 turn 管道步骤:
      - inject_subagent_grounding (如有)
      - inject_platform_hint (频道渲染)
      - enforce_coding_mode (如有)
      - meta_resolution (meta-skill 提示)
      - filter_skills (技能注入)
      - apply_prompt_cache (缓存断点)
      - inject_time_prefix (时间戳)
      - resolve_model (路由)
   d. 解析最终 prompt + 缓存断点
   e. 构建 PromptReport (可观测性)

4. AgentBootstrapStage:
   a. AgentConfig.system_prompt = 最终 prompt
   b. 构造 Agent 实例

5. Agent.run_turn() 将 system_prompt 发送给 LLM provider
```

---

## 9. 对 wings 的参考价值

| wings 模块 | 参考源 | 关键内容 |
|-----------|--------|---------|
| `context/system_prompt.py` | `identity/templates/system_prompt.j2` + `identity/prompt.py` | Jinja2 分段模板、prompt_mode |
| `context/bootstrap.py` | `identity/templates/bootstrap/` | 多文件身份系统 (AGENTS/SOUL/USER/TOOLS) |
| `skills/loader.py` | `skills/loader.py` + `skills/types.py` | SKILL.md YAML frontmatter 解析 |
| `skills/injector.py` | `skills/injector.py` | full/compact 模式、XML 技能列表注入 |
| `skills/meta/` | `skills/meta/orchestrator.py` + `sop_compiler.py` | DAG 工作流 → prompt 编译 |
| `agent/pipeline.py` | `engine/pipeline.py` + `engine/steps/` | 预 turn 管道步骤链 |
| `memory/flush.py` | `memory/flush.py` | 会话刷新 prompt (Fidelity rules 值得借鉴) |
| `memory/dream.py` | `memory/dream/runner.py` + `memory/dream/prompts.py` | 离线记忆巩固 (Phase 2) |
| `session/compact.py` | `session/compaction.py` | 压缩 prompt + 义务提取 |
