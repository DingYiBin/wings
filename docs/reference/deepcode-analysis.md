# Deep Code CLI 参考分析

> 分析日期: 2026-07-20
> 仓库: https://github.com/lessweb/deepcode-cli (v0.1.34)

## 项目概况

Deep Code CLI 是专为 DeepSeek-V4 模型优化的终端 AI 编码助手，TypeScript 编写，使用 React + Ink 构建 TUI。支持深度思考、推理强度控制、Agent Skills 以及 MCP 集成。

技术栈：TypeScript / Node.js 22+ / React 19 + Ink 7 / Zod 4 / esbuild / OpenAI SDK / npm workspaces

## 值得参考的功能

### 1. DeepSeek 专属优化

V4 模型自动默认启用 Thinking 模式，使用更高的 compact 阈值（512K tokens vs 默认 128K）。支持 `reasoningEffort: "high" | "max"` 控制。以 `extra_body` 方式传递思考配置。

**对 wings 的价值**：wings 的 DeepSeek provider 实现可以直接参考这些参数传递方式。

### 2. SessionManager 引擎设计

`SessionManager`（约 2900 行）是核心会话引擎，管理完整的 Agent Loop：
- `createSession` → 写入 System Prompt + 运行时上下文 + Agent 指南 + Skills 匹配 → `activateSession`
- `activateSession` 循环：权限检查→工具执行→token 检查→LLM 请求→解析响应→计算权限→执行工具
- 最大 80000 次迭代防止无限循环
- 会话持久化到 JSONL + sessions-index.json

**对 wings 的价值**：SessionManager 作为单引擎核心的集中式设计值得借鉴。

### 3. Skills 自动匹配引擎

使用独立的低 temperature（0.1）LLM 调用判断哪些 Skills 匹配当前用户意图。`response_format: { type: "json_object" }` 返回结构化结果。支持 `allow-implicit-invocation: false` 禁止自动加载。

**对 wings 的价值**：目前 wings 的 skills 是靠关键词匹配的，LLM 匹配更准确但成本更高。可做可选的精确匹配模式。

### 4. 精细权限系统

10 个权限作用域（read-in-cwd, read-out-cwd, write-in-cwd, write-out-cwd, delete-in-cwd, delete-out-cwd, query-git-log, mutate-git-log, network, mcp）。三层策略：`allow` / `deny` / `ask`。

Bash 工具的 `sideEffects` 机制：模型在执行 bash 命令时必须声明预期副作用，工具系统据此进行权限检查。

**对 wings 的价值**：`sideEffects` 声明机制是一个创新，可以在权限决策中提前预判命令风险。

### 5. Git 文件历史追踪

使用独立的 Git bare repo，每个 session 是一个 Git 分支。每次用户消息前自动创建 checkpoint，每次文件变更前后记录 checkpoint。支持代码恢复到任意 checkpoint。

**对 wings 的价值**：轻量级的文件版本追踪和 undo 支持方案。

### 6. 多层级配置合并

优先级：系统环境变量 > 项目级 settings.json > 项目级 env 块 > 用户级 settings.json > 用户级 env 块 > 硬编码默认值。使用 undici 的 keepAlive Agent 解决 CLI 交互场景的连接复用问题。

**对 wings 的价值**：配置合并策略和连接池管理可参考。

### 7. 后台命令执行

`run_in_background` 参数支持，输出写入 `/tmp/deepcode-background/`，可随时查看/停止。进程树管理确保 kill 时清理所有子进程。

**对 wings 的价值**：后台进程管理和进程树 kill 的实现值得参考。

### 8. 上下文压缩

当 token 超过阈值时自动触发 LLM 摘要压缩（DeepSeek V4: 512K，其他: 128K）。压缩后标记 `compacted=true`。

**对 wings 的价值**：不同模型使用不同 compact 阈值的策略值得采纳。

## 不建议参考的部分

| 功能 | 原因 |
|------|------|
| VSCode 插件（vscode-ide-companion） | wings 不是编辑器插件 |
| DeepSeek 独家优化 | wings 是多模型的 |
| JSONL 消息文件存储 | wings 已有 session 存储方案 |

## 优先级建议

1. **高优先**: 精细权限作用域划分 — 增强 wings 权限系统的精细度
2. **高优先**: Bash sideEffects 机制 — 预判命令风险
3. **中优先**: Skills LLM 匹配 — 可选的精确匹配模式
4. **中优先**: 不同模型的 compact 阈值策略
5. **低优先**: Git 文件历史追踪 — 需要时再实现
6. **低优先**: 后台命令执行方案
