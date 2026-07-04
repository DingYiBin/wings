# Wings

A multi-model agent system — connect to multiple model APIs, each task type has its own API candidate pool. Users shape which models serve which tasks through scoring and configuration. Each model is a wing.

## Design Principles

**API candidate pool** — wings' core differentiator. Every model call randomly selects an API from the current task's candidate pool using weighted random selection. Users adjust pools by scoring (upvote/downvote), removing APIs, or forking per-skill pools. New APIs default to all pools; users can restrict them to specific task types.

**Everything is a tool**. File I/O, shell execution, search, sub-agent delegation — all implement the same `Tool` protocol and pass through the same permission pipeline.

**Protocol-driven boundaries**. Modules depend on Protocols, not concrete classes. `ModelSelector`, `ModelProvider`, `Tool`, `HookRunner` — swap implementations without touching callers.

## Current State

9 phases completed, 184 tests, ~3100 lines of code. End-to-end data path is wired: user input → message assembly → pool-based model selection → provider API call → tool execution → response. Ready for basic testing with real API keys.

| Phase | Module | Status | Key files |
|-------|--------|--------|-----------|
| 1 | messages | ✅ | `types.py`, `normalize.py` (Anthropic + OpenAI roundtrip) |
| 1b | routing | ✅ | `manager.py` (API candidate pool, 19 task types) |
| 2 | models | ✅ | `anthropic.py`, `openai.py` (chat + stream adapters) |
| 3 | tools | ✅ | 6 built-in tools: read, write, edit, bash, glob, grep |
| 4 | query | ✅ | `engine.py` (retry with exponential backoff) |
| 5 | permissions | ✅ | 4-stage pipeline: rules → classify → hooks → ask |
| 6a | agent/core | ✅ | `loop.py` (main cycle + handoff detection) |
| 7 | config | ✅ | `settings.py` (TOML + env var layered config) |
| 8 | cli | ✅ | `wings run` / `wings chat` with bootstrap wiring |

## Installation

Requirements: Python 3.12+, [uv](https://docs.astral.sh/uv/)

```bash
git clone https://github.com/opensquilla/wings.git
cd wings
uv pip install -e .
```

Or with dev dependencies:

```bash
uv pip install -e ".[dev]"
```

## Configuration

### API Keys

Create `~/.wings/config.json`:

```json
{
  "providers": {
    "anthropic": {
      "model": "claude-sonnet-4-6",
      "protocol": "anthropic",
      "api_key": "sk-ant-api03-...",
      "base_url": "https://api.anthropic.com"
    },
    "openai": {
      "model": "gpt-4o",
      "protocol": "openai",
      "api_key": "sk-...",
      "base_url": "https://api.openai.com/v1"
    }
  }
}
```

Provider names are arbitrary keys under `"providers"`. Each value requires `model`, `protocol`, `api_key`, and `base_url`. `protocol` determines which adapter is used — `"anthropic"` for Anthropic-compatible APIs (Claude, DeepSeek via Anthropic endpoint, etc.) and `"openai"` for OpenAI-compatible APIs.

API keys can also be set via environment variables (takes priority over config file):

```bash
export WINGS_PROVIDERS__ANTHROPIC__API_KEY="sk-ant-api03-..."
export WINGS_PROVIDERS__OPENAI__API_KEY="sk-..."
```

### API Candidate Pool (optional)

Customize which models serve which task types:

```json
{
  "routing": {
    "default_weight": 1.0,
    "pools": {
      "main": [
        {"api_id": "anthropic/claude-opus-4-6", "weight": 2.0},
        {"api_id": "openai/gpt-4o", "weight": 1.0}
      ],
      "subagent": [
        {"api_id": "anthropic/claude-haiku-4-5", "weight": 3.0},
        {"api_id": "openai/o4-mini", "weight": 1.0}
      ]
    }
  }
}
```

If no pool is configured, all registered APIs participate with equal weight.

### Project Settings

Place a `wings.json` in your project root:

```json
{
  "allowed_tools": ["read", "glob", "grep"],
  "denied_tools": ["rm"],
  "model": "anthropic/claude-opus-4-6",
  "personality": "You are a concise, no-nonsense assistant."
}
```

## Usage

### Single turn

```bash
wings run "What does the README say about this project?"
wings run --model anthropic/claude-opus-4-6 "Explain the architecture"
wings run --dir /path/to/project "List all Python files"
```

### Interactive chat

```bash
wings chat
```

Type `/exit` to quit, Ctrl+C to interrupt.

### Run tests

```bash
pytest tests/ -v
# 184 passed
```

## Architecture

```
src/wings/
├── cli/            # typer entry point + bootstrap wiring
├── agent/          # AgentLoop, HandoffDetector, TurnRecord
├── query/          # QueryEngine (retry) + TokenBudget
├── tools/          # Tool protocol, registry, 6 built-in tools
├── permissions/    # 4-stage permission pipeline
├── models/         # Anthropic + OpenAI adapters, ModelRegistry, capabilities
├── routing/        # API candidate pool manager + ModelSelector Protocol
├── messages/       # Internal message types + provider format conversion
└── config/         # Layered settings (env > wings.toml > ~/.wings/config.toml)
```

Module dependency order: messages/routing (no deps) → models (messages + routing) → tools (no deps) → query (models + messages + tools) → permissions (tools) → agent (all) → config (routing) → cli (all).

## Design Docs

- [`docs/design/architecture.md`](docs/design/architecture.md) — Architecture overview and design decisions
- [`docs/design/modules.md`](docs/design/modules.md) — Detailed module design + implementation plan + reflections
- [`docs/reference/`](docs/reference/) — Analysis of claude-code and opensquilla codebases

## References

| Project | Language | Reference points |
|---------|----------|------------------|
| [claude-code](https://github.com/anthropics/claude-code) | TypeScript | Tool/Command interface, permission pipeline, agent types |
| [opensquilla](https://github.com/opensquilla/opensquilla) | Python | Protocol-driven DI, StageOutcome, @tool decorator, Dream system |
