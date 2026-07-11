# OpenCode — Prompt 体系分析

## 总览

OpenCode 的 prompt 体系分四层：**主 System Prompt** → **工具描述** → **Session Context** → **模型专属 Prompt 模板**。与 Claude Code 和 OpenSquilla 相比，OpenCode 更强调**按模型系列定制 prompt**。

---

## 1. 主 System Prompt

### 核心文件

| 文件 | 说明 |
|------|------|
| `packages/opencode/src/session/prompts/` | 每个模型的独立提示模板（.txt 文件） |
| `packages/opencode/src/session/llm/` | LLM 集成层（AI SDK + 自定义运行时） |

### 模型专属 Prompt 模板

OpenCode 将 system prompt 拆分为按模型优化的独立文件：

```
packages/opencode/src/session/prompts/
├── anthropic.txt      # Claude 系列 (XML 标签风格)
├── gemini.txt         # Gemini 系列
├── gpt.txt            # GPT 系列 (markdown 风格)
├── codex.txt          # OpenAI Codex
├── kimi.txt           # Kimi
├── meta.txt           # Llama 系列
├── trinity.txt        # Trinity
└── beast.txt          # Beast
```

每个模板针对特定模型系列的 behavior 特性优化 prompt 风格、工具描述格式和交互模式。

### Prompt 组装流程

```
1. 用户输入
2. 构建消息列表 (buildMessages)
3. 选择模型 → 加载对应 prompt 模板
4. 注入工具描述:
   - 读取所有已注册工具的描述
   - 动态构建工具列表（根据启用状态过滤）
   - 注入工具使用说明
5. 注入 session context:
   - 项目配置
   - 工作目录信息
   - 环境变量
   - 历史消息摘要 (如需要)
6. 调用 LLM API
```

---

## 2. 工具描述 Prompts

### 位置

`packages/opencode/src/tool/` — 工具定义包含 prompt 模板文件（.txt）：

```
packages/opencode/src/tool/
├── bash/
│   └── prompt.txt
├── read/
│   └── prompt.txt
├── write/
│   └── prompt.txt
├── edit/
│   └── prompt.txt
├── glob/
│   └── prompt.txt
├── grep/
│   └── prompt.txt
├── web_search/
│   └── prompt.txt
├── web_fetch/
│   └── prompt.txt
├── agent/
│   └── prompt.txt
└── ...
```

### 工具描述注入方式

1. 每个工具定义包含 `description`（简短）和 `prompt`（详细使用说明）
2. 工具注册时收集所有 prompt 文本
3. 系统 prompt 组装时，工具提示作为独立 section 注入
4. 工具描述注入位置取决于模型系列（不同模板有不同的注入位置）

### 工具元数据驱动的描述

工具接口自带丰富的自描述属性，自动影响 prompt 生成：

| 属性 | 作用 |
|------|------|
| `isReadOnly` | 只读工具 — 不加 confirm 提示 |
| `isDestructive` | 破坏性工具 — 添加警告说明 |
| `isConcurrencySafe` | 可并发工具 — 提示模型可同时调用 |
| `isEnabled` | 禁用工具不生成 prompt |

---

## 3. Session Context 注入

### 上下文来源

| 来源 | 内容 | 位置 |
|------|------|------|
| 项目配置 | `.opencode` 项目设置 | `packages/core/src/config/` |
| 工作区信息 | CWD、OS、Shell、Git 状态 | `packages/core/src/session/context/` |
| 系统上下文 | 环境变量、运行时信息 | `packages/core/src/system-context/` |
| 附件 | 用户附加的文件/引用 | `packages/core/src/session/` |
| 会话历史 | 之前的消息 | 数据库持久化 |

### 注入时机

- **Pre-turn**: 每次 LLM 调用前组装完整 context
- **Attachment stage**: 文件附件转换为 LLM 兼容消息格式
- **Compaction**: 上下文压缩时保留关键信息

---

## 4. 模型专属 Prompt 策略

### 按模型系列定制

不同模型系列有不同的 prompt 风格要求：

| 模型系列 | Prompt 风格 | 工具描述格式 |
|----------|------------|-------------|
| Claude (Anthropic) | XML 标签 (`<tool>...</tool>`) | XML-like block |
| GPT (OpenAI) | Markdown / JSON | JSON schema |
| Gemini (Google) | 结构化文本 | Markdown 列表 |
| Llama (Meta) | 简洁指令 | 短描述 |

### Provider 适配层

`packages/llm/` 中的 provider 实现负责：
- 协议特定消息格式转换（Anthropic Messages API, OpenAI Chat API, Bedrock Converse 等）
- Prompt 缓存优化（Anthropic prompt caching）
- 工具描述序列化
- 流式响应处理

---

## 5. 专用 Prompt

### 5.1 Compact (上下文压缩)

`packages/core/src/session/compaction/` — 会话压缩 prompt：
- 当上下文接近限制时自动触发
- 压缩旧消息为摘要
- 保留关键决策、事实、待办事项
- 支持增量压缩（仅压缩最早的部分）

### 5.2 Sub-agent Prompt

`packages/opencode/src/agent/` — 子代理 prompt：
- compaction agent：压缩专用 prompt
- explore agent：只读探索 prompt
- title agent：会话命名 prompt
- 通用子代理 prompt（继承父会话的工具集）

### 5.3 权限 Prompt

`packages/opencode/src/session/permissions.ts` — 权限确认对话框的 prompt 文本：
- 描述待执行的操作
- 列出影响的文件/资源
- 提示用户确认/拒绝/总是允许

---

## 6. 对 wings 的参考价值

| wings 模块 | 参考源 | 关键内容 |
|-----------|--------|---------|
| `context/system_prompt.py` | `packages/opencode/src/session/prompts/*.txt` | 按模型系列分拆 prompt 模板 |
| `tools/builtin/*.py` | `packages/opencode/src/tool/*/prompt.txt` | 工具使用说明的 prompt 文本 |
| `services/compact.py` | `packages/core/src/session/compaction/` | 压缩摘要 prompt |
| `agent/subagent.py` | `packages/opencode/src/agent/` | 子代理专用 prompt |
| `provider/` | `packages/llm/` | 按协议/提供商适配 prompt 格式 |
