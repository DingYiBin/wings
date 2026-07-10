# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Essential commands

```bash
# TypeScript (primary) — install + test
npm install                    # install dependencies
bun test                       # run all tests (228 passing)
bun test tests/ts/tools.test.ts  # single test file
bun x tsc --noEmit             # type-check

# Run (Node.js)
node --import tsx src/index.ts chat              # interactive REPL
node --import tsx src/index.ts run "prompt"      # single turn
node --import tsx src/index.ts chat -m anthropic/claude-sonnet-4-6
node --import tsx src/index.ts chat --continue     # resume last session
node --import tsx src/index.ts chat --resume <hash> # resume by hash

# Python (legacy)
uv sync --extra dev
uv run pytest tests/ -q
uv run ruff check src/ tests/
uv run mypy src/

# Chat commands
/pool                        # view and adjust API candidate pools
/pool up|down <api>          # adjust score by ±0.5
```

## Architecture

Wings is a **multi-model AI agent** where every API call independently selects a model from a task-type-specific candidate pool via softmax-weighted random selection.

**Module dependency chain**: `messages`/`routing` → `models` → `tools` → `query`/`permissions` → `agent` → `config`/`skills`/`memory`/`hooks`/`mcp` → `cli`.

**Key modules**:

- `routing/` — `APIPoolManager` (global pool + per-task-type score masks, softmax selection). Implements `ModelSelector` interface.
- `agent/loop.ts` — `AgentLoop.run()` async generator. Model selection per API call. Permission sync via Promise resolver. Handoff detection on first cycle only. Abort polling at 250ms.
- `tools/builtin/` — 10 tools (read/write/edit/bash/glob/grep/skill_view/agent/web_fetch/web_search). `buildTool()` factory with Zod schemas.
- `agent/subagent.ts` — 3 built-in types (general/explore/plan) + custom agent loader from `.wings/agents/*.md`.
- `services/session-memory.ts` — Per-conversation structured notes (summary.md). Extracted via subagent after each turn. Used by compaction.
- `memory/` — File-based MEMORY.md index + per-topic files with YAML frontmatter. Auto-extraction every 5 turns.
- `hooks/` — Shell-command lifecycle hooks (PreToolUse/PostToolUse). Matcher regex, JSON stdin protocol, parallel execution.
- `permissions/` — 4-stage pipeline: static rules → scoped → auto-classify read-only → hooks → interactive. Arrow-key navigable permission dialog via /dev/tty.
- `query/` — `QueryEngine` with exponential backoff retry, `TokenBudget` for compaction decisions.
- `models/` — Anthropic + OpenAI adapters. Streaming with max_tokens escalation (8K→64K). Thinking block preservation.
- `skills/` — 3-layer SKILL.md discovery (builtin < user < project). SkillInjector for system prompt.
- `cli/` — Ink v7 (3rdparty/ink submodule) React terminal UI. Messages + divider + PromptInput + StatusBar layout. Contextual status bar, throttled text display, ESC/Ctrl+C interrupt, shared abort flag with subagents.

**Configuration** (single schema, two files):
- `~/.wings/config.json` — global defaults
- `.wings/config.json` — project overrides, deep-merged

**Provider config fields**: `model`, `protocol`, `api_key`, `base_url`, `max_tokens` (8000), `escalated_max_tokens` (64000), `thinking` (true), `thinking_budget` (null).

## Key patterns

- **Interface-driven boundaries**: `ModelSelector`, `ModelProvider`, `Tool`, `HookRunner` are TypeScript interfaces.
- **Tool result grouping**: All tool_results for one assistant response collected into a single user message.
- **Stale detection**: write/edit require prior read. `ToolContext.read_cache` tracks `{path: mtime}`.
- **Permission sync**: AgentLoop yields `PermissionRequest`, awaits Promise. `_permResolve` set BEFORE yield to prevent deadlock.
- **Scope suggestions**: `suggest_scope()` extracts command prefix for bash, directory for write/edit.
- **Shared abort flag**: `globalThis.__abortFlag` shared between main loop and subagents for ESC/Ctrl+C propagation.

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
