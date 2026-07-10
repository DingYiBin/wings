# Wings

A multi-model AI agent CLI. Every model call randomly selects an API from a task-type-specific candidate pool using softmax-weighted random selection. Users shape which models serve which tasks through scoring — each model is a wing.

Built with TypeScript, runs on Node.js, tests on Bun.

Design Principles — [API candidate pool] • [Everything is a tool] • [Protocol-driven boundaries]
See [`docs/design/architecture.md`](docs/design/architecture.md) for the full architecture overview.

## Installation

Requirements: Node.js 22+, npm

```bash
git clone https://github.com/DingYiBin/wings.git
cd wings
npm install
```

Tests use Bun (faster test runner):
```bash
bun test                    # 228 tests
bun x tsc --noEmit          # type-check
```

## Configuration

Same schema as the Python version. Two files, deep-merged:

### Global (`~/.wings/config.json`)

```json
{
  "providers": {
    "anthropic": {
      "model": "claude-sonnet-4-6",
      "protocol": "anthropic",
      "api_key": "sk-ant-...",
      "base_url": "https://api.anthropic.com"
    }
  }
}
```

Provider fields: `model`, `protocol` ("anthropic" or "openai"), `api_key`, `base_url` (required), `max_tokens` (8000), `escalated_max_tokens` (64000), `thinking` (true), `thinking_budget` (null).

API keys via environment (takes priority):

```bash
export WINGS_PROVIDERS__ANTHROPIC__API_KEY="sk-ant-..."
```

### Project (`.wings/config.json`)

Overrides global settings for the current project:

```json
{
  "personality": "You are a concise, no-nonsense assistant.",
  "allowed_tools": ["read", "glob", "grep"],
  "denied_tools": []
}
```

### API Candidate Pool (optional)

```json
{
  "routing": {
    "version": 2,
    "apis": [
      {"api_id": "anthropic/claude-sonnet-4-6", "score": 0},
      {"api_id": "anthropic/claude-haiku-4-5", "score": -2}
    ],
    "masks": {
      "main": {"anthropic/claude-opus-4-6": 2.0},
      "subagent": {"anthropic/claude-haiku-4-5": 1.0}
    }
  }
}
```

### Skills

SKILL.md files (YAML frontmatter + markdown body):
- `.wings/skills/<name>/SKILL.md` (project)
- `~/.wings/skills/<name>/SKILL.md` (user)

### Custom Agents

`.wings/agents/*.md` files (same SKILL.md format) define custom subagent types.

## Usage

```bash
# Interactive chat
node --import tsx src/index.ts chat

# Single turn
node --import tsx src/index.ts run "What does this project do?"

# Model override
node --import tsx src/index.ts chat -m anthropic/claude-opus-4-6
```

### Chat Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/pool` | View API candidate pool scores |
| `/pool up <api>` | Increase an API's score by 0.5 |
| `/pool down <api>` | Decrease an API's score by 0.5 |
| Ctrl+C | Exit |

### Permission Prompt

When a tool needs approval, an arrow-key navigable dialog appears:
- `↑`/`↓` or `j`/`k` — move cursor
- `Enter` — select highlighted option
- `y` — allow, `n`/`Esc` — deny


## Architecture

```
src/
├── index.ts              # CLI entry point
├── cli/                  # REPL (raw mode + readline), bootstrap wiring
│   ├── main.ts           # chat + run commands, permission dialog
│   ├── bootstrap.ts      # Dependency injection (composition root)
│   └── ink-app.tsx        # Ink/React REPL (future)
├── agent/                # AgentLoop (per-call model selection), HandoffDetector
│   ├── loop.ts           # Main conversation loop with async generator
│   ├── subagent.ts       # 3 built-in + custom agent types, runSubagent
│   ├── handoff.ts        # Model handoff detection between turns
│   └── agent_loader.ts   # Custom agent discovery from .wings/agents/
├── query/                # QueryEngine (retry with exponential backoff), TokenBudget
├── tools/                # buildTool() + Zod, 9 built-in tools
│   └── builtin/          # read/write/edit/bash/glob/grep/skill_view/agent/web_fetch/web_search
├── permissions/          # 4-stage pipeline: rules → scoped → classify → hooks → ask
├── models/               # Anthropic + OpenAI adapters (streaming, max_tokens escalation)
├── routing/              # APIPoolManager (softmax selection), ModelSelector Protocol
├── messages/             # Internal types + Anthropic/OpenAI format conversion
├── config/               # 2-file JSON deep merge (global + project)
├── skills/               # SkillLoader (3-layer), SkillInjector
├── memory/               # MEMORY.md index + per-topic files, auto-extraction
├── hooks/                # Shell command lifecycle hooks (PreToolUse/PostToolUse)
├── mcp/                  # MCP client (@modelcontextprotocol/sdk stdio transport)
└── services/             # Compaction, Session Memory
```

Module dependency order: messages/routing → models → tools → query → permissions → agent → config/skills/memory/hooks/mcp → cli.

## Development

```bash
# Tests (Bun)
bun test                          # all 228 tests
bun test tests/ts/agent.test.ts   # single file

# Type-check
bun x tsc --noEmit

# Run
node --import tsx src/index.ts chat
```

## Design Docs

- [`docs/design/architecture.md`](docs/design/architecture.md) — Architecture overview and agent loop
- [`docs/design/modules.md`](docs/design/modules.md) — Detailed module specs + implementation history
- [`docs/design/ts-rewrite-plan.md`](docs/design/ts-rewrite-plan.md) — Python → TypeScript rewrite plan
- [`docs/design/tool-comparison.md`](docs/design/tool-comparison.md) — Tool comparison across implementations
- [`docs/reference/`](docs/reference/) — Analysis of claude-code and opensquilla
