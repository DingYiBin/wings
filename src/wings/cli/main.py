"""Wings CLI entry point."""

import asyncio
import contextlib
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import typer

from prompt_toolkit import PromptSession
from prompt_toolkit.key_binding import KeyBindings

from wings.cli.bootstrap import create_session, make_agent_context
from wings.cli.logging import TurnLogger
from wings.messages.types import (
    PermissionRequest,
    SubAgentDelta,
    SubAgentEnd,
    SubAgentStart,
    TextDelta,
    ToolResultBlock,
    ToolUseBlock,
)

app = typer.Typer(
    name="wings",
    help="Multi-model AI agent system — each model is a wing.",
    no_args_is_help=True,
)


def version_callback(value: bool) -> None:
    if value:
        typer.echo("wings 0.1.0")
        raise typer.Exit()


@app.callback()
def main(
    version: bool = typer.Option(
        False,
        "--version", "-v",
        help="Show version and exit",
        callback=version_callback,
    ),
    working_dir: Path = typer.Option(
        Path.cwd(), "--dir", "-d",
        help="Working directory",
    ),
    model: str | None = typer.Option(
        None, "--model", "-m",
        help="Model to use (overrides pool selection)",
    ),
) -> None:
    """Wings — each model is a wing."""
    # Store in context for subcommands
    pass


@app.command()
def run(
    prompt: str = typer.Argument(help="The task for the agent to perform"),
    working_dir: Path = typer.Option(
        Path.cwd(), "--dir", "-d",
        help="Working directory",
    ),
    model: str | None = typer.Option(
        None, "--model", "-m",
        help="Model override",
    ),
    log: bool = typer.Option(
        False, "--log",
        help="Log request/response to .wings.log/",
    ),
) -> None:
    """Run a single-turn agent request."""
    asyncio.run(_run_single(prompt, working_dir, model, log))


@app.command()
def chat(
    working_dir: Path = typer.Option(
        Path.cwd(), "--dir", "-d",
        help="Working directory",
    ),
    model: str | None = typer.Option(
        None, "--model", "-m",
        help="Model override",
    ),
    log: bool = typer.Option(
        False, "--log",
        help="Log request/response to .wings.log/",
    ),
) -> None:
    """Start an interactive chat session."""
    asyncio.run(_run_chat(working_dir, model, log))


# -- Implementation -----------------------------------------------------------

# ANSI escape sequences
_CLEAR_LINE = "\033[2K\r"

# Per-turn store of truncated tool results for ctrl+o expansion.
# Each entry is (label, full_content).
_truncated_results: list[tuple[str, str]] = []


def _expand_last_result() -> None:
    """Open the most recent truncated tool result in $PAGER (default: less)."""
    if not _truncated_results:
        return
    label, content = _truncated_results[-1]
    pager = os.environ.get("PAGER", "less -R")
    fd, path = tempfile.mkstemp(suffix=".txt", prefix="wings-tool-")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(f"# {label}\n\n")
            f.write(content)
        subprocess.call([*pager.split(), path])
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


async def _spinner_task(start: float) -> None:
    """Update the spinner line every second until cancelled."""
    try:
        while True:
            elapsed = int(time.monotonic() - start)
            sys.stderr.write(f"{_CLEAR_LINE}Working... ({elapsed}s)")
            sys.stderr.flush()
            await asyncio.sleep(1)
    except asyncio.CancelledError:
        pass


async def _wrap_stream(stream):
    """Wrap an async iterator with a spinner. Yields events, clears spinner on first text."""
    started = False
    spinner = None
    try:
        async for event in stream:
            if not started:
                spinner = asyncio.create_task(_spinner_task(time.monotonic()))
                started = True
                # Yield control so the spinner task can start running
                await asyncio.sleep(0)
            if isinstance(event, (TextDelta, ToolUseBlock, SubAgentStart, SubAgentDelta)) and spinner is not None:
                spinner.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await spinner
                spinner = None
                sys.stderr.write(_CLEAR_LINE)
                # Move to a clean line so stdout text starts fresh
                sys.stderr.write("\n")
                sys.stderr.flush()
            yield event
    finally:
        if spinner is not None:
            spinner.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await spinner
            sys.stderr.write(f"{_CLEAR_LINE}\n")
            sys.stderr.flush()


def _ctx_kwargs(config, working_dir, model, loop):
    """Build kwargs for make_agent_context from session state."""
    return dict(
        config=config,
        working_dir=working_dir,
        model_override=model,
        skills=getattr(loop, "skills_list", None),
        available_skills=getattr(loop, "available_skills", None),
    )


async def _handle_permission(event: PermissionRequest, loop) -> None:
    """Display an inline permission prompt matching claude-code's format.

    Arrow keys / j,k navigate, Enter selects, Esc / n cancels, y confirms.
    """
    from prompt_toolkit.application import Application
    from prompt_toolkit.key_binding import KeyBindings
    from prompt_toolkit.layout import Layout, HSplit, Window
    from prompt_toolkit.layout.controls import FormattedTextControl
    from prompt_toolkit.styles import Style

    input_str = str(event.tool_input)
    if len(input_str) > 100:
        input_str = input_str[:100] + "..."

    # Build scoped "always allow" label
    if event.scope:
        always_label = f"2. Yes, and don't ask again for {event.tool_name}({event.scope})"
    else:
        always_label = f"2. Yes, and don't ask again for {event.tool_name}"

    options = [
        ("allow", "1. Yes"),
        ("allow_always", always_label),
        ("deny", "3. No, tell wings what to do differently"),
    ]
    selected = [0]

    def _render():
        lines = [
            ("class:border", f"  \u250c {event.tool_name} "),
            ("class:border", "\u2500" * (70 - len(event.tool_name) - 5)),
            ("class:border", "\u2510"),
            ("", "\n"),
            ("class:dim", f"   {input_str}"),
            ("", "\n\n"),
        ]
        for i, (_, label) in enumerate(options):
            if i == selected[0]:
                lines.append(("class:pointer", f"  \u276f {label}\n"))
            else:
                lines.append(("class:dim", f"    {label}\n"))
        lines.append(("", "\n"))
        lines.append(("class:footer", "  Esc to cancel"))
        return lines

    kb = KeyBindings()

    @kb.add("up")
    @kb.add("k")
    def _up(event):
        selected[0] = (selected[0] - 1) % len(options)

    @kb.add("down")
    @kb.add("j")
    def _down(event):
        selected[0] = (selected[0] + 1) % len(options)

    @kb.add("enter")
    def _enter(event):
        event.app.exit(result=options[selected[0]][0])

    @kb.add("y")
    def _yes(event):
        event.app.exit(result="allow")

    @kb.add("n")
    @kb.add("escape")
    @kb.add("c-c")
    def _no(event):
        event.app.exit(result="deny")

    app = Application(
        layout=Layout(HSplit([
            Window(FormattedTextControl(_render), height=len(options) + 5),
        ])),
        key_bindings=kb,
        style=Style.from_dict({
            "pointer": "bold",
            "border": "",
            "dim": "fg:#888888",
            "footer": "fg:#888888",
        }),
        erase_when_done=True,
    )

    typer.echo()
    answer = await app.run_async()
    loop.set_permission_response(answer)


def _display_tool_event(event) -> None:
    """Format a tool call or result for terminal display.

    Tool results are capped at 3 lines by default. Full content is stored
    in _truncated_results for ctrl+o expansion in chat mode.
    """
    global _truncated_results

    if isinstance(event, SubAgentStart):
        typer.echo(f"\n  \u256d\u2500 Agent({event.agent_type}) \u2500 {event.description}")
    elif isinstance(event, SubAgentDelta):
        typer.echo(f"  \u2502  {event.text}", nl=False)
        sys.stdout.flush()
    elif isinstance(event, SubAgentEnd):
        typer.echo(f"  \u2570\u2500 Agent({event.agent_type}) done")
    elif isinstance(event, ToolUseBlock):
        label = _tool_label(event.name, event.input)
        typer.echo(f"  \u25cf {label}")
    elif isinstance(event, ToolResultBlock):
        text = event.content.strip()
        if not text:
            typer.echo("    \u23bf (No output)")
            return

        lines = text.split("\n")
        first = lines[0].strip()
        if len(first) > 120:
            first = first[:120] + "..."
        if len(lines) > 1:
            _truncated_results.append(("Tool result", text))
            typer.echo(f"    \u23bf {first}  \u2026 +{len(lines) - 1} lines (ctrl+o)")
        else:
            typer.echo(f"    \u23bf {first}")


def _tool_label(name: str, input: dict) -> str:
    """Build a human-readable label for a tool call.

    Uses claude-code-style names: Update for edit, Write for write.
    """
    human_name = {"edit": "Update", "write": "Write", "read": "Read",
                   "bash": "Bash", "glob": "Glob", "grep": "Grep",
                   "skill_view": "SkillView", "agent": "Agent"}.get(name, name)

    path = input.get("file_path", "")
    if path:
        return f"{human_name}({path})"
    command = input.get("command", "")
    if command:
        if len(command) > 120:
            command = command[:120] + "..."
        return f"{human_name}({command})"
    pattern = input.get("pattern", "")
    if pattern:
        return f"{human_name}({pattern})"
    # Agent tool: show description and type
    if name == "agent":
        desc = input.get("description", "")
        atype = input.get("subagent_type", "general")
        return f"{human_name}({atype}) \u2014 {desc}"
    # Fallback: show first key-value pair
    if input:
        key, val = next(iter(input.items()))
        val_str = str(val)
        if len(val_str) > 80:
            val_str = val_str[:80] + "..."
        return f"{human_name}({key}={val_str})"
    return f"{human_name}()"


async def _run_single(prompt: str, working_dir: Path, model: str | None, log: bool) -> None:
    """Execute a single-turn agent request."""
    global _truncated_results
    try:
        loop, config = create_session(working_dir)
        if log:
            logger = TurnLogger(working_dir)
            loop.set_logger(logger)
            typer.echo(f"  Logging to {logger.path}")
        ctx = make_agent_context(**_ctx_kwargs(config, working_dir, model, loop))
    except Exception as e:
        typer.echo(f"Error: failed to initialize session: {e}", err=True)
        raise typer.Exit(code=1)

    _truncated_results = []
    try:
        async for event in _wrap_stream(loop.run(prompt, ctx)):
            if isinstance(event, TextDelta):
                typer.echo(event.text, nl=False)
                sys.stdout.flush()
            elif isinstance(event, PermissionRequest):
                await _handle_permission(event, loop)
            else:
                _display_tool_event(event)
        nickname = loop.last_model.split("/")[0] if loop.last_model else ""
        typer.echo(f"\n  [{nickname}]")
    except Exception as e:
        typer.echo(f"\nError: {e}", err=True)
        raise typer.Exit(code=1)


def _make_chat_keybindings() -> KeyBindings:
    """Create keybindings for the chat prompt, including ctrl+o expansion."""
    kb = KeyBindings()

    @kb.add("c-o")
    def _expand(_event):
        _expand_last_result()

    return kb


async def _run_chat(working_dir: Path, model: str | None, log: bool) -> None:
    """Interactive chat loop."""
    global _truncated_results
    try:
        loop, config = create_session(working_dir)
        if log:
            logger = TurnLogger(working_dir)
            loop.set_logger(logger)
            typer.echo(f"  Logging to {logger.path}")
    except Exception as e:
        typer.echo(f"Error: failed to initialize session: {e}", err=True)
        raise typer.Exit(code=1)

    typer.echo("Wings chat — type /help for commands, /exit to quit.")
    session = PromptSession(
        "> ",
        key_bindings=_make_chat_keybindings(),
        enable_history_search=False,
    )

    while True:
        try:
            user_input = (await session.prompt_async()).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if user_input.strip() == "":
            continue

        # -- Slash commands --
        if user_input.startswith("/"):
            parts = user_input[1:].split(maxsplit=1)
            cmd = parts[0].strip()
            args = parts[1].strip() if len(parts) > 1 else ""

            if cmd == "exit":
                break

            if cmd == "help":
                _show_help(loop)
                continue

            # Look up skill
            loader = getattr(loop, "skill_loader", None)
            skill = loader.get_by_name(cmd) if loader else None
            if skill is not None:
                skill_prompt = (
                    f"[Skill: {skill.name}]\n\n{skill.content}\n\n"
                    f"---\n\nUser request: {args or 'Run this skill'}"
                )
                ctx = make_agent_context(
                    **_ctx_kwargs(config, working_dir, model, loop),
                    task_type=f"skill/{skill.name}",
                )
                user_input = skill_prompt
            else:
                typer.echo(f"Unknown command or skill: /{cmd}")
                continue
        else:
            ctx = make_agent_context(**_ctx_kwargs(config, working_dir, model, loop))

        _truncated_results = []
        try:
            async for event in _wrap_stream(loop.run(user_input, ctx)):
                if isinstance(event, TextDelta):
                    typer.echo(event.text, nl=False)
                    sys.stdout.flush()
                elif isinstance(event, PermissionRequest):
                    await _handle_permission(event, loop)
                else:
                    _display_tool_event(event)
            nickname = loop.last_model.split("/")[0] if loop.last_model else ""
            typer.echo(f"\n  [{nickname}]")
        except Exception as e:
            typer.echo(f"\nError: {e}", err=True)


def _show_help(loop) -> None:
    """Display available slash commands and skills."""
    typer.echo("\nCommands:")
    typer.echo("  /exit          Quit the chat session")
    typer.echo("  /help          Show this help")
    typer.echo("  ctrl+o         Expand last truncated tool result")

    loader = getattr(loop, "skill_loader", None)
    if loader is not None:
        skills = loader.list_user_invocable()
        if skills:
            typer.echo("\nSkills:")
            for s in skills:
                typer.echo(f"  /{s.name:<15} {s.description}")
    typer.echo()
