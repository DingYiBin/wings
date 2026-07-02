# Wings

A multi-model agent system — connect to multiple model APIs and let their capabilities complement each other. Each model is a wing.

## Design Principles

**Default to random**. Don't guess which model suits the task — be honest that "we don't know which is best". Pick a random available model each turn. Users discover model strengths through actual usage. When precise control is needed, use `/model`.

**Everything is a tool**. File I/O, shell execution, search, sub-agent delegation — all implement the same `Tool` protocol and pass through the same permission pipeline.

**Skill = Command**. What users type as `/xxx` in the REPL and what the model invokes via SkillTool are the same thing, just triggered differently.

## Tech Stack

- **Runtime**: Python 3.12+
- **Validation**: Pydantic v2
- **CLI**: Typer + Rich
- **Package manager**: uv

## References

| Project | Language | Key takeaways |
|---------|----------|---------------|
| [claude-code](https://github.com/anthropics/claude-code) | TypeScript | Tool/Command interface, permission pipeline, two-tier state, Skill-Command unification |
| [opensquilla](https://github.com/opensquilla/opensquilla) | Python | Protocol-driven DI, StageOutcome, TurnRunner stage decomposition, Memory/Dream system |

Design docs in [`docs/design/`](docs/design/). Reference architecture analysis in [`docs/reference/`](docs/reference/).

## Project Structure

```
src/wings/
├── agent/          # Agent core loop
├── cli/            # CLI entry + REPL
├── config/         # Configuration system
├── context/        # System prompt + environment info
├── hooks/          # Lifecycle hooks
├── memory/         # Persistent memory
├── messages/       # Message types + cross-model conversion
├── models/         # Model adapters (each wing)
├── permissions/    # Permission pipeline
├── plugins/        # Plugin system
├── query/          # Query engine
├── services/       # External services (API, MCP)
├── skills/         # Reusable skills (also Commands)
└── tools/          # Tool system
```

## Implementation Phases

| Phase | Module | Description |
|-------|--------|-------------|
| 1 | messages | ✅ Message types + Anthropic/OpenAI format conversion |
| 2 | models | ModelProvider protocol + API adapters |
| 3 | tools | Tool protocol + registry + built-in tools |
| 4 | query | LLM API calls (retry, fallback) |
| 5 | permissions | Multi-stage permission pipeline |
| 6 | agent | Core loop + sub-agents |
| 7 | config | Global/project configuration |
| 8 | cli | Typer entry point + REPL |
| 9+ | hooks, memory, skills, plugins, MCP | Future iterations |
