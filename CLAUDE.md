# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Essential commands

```bash
# Python (existing)
# Install (including dev deps)
uv sync --extra dev

# Run all tests (248 passing)
uv run pytest tests/ -q

# Run a single test file
uv run pytest tests/test_skills.py -v

# Run a specific test
uv run pytest tests/test_skills.py::test_loader_discovers_skills -v

# Lint
uv run ruff check src/ tests/

# Type-check
uv run mypy src/

# Run wings itself (after install)
wings chat                   # interactive REPL
wings run "prompt"           # single turn
wings chat --log             # with logging to .wings/logs/

# TypeScript (rewrite in progress)
bun test                          # run all TS tests (144 passing)
bun test tests/ts/                # same, scoped
bun x tsc --noEmit                # type-check
bun run src/index.ts chat          # REPL (WIP)
bun run src/index.ts run "prompt"  # single turn (WIP)

# Chat commands
/pool                        # view and adjust API candidate pools
/pool up|down <api>          # adjust score by ±0.5
ctrl+o                       # expand truncated tool result in pager

# Init reference repos (required for /init)
bash scripts/init-references.sh
```

## Architecture

Wings is a **multi-model AI agent** where every API call independently selects a model from a task-type-specific candidate pool via softmax-weighted random selection. This is the core differentiator — users manage pools by scoring APIs per task type.

**Module dependency chain**: `messages`/`routing` (no deps) → `models` (messages + routing) → `tools` (no deps) → `query` (models + messages + tools) → `permissions` (tools) → `agent` (all) → `config`/`skills` (routing/tools) → `cli` (all).

**Key modules**:

- `routing/` — `APIPoolManager` (global pool + per-task-type score masks, softmax selection). Implements `ModelSelector` Protocol so AgentLoop only depends on the protocol.
- `agent/loop.py` — `AgentLoop.run()` is the main loop. Model selection happens **per API call** (inside the `while True` tool-execution loop), not per turn. Handoff detection runs on the first cycle only. Permission requests use `asyncio.Event` to pause for user input.
- `tools/builtin/` — 8 tools (read, write, edit, bash, glob, grep, skill_view, agent). All use the `@tool` decorator which auto-coerces dict inputs to Pydantic models and auto-generates JSON Schema.
- `agent/subagent.py` — `AgentTypeSpec` dataclass + `BUILTIN_AGENT_TYPES` (general/explore/plan) + `run_subagent()`. Subagents run in a fresh AgentLoop with filtered tools and pre-allowed permissions. Each type routes via `subagent/<type>` pool.
- `memory/` — File-based persistent memory in `.wings/memory/`. `MEMORY.md` index + per-topic markdown files with YAML frontmatter. 4 types: user/feedback/project/reference. Model uses existing Write/Edit tools to maintain memories.
- `hooks/` — Shell-command lifecycle hooks. `PreToolUse` (can block/allow tools), `PostToolUse` (advisory). Configured via `config.json` `hooks` field. Plugs into `PermissionPipeline` Stage 3.
- `mcp/` — MCP (Model Context Protocol) integration via stdio transport. Tools named `mcp__<server>__<tool>`. Configured via `config.json` `mcp_servers` field.
- `permissions/` — 5-stage pipeline: tool-level rules → scoped rules (prefix matching) → auto-classify (read-only → allow) → hooks → interactive prompt. Scoped rules (`Bash(git commit:*)`) match command prefixes or directory paths, never entire tools.
- `models/anthropic.py` — Adaptive thinking (no budget_tokens) + max_tokens escalation (8K → 64K on stop_reason=max_tokens). Streams buffer all events first to check stop_reason before yielding.
- `skills/` — Skills are SKILL.md files (YAML frontmatter + markdown body). Three layers: builtin < `~/.wings/skills/` < `.wings/skills/`. Each skill auto-forks an independent API pool (`skill/<name>`).
- `messages/types.py` — `StreamEvent` union includes `PermissionRequest`, `ToolUseBlock`, `ToolResultBlock` for the event pipeline. `ToolResultBlock` doubles as message content and stream event.

**Configuration** (single schema, two files):
- `~/.wings/config.json` — global defaults (providers, routing, personality, theme)
- `.wings/config.json` — project overrides, deep-merged on top of global
- `GlobalSettings.load()` does global + project merge in one call via `_deep_merge()`

**Provider config fields**: `model`, `protocol` ("anthropic"|"openai"), `api_key`, `base_url` (required), `max_tokens` (8000), `escalated_max_tokens` (64000), `thinking` (true), `adaptive_thinking` (true), `thinking_budget` (None).

## Key patterns

- **Protocol-driven boundaries**: `ModelSelector`, `ModelProvider`, `Tool`, `HookRunner` are all `typing.Protocol`. AgentLoop depends on `ModelSelector`, not `APIPoolManager`.
- **Tool result grouping**: Anthropic requires all tool_results for one assistant response in a single user message. AgentLoop collects all results into one `Message(role=USER, content=[...all results...])`.
- **Stale detection**: write/edit require prior read. `ToolContext.read_cache` tracks `{path: mtime}`. Read tool populates it, write/edit check it.
- **Permission sync**: AgentLoop yields `PermissionRequest`, awaits `asyncio.Event`. CLI renders prompt_toolkit Application, calls `loop.set_permission_response()`.
- **Scope suggestions**: `suggest_scope()` extracts command prefix for bash (`git commit:*`), directory for write/edit (`/home/user/project/*`).

## Design docs

- `docs/design/status.md` — current project status, module completion, known issues, next steps
- `docs/design/architecture.md` — full architecture with agent loop diagram
- `docs/design/modules.md` — detailed module specs, implementation history, design reflections
- `docs/design/tool-comparison.md` — read/write/edit/bash/glob/grep compared across claude-code and opensquilla
- `docs/reference/claude-code/subagent.md` — claude-code subagent system design
- `docs/reference/opensquilla/subagent.md` — opensquilla subagent system design
- `docs/reference/opensquilla/skills-list.md` — ~70 bundled skills
- `docs/reference/opensquilla/dream.md` — memory consolidation system
- `docs/reference/claude-code/skills-list.md` — ~18 bundled skills
