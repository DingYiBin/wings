# Wings

A multi-model AI agent system. Every model call randomly selects an API from a task-type-specific candidate pool using softmax-weighted random selection. Users shape which models serve which tasks through scoring — each model is a wing.

## Design Principles

**API candidate pool** — wings' core differentiator. Every model call (including tool-use cycles within a turn) independently selects from the current task's candidate pool. Users adjust pools by scoring (upvote/downvote), removing APIs, or forking per-skill pools. Selection uses softmax over effective scores.

**Everything is a tool**. File I/O, shell execution, search, skills — all implement the same `Tool` protocol and pass through the same permission pipeline with fine-grained scoped rules.

**Protocol-driven boundaries**. Modules depend on Protocols, not concrete classes. `ModelSelector`, `ModelProvider`, `Tool`, `HookRunner` — swap implementations without touching callers.

## Installation

Requirements: Python 3.12+, [uv](https://docs.astral.sh/uv/)

```bash
git clone https://github.com/opensquilla/wings.git
cd wings
uv sync --extra dev
```

## Configuration

### Global (`~/.wings/config.json`)

```json
{
  "providers": {
    "dpsk-flash": {
      "model": "deepseek-v4-flash",
      "protocol": "anthropic",
      "api_key": "sk-...",
      "base_url": "https://api.deepseek.com/v1/"
    }
  }
}
```

Provider fields: `model`, `protocol` ("anthropic" or "openai"), `api_key`, `base_url` (required), `max_tokens` (8000), `escalated_max_tokens` (64000), `thinking` (true), `adaptive_thinking` (true), `thinking_budget` (null).

API keys can also be set via environment variables (takes priority):

```bash
export WINGS_PROVIDERS__DPSK_FLASH__API_KEY="sk-..."
```

### Project (`.wings/config.json`)

Overrides global settings for the current project. Deep-merged on top of global config:

```json
{
  "personality": "You are a concise, no-nonsense assistant.",
  "allowed_tools": ["read", "glob", "grep"],
  "denied_tools": []
}
```

### Skills

Skills are SKILL.md files (YAML frontmatter + markdown body). Place them in:
- `.wings/skills/<name>/SKILL.md` (project)
- `~/.wings/skills/<name>/SKILL.md` (user)

Three built-in skills ship with wings: `commit`, `review-pr`, `simplify`.

### API Candidate Pool (optional)

Customize which models serve which task types by adjusting scores:

```json
{
  "routing": {
    "version": 2,
    "masks": {
      "main": {"dpsk-pro/deepseek-v4-pro": 2.0},
      "subagent": {"dpsk-flash/deepseek-v4-flash": 3.0}
    }
  }
}
```

## Usage

```bash
# Interactive chat with slash commands and permission dialogs
wings chat
wings chat --log          # with session logging to .wings/logs/

# Single turn
wings run "What does this project do?"
wings run --model dpsk-pro/deepseek-v4-pro "Explain the architecture"
```

## Development

```bash
uv sync --extra dev                 # install with dev deps
uv run pytest tests/ -q             # 200 tests
uv run pytest tests/test_tools.py -v  # single file
uv run ruff check src/ tests/       # lint
uv run mypy src/                    # type-check
bash scripts/init-references.sh     # clone reference repos
```

## Architecture

```
src/wings/
├── cli/            # typer entry point (chat + run), bootstrap wiring, logging
├── agent/          # AgentLoop (per-call model selection, permission sync), HandoffDetector
├── query/          # QueryEngine (retry with backoff), TokenBudget
├── tools/          # Tool protocol, @tool decorator, 7 built-in tools
├── permissions/    # 5-stage pipeline (rules → scoped → classify → hooks → ask)
├── models/         # Anthropic + OpenAI adapters (adaptive thinking, escalation)
├── routing/        # API pool manager (softmax selection), ModelSelector Protocol
├── messages/       # Internal types + Anthropic/OpenAI format conversion
├── skills/         # SkillLoader (3-layer), SkillInjector, 3 built-in skills
└── config/         # GlobalSettings (.wings/config.json merge)
```

Module dependency order: messages/routing → models → tools → query → permissions → agent → config/skills → cli.

## Design Docs

- [`docs/design/architecture.md`](docs/design/architecture.md) — Architecture overview and agent loop
- [`docs/design/modules.md`](docs/design/modules.md) — Detailed module specs + implementation history + reflections
- [`docs/design/tool-comparison.md`](docs/design/tool-comparison.md) — Tool comparison: wings vs claude-code vs opensquilla
- [`docs/reference/`](docs/reference/) — Analysis of claude-code and opensquilla

## References

| Project | Language | Reference points |
|---------|----------|------------------|
| [claude-code](https://github.com/anthropics/claude-code) | TypeScript | Tool interface, permission pipeline, agent types, display format |
| [opensquilla](https://github.com/opensquilla/opensquilla) | Python | Protocol-driven DI, @tool decorator, Dream memory consolidation |
