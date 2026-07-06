# Wings 项目实现状态

> 最后更新: 2026-07-06

## 模块完成度

| 模块 | 状态 | 文件数 | 测试数 | 说明 |
|------|------|--------|--------|------|
| messages | ✅ | 3 | ~20 | 统一消息类型 + Anthropic/OpenAI 双向转换 |
| routing | ✅ | 5 | 30 | API 候选池 + softmax 加权随机选择 + 任务继承链 |
| models | ✅ | 5 | 21 | Anthropic/OpenAI Provider, adaptive thinking, escalation |
| tools | ✅ | 13 | 34 | 11 内置工具: read/write/edit/bash/glob/grep/skill_view/agent/web_fetch/web_search/bing_search |
| query | ⚠️ | 2 | 13 | 指数退避重试, token 预算 (TokenBudget 类存在但**未接入 AgentLoop**) |
| permissions | ✅ | 2 | 7 | 5 阶段管道: rules → scoped → classify → hooks → ask |
| agent | ✅ | 4 | 23 | AgentLoop per-call 模型选择, handoff, subagent (3 builtin + custom) |
| config | ✅ | 2 | 13 | 全局 + 项目 JSON 配置, deep merge |
| cli | ✅ | 4 | — | chat + run, /pool, /help, ctrl+o 展开, 权限 UI |
| skills | ✅ | 5 | 28 | 3 层加载 (builtin < user < project), SKILL.md |
| memory | ✅ | 4 | 8 | MEMORY.md 索引, 4 类型, 自动提取 (每 5 turn) |
| hooks | ✅ | 3 | — | Shell 命令 PreToolUse/PostToolUse, 集成 PermissionPipeline |
| mcp | ✅ | 2 | — | stdio transport, mcp__server__tool 命名, 自动注册 |

**总计**: 58 源文件, ~6500 行代码, 248 测试, 13 模块

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
6. **TokenBudget 未接入**: `query/token_budget.py` 有完整实现但 AgentLoop 未调用, 也没有 compaction 服务

## 下一步开发计划

> 详见 [`docs/design/dev-plan.md`](dev-plan.md)

### 阶段 1: Token Budget 集成 (最高优先级)
- [ ] ProviderConfig 加 `context_window` 字段
- [ ] ModelConfig 传递 context_window
- [ ] AgentLoop 每次 API call 前检查 `needs_compact()`
- [ ] 大 tool result 截断 (防止单次调用撑爆 context)

### 阶段 2: Compaction 服务
- [ ] `services/compact.py` — 摘要 prompt + 消息重组
- [ ] 触发后调用模型生成摘要, 替换历史消息
- [ ] 保留 system_prompt + 摘要 + 最近 N 条消息

### 阶段 3: 代码质量
- [ ] 给 hooks, mcp 添加基本单元测试
- [ ] bare except 审计改进 (非 web 模块加日志)

### 阶段 4: 功能增强
- [ ] web_search `allowed_domains` / `blocked_domains` 过滤
- [ ] web_fetch 预批准域名列表
- [ ] 更多内置 skills (从 opensquilla 的 ~70 个中挑选)
- [ ] Plugin 系统（加载外部 Python 包提供 tools/hooks）

### P5: 未来方向
- [ ] Fork subagent（上下文继承, 最大化 prompt cache 命中）
- [ ] 终端 TUI 升级（Rich 替代 Typer 的简单输出）
- [ ] Summer 配置迁移工具（全局/项目配置管理）
- [ ] MCP 传输扩展（SSE/HTTP transport, 不只是 stdio）

### Orchestrator-Worker 架构重构（重大方向）

> 详见 [`docs/design/orchestrator-design.md`](orchestrator-design.md)

将主 session 从扁平 agent loop 改为纯 orchestrator：主 agent 不再持有任何工具（仅 `agent` 工具），所有工具操作通过 subagent 分发执行。主 session 中只保留 subagent 的结构化报告，不再累积底层 tool result。

核心目标：
- **Context 不再膨胀**：主 session 只有 subagent 摘要，不是原始文件内容
- **多 API 池语义清晰**：`main` 池 = 规划模型，`subagent/<type>` 池 = 执行模型
- **显式失败恢复**：subagent 失败上报 → 主 agent 重新规划 → 换 subagent 重试

实现分 5 阶段（工具集裁剪 → 报告结构化 → 失败重规划 → 池语义重定义 → 移除扁平模式），保留 `orchestrator_mode` 开关以便对比和回退。
