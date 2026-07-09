# Session Title
_Wings — Multi-model AI agent CLI exploration_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed._

The Wings project (TypeScript rewrite) has completed Phases 1-7 (project init → CLI REPL). Phase 8 (remove Python + cleanup) is pending. Key modules implemented: messages, routing (softmax-weighted pool selection), models (Anthropic/OpenAI), tools (10 builtins), query (retry, token budget), permissions (4-stage pipeline), agent loop, subagents (3 builtin + custom), config, skills (3-layer), memory, hooks, MCP, CLI (raw mode REPL), session memory, and compaction.

# Task specification
_What did the user ask to build? Design decisions and context._

Wings is a multi-model AI agent CLI. Every API call independently selects a model from a task-type-specific candidate pool via softmax-weighted random selection. Users score models per task type. Built as TypeScript on Node.js, tests on Bun. Python legacy implementation exists alongside.

Design principles: API candidate pool, everything is a tool, protocol-driven boundaries. Module dependency chain: messages/routing → models → tools → query/permissions → agent → config/skills/memory/hooks/mcp → cli.

# Files and Functions
_Important files — what they contain and why they're relevant._

- **src/index.ts**: CLI entry point, parses args, dispatches to runChat/runSingle
- **src/cli/main.ts**: Raw-mode REPL (grapheme-aware backspace), permission dialog via /dev/tty, command handler (/pool, /help), fallback readline
- **src/cli/bootstrap.ts**: Composition root — wires all modules (pool manager, registry, skills, tools, permissions, hooks, MCP, agent tool, memory extraction callback)
- **src/agent/loop.ts**: AgentLoop with async generator, per-call model selection, tool execution with large result persistence (50K chars → disk), aggregate tool result budget (200K chars/message), compaction trigger at 80% context window
- **src/agent/subagent.ts**: 3 builtin subagents (general/explore/plan), tool filtering by allowlist/denylist/read-only, isolated AgentLoop per subagent
- **src/agent/handoff.ts**: Model handoff detection between turns (first cycle only)
- **src/services/session-memory.ts**: Per-conversation structured notes (summary.md), template matching claude-code, thresholds (10K tokens to init, 5K between updates, 3 tool calls), extraction via forked subagent, compaction integration
- **src/services/compact.ts**: Compaction service — summarizes old messages preserving system prompt + recent 6 messages, tries session memory first, falls back to model summarization
- **src/routing/manager.ts**: APIPoolManager (global pool + per-task-type masks, softmax selection, task inheritance chain, forkMask)
- **src/routing/selector.ts**: softmaxSelect() with NEG_INF handling
- **src/routing/tasks.ts**: TASK_HIERARCHY — subagent types inherit from parent pools
- **src/models/anthropic.ts**: Anthropic provider (streaming, thinking blocks, max_tokens escalation 8K→64K)
- **src/models/openai.ts**: OpenAI provider (streaming, tool calls)
- **src/models/registry.ts**: ModelRegistry — register builds ModelConfig, buildConfig for query engine
- **src/tools/builtin/**: 10 tools — read/write/edit/bash/glob/grep/skill_view/agent/web_fetch/web_search
- **src/permissions/pipeline.ts**: 4-stage pipeline: rules → scoped → classify → hooks → ask
- **src/config/settings.ts**: 2-file JSON deep merge (global ~/.wings/config.json + project .wings/config.json), env var API keys
- **src/memory/**: MEMORY.md index + per-topic files, auto-extraction every 5 turns
- **src/hooks/**: Shell command lifecycle hooks (PreToolUse/PostToolUse with JSON stdin)
- **src/mcp/**: MCP client with stdio transport
- **src/skills/**: 3-layer SKILL.md discovery (builtin < user < project)

# Workflow
_What bash commands are usually run? How to interpret their output?_

```bash
# Install
npm install

# Run (Node.js + tsx)
node --import tsx src/index.ts chat          # interactive REPL
node --import tsx src/index.ts run "prompt"  # single turn
node --import tsx src/index.ts chat --log    # with JSONL logging

# Tests (Bun)
bun test                       # ~228 tests
bun test tests/ts/agent.test.ts  # single file
bun x tsc --noEmit             # type-check

# Python (legacy)
uv sync --extra dev
uv run pytest tests/ -q        # 283 tests
uv run ruff check src/ tests/
uv run mypy src/

# Chat commands
/pool              # view API candidate pool scores
/pool up|down <api> # adjust score by ±0.5
```

# Errors & Corrections
_Errors encountered and how they were fixed. Approaches that failed._

- **Permission deadlock**: AgentLoop must set `_permResolve` BEFORE yielding PermissionRequest; CLI reads from /dev/tty which calls setPermissionResponse before generator advances
- **Python bootstrap monkey-patching**: Fixed by replacing with formal dataclass fields (commit 9a0e16d)
- **TokenBudget not wired**: Was implemented but not connected to AgentLoop or compaction — fixed (commit 7a1e653)
- **MCP NameError**: `_make_mcp_tool` description param shadowed by class attribute — fixed with locals() capture (discovered by test)
- **Bare except**: 11 instances of bare `except` across cli/main, query/engine, mcp/loader, agent/loop — web/fetch/search ones are reasonable, others low priority

# Codebase and System Documentation
_Important system components and how they fit together._

**Architecture**: Module dependency chain — messages/routing → models → tools → query/permissions → agent → config/skills/memory/hooks/mcp → cli.

**API Pool (routing/)**: APIPoolManager holds global entries (api_id → base score) + per-task-type masks (delta adjustments). `select(taskType)` resolves mask via inheritance chain (TASK_HIERARCHY), then softmaxSelect() draws weighted random. `forkMask()` copies parent pool for new task types.

**Agent Loop (agent/loop.ts)**: Async generator. Each cycle: select model → check token budget (compact if >80%) → stream response → execute tools → aggregate results → loop. Handoff detection on first cycle only. Large tool results (>50K chars) persisted to `.wings/tool-results/`. Aggregate budget 200K chars/message.

**Subagents (agent/subagent.ts)**: 3 builtin types — general (full tools), explore (r/o read/glob/grep/skill_view), plan (r/o all but write/edit/agent). Custom agents from `.wings/agents/*.md`. Each subagent runs isolated AgentLoop. Tool filtering: explicit allowlist, disallowed list, read-only safety belt, anti-recursion.

**Session Memory (services/session-memory.ts)**: Template with 10 sections. Thresholds: 10K tokens to init, 5K growth between updates, 3 tool calls. Extraction runs via forked session-memory subagent (tools: write/edit/read/glob/grep only). Used by compaction as primary summary source.

**Permissions (permissions/)**: 4-stage: static rules → scoped allow/deny → auto-classify read-only → hooks → interactive arrow-key dialog via /dev/tty.

**Tools (tools/builtin/)**: buildTool() factory with Zod schemas. Stale detection (read/write require prior read via read_cache). Scope suggestion extracts command prefix for bash, directory for write/edit.

**Models (models/)**: Anthropic + OpenAI adapters. Config: model, protocol, api_key, base_url, max_tokens (8K), escalated_max_tokens (64K), thinking (true), thinking_budget, context_window (200K).

# Learnings
_What has worked well? What to avoid? Don't duplicate other sections._

- **Interface-driven boundaries** (ModelSelector, ModelProvider, Tool, HookRunner) enable clean module separation
- **Tool result grouping**: All tool_results for one assistant response collected into single user message
- **Permission sync**: Promise resolver pattern with `_permResolve` set BEFORE yield prevents deadlock with /dev/tty reads
- **Session memory** as compaction source reduces model summarization calls
- **Softmax selection** per API call is the core differentiator from other agent frameworks
- Large tool results persisted to disk with preview keeps context window clean

# Key results
_Exact answers to user questions, tables, or other output._

- **TypeScript**: 15 test files, ~228 tests passing, ~70 source files
- **Python (legacy)**: 58 source files, ~7000 LOC, 283 tests, 13 modules
- **Built-in tools**: 10 (read/write/edit/bash/glob/grep/skill_view/agent/web_fetch/web_search)
- **Built-in subagent types**: 3 (general, explore, plan)
- **TS rewrite phases**: 7 of 8 complete (Phase 8: remove Python + cleanup pending)
- **Design docs available**: architecture.md, modules.md, status.md, dev-plan.md, orchestrator-design.md, tool-comparison.md, ts-rewrite-plan.md

# Worklog
_Step by step, what was attempted and done. Terse summary per step._

- **Phase 1-7 (TS rewrite)**: Implemented all core modules — messages, routing, models, tools, query, permissions, agent loop, subagents, config, skills, memory, hooks, MCP, CLI, session memory, compaction. 228 tests passing.
- **Phase 8 pending**: Remove Python legacy code, cleanup, final merge.
- **Status document (status.md)**: Tracks Python (13 modules ✅, 283 tests) and TS (Phases 1-7 ✅, 195-228 tests depending on count) implementation status.
- **Dev plan (dev-plan.md)**: Outlines Phase 4 (web search domain filter, web_fetch trusted domains, more builtin skills, plugin system) and Phase 5 (Orchestrator-Worker architecture).
- **Session memory system**: Implemented in `src/services/session-memory.ts` — template, thresholds, subagent-based extraction, compaction integration. Mirrors claude-code pattern.
- **Compaction service**: Implemented in `src/services/compact.ts` — tries session memory first, falls back to model summarization, preserves system prompt + recent 6 messages.
