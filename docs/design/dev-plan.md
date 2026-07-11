# 开发计划

> 创建: 2026-07-06
> 最后更新: 2026-07-06

## 已完成

### 阶段 1+2: Token Budget + Compaction (`7a1e653`)

**背景**: 用户实测发现 token_budget 集成是必须的。`TokenBudget` 类存在但未接入 AgentLoop，也没有 compaction 服务。

**已实现**:
- `ProviderConfig` / `ModelConfig` 加 `context_window` 字段（默认 200K），bootstrap.py 注册时传递
- `AgentLoop.run()` while 循环顶部检查 `needs_compact()`，超 80% 阈值触发 compaction
- 新建 `src/wings/services/compact.py` — `compact_messages()` 摘要旧消息，保留 system prompt + 最近 6 条
- `AgentLoop._compact_messages()` 调用 compaction 服务
- 大 tool result 超 20K 字符自动截断（`MAX_TOOL_RESULT_CHARS`）
- 9 个新测试（5 compaction + 4 token budget/truncation）

### 阶段 3: 代码质量 (`889e99a`)

**已实现**:
- 26 个新测试：hooks（15 个，覆盖 allow/deny/matcher/JSON override/post-tool-use/serialise_input）+ mcp（11 个，覆盖 config/tool adapter/error handling/loader edge cases）
- **修复真实 bug**: `_make_mcp_tool` 的 `description` 参数被类属性同名遮蔽导致 `NameError`——测试发现的，用 locals 捕获修复

**未做**: bare except 加日志（11 处中 web 模块的合理，其他优先级低，暂跳过）

## 当前测试状态

- 283 tests passing
- 13 模块全部 ✅
- `query` 模块从 ⚠️ 升级为 ✅（TokenBudget 已接入）

## 下一步开发计划

### 阶段 4: 功能增强（待做，按优先级排序）

#### 4.1 web_search 域名过滤
- `allowed_domains` / `blocked_domains` 参数
- 在 `web_search.py` 和 `bing_search.py` 的结果过滤层实现
- config.json 可配全局默认过滤

#### 4.2 web_fetch 预批准域名列表
- 类似 claude-code 的 ~100 个信任域
- 预批准域自动跳过权限询问
- config.json 可配 (`trusted_domains`)

#### 4.3 更多内置 skills
- 当前只有 3 个：commit / review-pr / simplify
- 从 opensquilla 的 ~70 个中挑选高价值的（如 pdf、test、document 等）
- 放入 `src/wings/skills/builtin/`

#### 4.4 Plugin 系统
- 加载外部 Python 包提供 tools/hooks
- 入口点：`wings.plugin` group
- 类似 claude-code 的 plugin 机制

### P5: 远期方向

- Fork subagent（上下文继承，最大化 prompt cache 命中）
- 终端 TUI 升级（Rich 替代当前简单输出）
- 配置迁移工具
- MCP 传输扩展（SSE/HTTP，不只是 stdio）

## 验证标准

- [x] `uv run pytest tests/ -q` 全过（283 passing）
- [x] `uv run mypy src/` 无新错误（仅预存的 settings.py 2 个）
- [x] `uv run ruff check src/ tests/` 无新错误（仅预存的 bootstrap.py line-length）
- [ ] 手动测试: 长对话触发 compaction, 摘要后能继续正常工作
