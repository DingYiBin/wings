# Wings 项目实现状态

> 最后更新: 2026-07-20

## Python 实现（已完成）

| 模块 | 状态 | 文件数 | 测试数 | 说明 |
|------|------|--------|--------|------|
| messages | ✅ | 3 | ~20 | 统一消息类型 + Anthropic/OpenAI 双向转换 |
| routing | ✅ | 5 | 30 | API 候选池 + softmax 加权随机选择 + 任务继承链 |
| models | ✅ | 5 | 21 | Anthropic/OpenAI Provider, adaptive thinking, escalation |
| tools | ✅ | 13 | 34 | 11 内置工具: read/write/edit/bash/glob/grep/skill_view/agent/web_fetch/web_search/bing_search |
| query | ✅ | 2 | 13 | 指数退避重试, token 预算 (已接入 AgentLoop + compaction) |
| permissions | ✅ | 2 | 7 | 5 阶段管道: rules → scoped → classify → hooks → ask |
| agent | ✅ | 4 | 23 | AgentLoop per-call 模型选择, handoff, subagent (3 builtin + custom) |
| config | ✅ | 2 | 13 | 全局 + 项目 JSON 配置, deep merge |
| cli | ✅ | 4 | — | chat + run, /pool, /help, ctrl+o 展开, 权限 UI |
| skills | ✅ | 5 | 28 | 3 层加载 (builtin < user < project), SKILL.md |
| memory | ✅ | 4 | 8 | MEMORY.md 索引, 4 类型, 自动提取 (每 5 turn) |
| hooks | ✅ | 3 | — | Shell 命令 PreToolUse/PostToolUse, 集成 PermissionPipeline |
| mcp | ✅ | 2 | — | stdio transport, mcp__server__tool 命名, 自动注册 |

**Python 总计**: 58 源文件, ~7000 行代码, 283 测试, 13 模块

## TypeScript 重写 (完成)

> 计划文档: [`docs/design/ts-rewrite-plan.md`](ts-rewrite-plan.md)
> CLI 重构: [`docs/design/ink-cli-plan.md`](ink-cli-plan.md)

| 阶段 | 状态 | 测试数 | Commit |
|------|------|--------|--------|
| Phase 1: project init + messages + routing | ✅ | 57 | `4ce6745` |
| Phase 2: models (anthropic + openai) | ✅ | 20 (77 total) | `92b957e` |
| Phase 3: tools framework + 9 builtins | ✅ | 35 (112 total) | `16b52f0` |
| Phase 4: query + permissions | ✅ | 32 (144 total) | `1fc2c09` |
| Phase 5: agent loop + subagent + compaction | ✅ | 36 (180 total) | `c2e1148` |
| Phase 6: config + skills + memory + hooks + mcp | ✅ | 15 (195 total) | `1b113b5` |
| Phase 7: CLI (Ink v7 React TUI) | ✅ | — | `22a7615` |
| Phase 8: remove Python + cleanup | ✅ | — | — |

**TS 总计**: 276 测试, 15 测试文件, ~70 源文件. All phases complete.

### CLI (Ink v7, 3rdparty/ink)

- **Ink v7.1.0** as git submodule 
- React 19 + Ink v7 with `useInput` for keyboard handling
- Component tree: `App → REPL → Messages + PermissionDialog + PromptInput + StatusBar`
- Contextual status bar (Esc/Ctrl+C to stop, Ctrl+C twice to exit)
- Working indicator with animated dots + input/output char counts
- Throttled text display (100ms) with full response buffering
- Shared abort flag (`globalThis.__abortFlag`) for ESC/Ctrl+C propagation to subagents
- Arrow-key permission dialog reading from /dev/tty
- Readline fallback for non-TTY environments
| Phase 7: CLI + bootstrap (readline REPL) | ✅ | — | _(pending commit)_ |
| Phase 8: remove Python + cleanup | 🔲 | — | — |

**TS 进度**: 195 测试, 12 测试文件, ~70 源文件, Phases 1-7 完成。

## 内置工具 (11个)

| 工具 | 读/写 | 说明 |
|------|-------|------|
| read | 只读 | 文件读取, 二进制检测, read_cache |
| write | 写入 | 文件创建/覆盖, stale detection |
| edit | 写入 | 精确字符串替换, diff hunks |
| bash | 写入 | Shell 命令, denylist, sleep 阻止 |
| glob | 只读 | 文件名模式匹配 |
| grep | 只读 | 正则搜索, VCS 目录排除 |
| skill_view | 只读 | 加载 skill 内容 |
| agent | 写入 | 启动 subagent (sync + background) |
| web_fetch | 只读 | HTTP 请求, GBK/UTF-8 编码检测, 15min 缓存 |
| web_search | 只读 | DuckDuckGo 主 + Bing 备, 3 次重试 |
| bing_search | — | 内部使用, web_search 的 fallback |

## Subagent 类型

| 类型 | 工具 | 只读 | 来源 |
|------|------|------|------|
| general | 全部 (除 agent) | 否 | 内置 |
| explore | Read/Glob/Grep/SkillView | 是 | 内置 |
| plan | 全部 (除 Write/Edit/Agent) | 是 | 内置 |
| code-reviewer | Read/Glob/Grep | 是 | 自定义 (.wings/agents/) |
| memory-extractor | Write/Edit/Read/Glob/Grep | 否 | auto-extraction 内部使用 |

## 已知问题 (代码质量)

1. ~~**bootstrap.py monkey-patching**~~ ✅ 已修复 (commit `9a0e16d`, 改为正式 dataclass 字段)
2. **bare except**: 11 处 `except Exception` 分布在 cli/main(4), query/engine(2), mcp/loader(2), agent/loop(1), agent_loader(1), hooks/runner(1)。Web/fetch/search 里的合理，其他可改进。
3. **缺少测试覆盖**: hooks, mcp, memory extraction 没有单元测试。
4. ~~**extractor.py 未使用 import**~~ ✅ 误报 — `ModelRegistry`, `ModelSelector` 用作类型注解
5. ~~**cli/__init__.py**: 空文件~~ ✅ 已删除 (commit `9a0e16d`)
6. ~~**TokenBudget 未接入**~~ ✅ 已修复 (commit `7a1e653`, 接入 AgentLoop + compaction 服务)

## 下一步开发计划

> 详见 [`docs/reference/REFERENCE-SYNTHESIS.md`](../reference/REFERENCE-SYNTHESIS.md) — 12 个开源仓库的综合对照分析

### 阶段 4: 核心架构增强 (高优先级)

#### 4a. 权限系统重构
- [ ] **PermissionChain 分层模型**：Hook 预批准 > YOLO > 规则列表 > 会话持久 > 单次授权（参考 Crush）
- [ ] **精细作用域划分**：read/write/delete-in/out-cwd, network, mcp, git-log（参考 Deep Code）
- [ ] **sideEffects 声明**：模型执行 bash 前声明预期副作用（参考 Deep Code）
- [ ] **审批姿势切换**：Suggest / Auto / Bypass / Never 四种模式热键切（参考 CodeWhale）
- [ ] **bash 命令黑名单**：curl/wget/nc/telnet/ssh/kill/rm 等（参考 Crush）
- [ ] **MCP 安全白名单**：stdio 命令严格白名单（参考 AstrBot）

#### 4b. Agent Loop 状态机重构
- [ ] **显式状态机**：将当前 AgentLoop 重构为 TurnState 枚举 + 每状态 handler（参考 nanobot）
- [ ] **每会话异步锁 + 全局并发信号量**：同会话串行，跨会话并行
- [ ] **手动上下文压缩 `/compact`**：用户主动触发，可选摘要或截断（参考 DeerFlow）
- [ ] **Session Goals `--goal`**：结构化目标注入 system prompt + 达成检测（参考 DeerFlow）
- [ ] **极简 MessageBus**：模块间 async 双队列解耦（参考 nanobot）

#### 4c. 工具系统重构
- [ ] **FunctionTool/ToolSet 统一抽象**：解耦工具定义与 Provider schema 格式（参考 AstrBot）
- [ ] **工具并发安全标记**：concurrency_safe 标记 + RwLock 读写锁（参考 nanobot, CodeWhale）
- [ ] **工具自文档化**：.ts + .md 配对，模板渲染（参考 Crush）

#### 4d. LSP 集成
- [ ] **新建 `src/lsp/` 模块**：懒加载 LSP 客户端管理器
- [ ] **核心 LSP 工具**：lsp_definition / lsp_symbols / lsp_diagnostics（参考 Crush）

#### 4e. 交互模式
- [ ] **Plan / Act / Operate 三模式**：只读规划→多步执行→多任务编排，Tab 切换（参考 CodeWhale）

### 阶段 5: 功能增强 (中优先级)
- [ ] **Skills 元数据增强**：version / dependencies / tools / timeout / install / requires（参考 DeerFlow, OpenClaw）
- [ ] **DeepSeek V4 专属优化**：reasoning_effort 参数、差异化 compact 阈值（参考 Deep Code）
- [ ] **Provider Fallback 退路链**：主失败自动切备用（参考 nanobot）
- [ ] **路由别名系统**：模型别名解析 + 多 provider 同名路由（参考 CodeWhale）
- [ ] **Dream 记忆幻觉防护**：git diff 差异检查 + 自动回滚（参考 nanobot）
- [ ] **上下文压缩策略组合**：LLM 摘要 + 按轮次截断，不同模型不同阈值（参考 AstrBot, Deep Code）
- [ ] **动态 Prompt 组装**：角色指令/工具约束/记忆排序动态组合（参考 DeerFlow）
- [ ] **Hook 系统增强**：PreToolUse exit code 语义约定 + 多 Sink 可观测性（参考 Crush, CodeWhale）
- [ ] **Agent 工作空间引导文件**：SOUL.md / TOOLS.md / BOOTSTRAP.md / USER.md（参考 OpenClaw）
- [ ] **会话中切换模型**：保持上下文，仅换 provider 引用（参考 Crush）
- [ ] **Skills LLM 自动匹配**：低 temperature 判断哪些 skills 匹配意图（参考 Deep Code）
- [ ] **Cron 自然语言配置**：自然语言描述定时任务（参考 Hermes）
- [ ] **web_search `allowed_domains` / `blocked_domains` 过滤**
- [ ] **web_fetch 预批准域名列表**
- [ ] **更多内置 skills**（从 opensquilla 的 ~70 个中挑选）

### P6: 未来方向 (低优先级)
- [ ] **进程内 MCP 服务器**：将 wings 能力通过 MCP 暴露给其他工具（参考 Cherry Studio）
- [ ] **Fork subagent**：上下文继承, 最大化 prompt cache 命中
- [ ] **Plugin 系统**：加载外部包提供 tools/hooks，参考插件 SDK 契约设计（参考 OpenClaw）
- [ ] **Gateway + WebSocket 控制面**：CLI/Web/App 统一接入（参考 OpenClaw）
- [ ] **自主技能创建/改进闭环**：复杂任务后自动生成技能（参考 Hermes）
- [ ] **子 Agent Handoff 委托**：transfer_to_<name>，独立 provider + tools（参考 AstrBot）
- [ ] **Coordinator 双 Agent**：coder(large) + task(small) 分模型降成本（参考 Crush）
- [ ] **Landlock + seccomp 沙箱**：Linux 下轻量进程沙箱（参考 CodeWhale）
- [ ] **MCP 传输扩展**：SSE/HTTP transport, 不只是 stdio
- [ ] **Op/Event 分离架构**：命令查询分离，适合复杂 UI（参考 CodeWhale）
- [ ] **Summer 配置迁移工具**：全局/项目配置管理
